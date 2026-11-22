import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { dropAcceptanceNodes } from '../test/acceptanceNodes'
import { issued, seedEpic } from '../test/execution'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { bindForge, FORGE_POINTER, withForgeTransfer } from './repo/forgeBinding'
import { createGitAdapter } from './repo/git'
import { requestSave } from './services/plans'
import { pngBytes } from '../test/images'
import { ownedPaths } from './repo/paths'
import { resolveLayout } from './repo/layout'

let h: Harness
beforeEach(() => { h = createHarness() })
afterEach(() => h.cleanup())

async function activeProject(mode: 'repo' | 'db') {
  const source = h.open('desktop', { transport: 'desktop', mode })
  await source.initializeRepository({ name: 'Force migration fixture' })
  const epic = await source.createEpic({ title: 'Restart every ticket' })
  await dropAcceptanceNodes(source, epic.id)
  const draft = await source.updatePlanDraft({ epicId: epic.id, ops: [
    { op: 'add_ticket', ref: 'first', sprint: '1', ticket: { title: 'Already accepted' } },
    { op: 'add_ticket', ref: 'next', sprint: '1', ticket: { title: 'Claim still live' } },
    { op: 'add_dependency', from: 'first', to: 'next' }
  ] })
  await source.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  const agent = h.open('orchestrator')
  const run = await agent.startRun({ epicId: epic.id })
  const accepted = issued(await agent.claimTicket({ runId: run.id, ticketId: draft.refMap.first!, worker: { label: 'Accepted worker' } }))
  await agent.submitAttempt({ attemptId: accepted.attempt.id, claimToken: accepted.packet.claimToken, outputs: { summary: 'Historical accepted work' } })
  await agent.acceptAttempt({ attemptId: accepted.attempt.id })
  const claimed = issued(await agent.claimTicket({ runId: run.id, ticketId: draft.refMap.next!, worker: { label: 'Old worker' } }))
  const card = await source.createKanbanCard({ title: 'Restart unfinished card' })
  await source.playKanbanCard({ cardId: card.id })
  const cardClaim = await agent.claimKanbanCard({ cardId: card.id })
  const member = join(h.homeDir, 'Forge', 'Project')
  mkdirSync(member, { recursive: true })
  return { source, agent, epic, run, accepted, claimed, card, cardClaim, member, first: draft.refMap.first! }
}

it.each(['repo', 'db'] as const)('force exports a %s project with old accepted history but restarts readiness from the first ticket', async mode => {
  const f = await activeProject(mode)
  const before = await f.source.getRun({ runId: f.run.id })
  await withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))
  expect(await f.source.getRun({ runId: f.run.id })).toEqual(before)
  const dest = h.open('orchestrator', { root: f.member, git: createGitAdapter(f.member) })
  expect((await dest.reconcileRepository()).rejected).toEqual([])
  expect(await dest.getRun({ runId: f.run.id })).toMatchObject({ state: 'canceled', attempts: expect.arrayContaining([
    expect.objectContaining({ id: f.accepted.attempt.id, state: 'accepted' }),
    expect.objectContaining({ id: f.claimed.attempt.id, state: 'canceled' })
  ]) })
  expect((await dest.getEpic({ epicId: f.epic.id })).status).toBe('backlog')
  const restarted = await dest.startRun({ epicId: f.epic.id })
  expect(restarted.id).not.toBe(f.run.id)
  expect(restarted.activeSprintOrdinal).toBe(1)
  expect((await dest.getReadyTickets({ runId: restarted.id })).ready.map(t => t.ticketId)).toEqual([f.first])
  const card = await dest.getKanbanCard({ cardId: f.card.id })
  expect(card.lane).toBe('backlog')
  expect(card.attempts).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.cardClaim.attemptId, state: 'failed' })]))
  expect(card.playPending).toBe(false)
  await expect(dest.heartbeatKanbanCard({ attemptId: f.cardClaim.attemptId, claimToken: f.cardClaim.claimToken! })).rejects.toMatchObject({ code: 'stale_claim' })
  await expect(dest.heartbeatAttempt({ attemptId: f.claimed.attempt.id, claimToken: f.claimed.packet.claimToken })).rejects.toMatchObject({ code: 'stale_claim' })
  const note = 'Forge World: https://github.com/test/world.git\nProject folder: Project\n'
  writeFileSync(join(h.root, FORGE_POINTER), note)
  bindForge(h.homeDir, h.root, f.member, note)
  await expect(f.agent.heartbeatAttempt({ attemptId: f.claimed.attempt.id, claimToken: f.claimed.packet.claimToken })).rejects.toThrow('Reconnect')
  rmSync(join(h.root, FORGE_POINTER))
  await expect(f.agent.heartbeatAttempt({ attemptId: f.claimed.attempt.id, claimToken: f.claimed.packet.claimToken })).rejects.toThrow('Reconnect')
})

it.each(['directory', 'definition'])('regenerates a missing canonical card %s from owned database records and preserves failed export evidence', async missing => {
  const f = await activeProject('repo')
  const cardPath = join(h.root, '.darkmechanicus', 'kanban', f.card.id)
  rmSync(missing === 'directory' ? cardPath : join(cardPath, 'card.json'), { recursive: true })
  f.source.ctx().db.run("UPDATE outbox SET state = 'failed', last_error = 'Card record missing' WHERE kind = 'kanban_event'")
  await withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))
  expect(existsSync(join(f.member, '.darkmechanicus', 'kanban', f.card.id, 'card.json'))).toBe(true)
  expect(readFileSync(join(f.member, '.darkmechanicus', 'kanban', f.card.id, 'card.json'), 'utf8')).toContain('Restart unfinished card')
  expect(f.source.ctx().db.get("SELECT 1 FROM outbox WHERE state = 'failed'")).toBeTruthy()
})

it.each(['epic_state', 'run_history'] as const)('reconstructs failed %s output while preserving accepted history and the source failure', async kind => {
  const f = await activeProject('repo')
  const paths = ownedPaths(resolveLayout(h.root))
  const file = kind === 'epic_state' ? paths.epicStateFile(f.epic.id) : paths.runHistoryFile(f.run.id)
  rmSync(file)
  f.source.ctx().db.run("UPDATE outbox SET state = 'failed', last_error = 'Canonical output missing' WHERE kind = ?", kind)
  const failed = f.source.ctx().db.all("SELECT * FROM outbox WHERE state = 'failed'")
  expect(failed.length).toBeGreaterThan(0)
  await withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))
  const dest = h.open('orchestrator', { root: f.member, git: createGitAdapter(f.member) })
  expect((await dest.reconcileRepository()).rejected).toEqual([])
  expect(await dest.getRun({ runId: f.run.id })).toMatchObject({ state: 'canceled', attempts: expect.arrayContaining([expect.objectContaining({ id: f.accepted.attempt.id, state: 'accepted' })]) })
  expect(dest.ctx().db.all("SELECT * FROM outbox WHERE state <> 'done'")).toEqual([])
  expect(f.source.ctx().db.all("SELECT * FROM outbox WHERE state = 'failed'")).toEqual(failed)
  expect(existsSync(file)).toBe(false)
})

it('preserves a pending plan save and draft instead of treating it as a completed canonical export', async () => {
  const f = await activeProject('repo')
  const epic = await f.source.createEpic({ title: 'Pending save must remain pending' })
  await dropAcceptanceNodes(f.source, epic.id)
  const draft = await f.source.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'add_ticket', ref: 'one', sprint: '1', ticket: { title: 'Unsaved work' } }] })
  requestSave(f.source.ctx(), { epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  const db = f.source.ctx().db
  const before = db.all('SELECT * FROM plan_revisions WHERE epic_id = ?', epic.id)
  await expect(withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))).rejects.toThrow('pending plan save')
  expect(db.all('SELECT * FROM plan_revisions WHERE epic_id = ?', epic.id)).toEqual(before)
  expect(db.get('SELECT 1 FROM outbox WHERE kind = ? AND state <> ?', 'snapshot', 'done')).toBeTruthy()
  expect(existsSync(join(f.member, '.darkmechanicus/project.json'))).toBe(false)
})

it('keeps same-clock Play and a new claim after each restart when canonical history is cloned', async () => {
  const f = await activeProject('repo')
  await withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))
  let root = f.member
  for (let cycle = 0; cycle < 2; cycle++) {
    const desktop = h.open('desktop', { root, transport: 'desktop', git: createGitAdapter(root) })
    const agent = h.open('orchestrator', { root, git: createGitAdapter(root) })
    await desktop.playKanbanCard({ cardId: f.card.id })
    const claim = await agent.claimKanbanCard({ cardId: f.card.id })
    expect(claim.claimToken).toBeTruthy()
    const cloned = h.open('orchestrator', { root: h.cloneTracked(root), git: createGitAdapter(root) })
    expect((await cloned.reconcileRepository()).rejected).toEqual([])
    expect(await cloned.getKanbanCard({ cardId: f.card.id })).toMatchObject({ lane: 'in_progress', playPending: false, attempts: expect.arrayContaining([expect.objectContaining({ id: claim.attemptId, state: 'claimed' })]) })
    const next = join(h.homeDir, 'Forge', 'Repeat' + cycle)
    mkdirSync(next)
    await withForgeTransfer(h.homeDir, root, next, async () => desktop.exportForge!(next, 'repo', { force: true }))
    root = next
    const reset = h.open('orchestrator', { root: h.cloneTracked(root), git: createGitAdapter(root) })
    expect((await reset.reconcileRepository()).rejected).toEqual([])
    expect(await reset.getKanbanCard({ cardId: f.card.id })).toMatchObject({ lane: 'backlog', playPending: false })
  }
})

it('fences a review admitted before conversion when its asynchronous verification resumes', async () => {
  const f = await activeProject('repo')
  await f.agent.submitAttempt({ attemptId: f.claimed.attempt.id, claimToken: f.claimed.packet.claimToken, outputs: { summary: 'Awaiting review' } })
  const db = f.agent.ctx().db
  const accepting = f.agent.acceptAttempt({ attemptId: f.claimed.attempt.id })
  await withForgeTransfer(h.homeDir, h.root, f.member, async () => {
    await expect(accepting).rejects.toThrow('conversion is pending')
    expect(db.get<{ state: string }>('SELECT state FROM attempts WHERE id = ?', f.claimed.attempt.id)?.state).toBe('submitted')
    f.source.exportForge!(f.member, 'repo', { force: true })
  })
})

it.each(['paused', 'expired'] as const)('restarts %s work while preserving completed epics and historical rows', async state => {
  const f = await activeProject('repo')
  await f.agent.pauseRun({ runId: f.run.id, reason: 'Paused work' })
  if (state === 'expired') {
    f.source.ctx().db.run("UPDATE attempts SET state = 'lease_expired', lease_expires_at = NULL WHERE id = ?", f.claimed.attempt.id)
    f.source.ctx().db.run("UPDATE kanban_attempts SET state = 'lease_expired', lease_expires_at = NULL WHERE id = ?", f.cardClaim.attemptId)
  }
  const completed = seedEpic(f.source.ctx(), { status: 'completed' })
  const before = f.source.ctx().db.get('SELECT * FROM epics WHERE id = ?', completed.epicId)
  const doneCard = await f.source.createKanbanCard({ title: 'Completed card', body: 'Preserve this content and audit history' })
  await f.source.playKanbanCard({ cardId: doneCard.id })
  const doneClaim = await f.agent.claimKanbanCard({ cardId: doneCard.id })
  await f.agent.submitKanbanCard({ attemptId: doneClaim.attemptId, claimToken: doneClaim.claimToken!, outputs: { summary: 'Accepted work remains done' } })
  await f.source.approveKanbanCard({ cardId: doneCard.id })
  const beforeCard = await f.source.getKanbanCard({ cardId: doneCard.id })
  const beforeEvents = f.source.ctx().db.all('SELECT * FROM kanban_events WHERE card_id = ? ORDER BY id', doneCard.id)
  const beforePlan = f.source.ctx().db.all('SELECT * FROM plan_revisions WHERE epic_id = ? ORDER BY id', completed.epicId)
  await withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))
  const dest = h.open('orchestrator', { root: f.member, git: createGitAdapter(f.member) })
  expect(dest.ctx().db.get('SELECT * FROM epics WHERE id = ?', completed.epicId)).toEqual(before)
  expect(dest.ctx().db.all('SELECT * FROM plan_revisions WHERE epic_id = ? ORDER BY id', completed.epicId)).toEqual(beforePlan)
  expect(await dest.getKanbanCard({ cardId: doneCard.id })).toEqual(beforeCard)
  expect(dest.ctx().db.all('SELECT * FROM kanban_events WHERE card_id = ? ORDER BY id', doneCard.id)).toEqual(beforeEvents)
  expect(dest.ctx().db.get('SELECT 1 FROM events WHERE epic_id = ? AND kind = ?', completed.epicId, 'epic.migration_restarted')).toBeUndefined()
  expect((await dest.getRun({ runId: f.run.id }))?.state).toBe('canceled')
  expect((await dest.startRun({ epicId: f.epic.id })).activeSprintOrdinal).toBe(1)
  await expect(dest.heartbeatAttempt({ attemptId: f.claimed.attempt.id, claimToken: f.claimed.packet.claimToken })).rejects.toMatchObject({ code: 'stale_claim' })
  expect((await dest.getKanbanCard({ cardId: f.card.id })).lane).toBe('backlog')
})

it('refuses missing image bytes instead of publishing an incomplete destination', async () => {
  const f = await activeProject('repo')
  const image = await f.source.uploadAttachment({ data: pngBytes(2, 3).toString('base64'), label: 'Required image', purpose: 'reference' })
  await f.source.addComment({ epicId: f.epic.id, body: 'Keep the image', attachments: [image.id] })
  f.source.ctx().db.run('UPDATE attachments SET data = NULL WHERE id = ?', image.id)
  rmSync(ownedPaths(resolveLayout(h.root)).attachmentFile({ kind: 'epic', id: f.epic.id }, image.sha256, image.mime))
  const before = f.source.ctx().db.get('SELECT * FROM attachments WHERE id = ?', image.id)
  await expect(withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))).rejects.toThrow('ENOENT')
  expect(f.source.ctx().db.get('SELECT * FROM attachments WHERE id = ?', image.id)).toEqual(before)
  expect(existsSync(join(f.member, '.darkmechanicus'))).toBe(false)
})

it.each(['malformed', 'conflict'] as const)('refuses %s canonical records and leaves the source usable', async kind => {
  const f = await activeProject('repo')
  const path = join(h.root, '.darkmechanicus/kanban', f.card.id, 'card.json')
  if (kind === 'malformed') writeFileSync(path, '{malformed')
  else {
    const remote = JSON.parse(readFileSync(path, 'utf8'))
    remote.title = 'Conflicting external edit'
    writeFileSync(path, JSON.stringify(remote))
    f.source.ctx().db.run("UPDATE kanban_cards SET title = 'Unexported local edit' WHERE id = ?", f.card.id)
    f.source.ctx().db.run("UPDATE outbox SET state = 'failed' WHERE kind = 'kanban_card' AND entity_id = ?", f.card.id)
  }
  const before = f.source.ctx().db.get('SELECT * FROM kanban_cards WHERE id = ?', f.card.id)
  await expect(withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))).rejects.toThrow('could not be imported')
  expect(f.source.ctx().db.get('SELECT * FROM kanban_cards WHERE id = ?', f.card.id)).toEqual(before)
  expect(existsSync(join(f.member, '.darkmechanicus'))).toBe(false)
})

it.each(['sync conflict', 'open transfer'] as const)('keeps the source unchanged when a %s blocks force migration', async hold => {
  const f = await activeProject('repo')
  if (hold === 'sync conflict') {
    f.source.ctx().db.run("UPDATE sync_state SET conflict = 'Unresolved remote edit' WHERE kind = 'kanban_card' AND entity_id = ?", f.card.id)
  } else {
    await f.agent.cancelRun({ runId: f.run.id, reason: 'Transfer fixture' })
    await f.source.queueTransfer({ epicId: f.epic.id })
  }
  const before = await f.source.getRun({ runId: f.run.id })
  await expect(withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))).rejects.toThrow(hold === 'sync conflict' ? 'Resolve storage conflicts' : 'open plan transfer')
  expect(await f.source.getRun({ runId: f.run.id })).toEqual(before)
  expect(existsSync(join(f.member, '.darkmechanicus'))).toBe(false)
})

it.each(['unsaved comment', 'missing attachment identity'] as const)('does not silently settle an unreconstructable %s export', async kind => {
  const f = await activeProject('repo')
  if (kind === 'unsaved comment') {
    const epic = await f.source.createEpic({ title: 'Unsaved plan remains private' })
    const comment = await f.source.addComment({ epicId: epic.id, body: 'Never auto-save this plan to publish its comment' })
    f.source.ctx().db.run("INSERT INTO outbox (kind, epic_id, entity_id, state, created_at) VALUES ('comment', ?, ?, 'failed', ?)", epic.id, comment.id, h.clock.nowIso())
  } else {
    f.source.ctx().db.run("INSERT INTO outbox (kind, state, created_at) VALUES ('attachment', 'failed', ?)", h.clock.nowIso())
  }
  const before = f.source.ctx().db.all("SELECT * FROM outbox WHERE state <> 'done'")
  const drafts = f.source.ctx().db.all('SELECT * FROM drafts')
  const comments = f.source.ctx().db.all('SELECT * FROM comments')
  await expect(withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))).rejects.toThrow('could not be reconstructed')
  expect(f.source.ctx().db.all("SELECT * FROM outbox WHERE state <> 'done'")).toEqual(before)
  expect(f.source.ctx().db.all('SELECT * FROM drafts')).toEqual(drafts)
  expect(f.source.ctx().db.all('SELECT * FROM comments')).toEqual(comments)
  expect(existsSync(join(f.member, '.darkmechanicus'))).toBe(false)
})

it('refuses force export to a database destination without altering the source', async () => {
  const f = await activeProject('db')
  const before = await f.source.getRun({ runId: f.run.id })
  expect(() => f.source.exportForge!(f.member, 'db', { force: true })).toThrow('Forge World destination')
  expect(await f.source.getRun({ runId: f.run.id })).toEqual(before)
})
