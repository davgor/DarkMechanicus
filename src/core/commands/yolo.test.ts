import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createConnection, createServer, type Socket } from 'node:net'
import { runCli } from '../../cli/main'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { acceptTickets, seedRun } from '../../test/checkpointSeed'
import { tid } from '../../test/bundles'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { approveYolo, bindYoloChat, endYoloChat, listYoloAudit, revokeYolo } from '../services/yolo'
import { createYoloDesktopRuntime } from '../services/yoloFence'
import type { Workspace } from '../workspace'

let harness: Harness
let desktop: Workspace
beforeEach(async () => {
  harness = createHarness()
  desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'Scoped elevation test' })
})
const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  harness.cleanup()
})

async function fixture(role: 'orchestrator' | 'reviewer' = 'orchestrator') {
  const ctx = { ...desktop.ctx(), clock: harness.clock }
  const run = seedRun(ctx)
  const issued = await desktop.issueGrant({ role, label: 'One active agent', allowSave: false, minutes: 60 })
  const agent = harness.open('reader', { transport: 'cli', grantToken: issued.token, autoReconcile: false })
  const fencePath = join(harness.homeDir, 'desktop-fence.json')
  const runtime = createYoloDesktopRuntime(fencePath)
  await runtime.ready
  disposers.push(runtime.dispose)
  const fence = runtime.fence
  const binding = { grantId: issued.grant.id, chatId: 'test-chat', generation: 'test-start', desktopId: fence.instance, desktopPid: fence.pid, fencePath, proofEndpoint: fence.proofEndpoint, proofPublicKey: fence.proofPublicKey, runId: run.runId }
  bindYoloChat(ctx, binding)
  return { ctx, run, issued, agent, binding }
}

  it('permits an ordinary own-run Save without YOLO but still requires retry approval', async () => {
    const { ctx, run, agent } = await fixture()
    const draft = await desktop.openDraft({ epicId: run.epicId })
    await expect(agent.savePlan({
      epicId: run.epicId,
      expectedDraftRevision: draft.draftRevision ?? 0
    })).resolves.toMatchObject({ status: 'unchanged' })
    expect(agent.ctx().session.capabilities.has('plan.save')).toBe(false)
    expect(listYoloAudit(ctx).filter((entry) => entry.command === 'savePlan')).toEqual([])
    await expect(agent.grantRetry({ runId: run.runId, ticketId: tid(1) })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('denies then permits actual Save/retry/checkpoint commands without desktop promotion or forbidden powers', async () => {
    const { ctx, run, issued, agent, binding } = await fixture()
    // Ordinary own-run saves need no elevation; a retry-policy change specifically requires plan.save.
    const draft = await desktop.updatePlanDraft({
      epicId: run.epicId,
      ops: [{ op: 'set_policies', patch: { retryLimit: run.bundle.policies.retryLimit + 1 } }]
    })
    const save = { epicId: run.epicId, expectedDraftRevision: draft.draftRevision ?? 0 }
    await expect(agent.savePlan(save)).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(agent.grantRetry({ runId: run.runId, ticketId: tid(1) })).rejects.toMatchObject({ code: 'unauthorized' })
    approveYolo(ctx, binding)
    const saved = await agent.savePlan(save)
    expect(listYoloAudit(ctx).find((entry) => entry.command === 'savePlan' && entry.result === 'admitted')?.targetId).toBe(run.epicId)
    // Adopt the elevated policy Save so checkpoint assertions test authority, not a stale-plan rejection.
    await desktop.adoptRevision({ runId: run.runId, revisionId: saved.revisionId, reason: 'Adopt the approved retry-policy revision before verifying checkpoint progression.' })
    await agent.grantRetry({ runId: run.runId, ticketId: tid(1) })
    acceptTickets(ctx, run, [1, 2])
    const report = await agent.submitSprintReport({ runId: run.runId, sprintId: run.bundle.sprints[0]?.id ?? '', report: { summary: 'Verified work', retro: { actions: [
      '[YOLO plan.save] planner: Save only a validated draft in the bound epic after review.',
      '[YOLO ticket.retry_grant] orchestrator: Grant one retry only after a recorded failure diagnosis.'
    ] } } })
    const advanced = await agent.approveAndAdvance({ runId: run.runId, reportId: report.id })
    expect(advanced.activeSprintId).toBe(run.bundle.sprints[1]?.id)
    expect(listYoloAudit(ctx).find((entry) => entry.command === 'approveAndAdvance' && entry.result === 'admitted')?.targetId).toBe(report.id)
    expect(agent.ctx().session.role).toBe('orchestrator')
    expect(agent.ctx().session.capabilities.has('checkpoint.approve')).toBe(false)
    await expect(agent.issueGrant({ role: 'reader', label: 'Self grant' })).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(agent.revokeGrant({ grantId: issued.grant.id })).rejects.toMatchObject({ code: 'unauthorized' })
    revokeYolo(ctx, issued.grant.id)
    await expect(agent.grantRetry({ runId: run.runId, ticketId: tid(3) })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('runs the same elevated workflow through the ordinary CLI entry without an enabling command', async () => {
    const { ctx, run, issued, binding } = await fixture()
    const invoke = async () => {
      const stdout: string[] = []
      const exits: number[] = []
      await runCli({
        argv: ['--repo', harness.root, 'call', 'grant_retry', JSON.stringify({ runId: run.runId, ticketId: tid(1) })],
        env: { DM_SESSION_TOKEN: issued.token }, cwd: harness.root, execPath: process.execPath, cliPath: 'test-cli',
        open: () => harness.open('reader', { transport: 'cli', grantToken: issued.token, autoReconcile: false }),
        readFile: () => '', readStdin: () => '', writeStdout: (text) => stdout.push(text), writeStderr: () => {}, exit: (code) => exits.push(code)
      })
      return { result: JSON.parse(stdout.join('')) as { ok: boolean; error?: { code: string } }, exits }
    }
    expect(await invoke()).toMatchObject({ result: { ok: false, error: { code: 'unauthorized' } }, exits: [1] })
    approveYolo(ctx, binding)
    expect(await invoke()).toMatchObject({ result: { ok: true }, exits: [0] })
  })

  it('appends only this card grant’s server log to Kanban evidence and requires role recommendations', async () => {
    const { ctx, run, agent, binding } = await fixture()
    ctx.db.run("UPDATE runs SET state = 'canceled' WHERE id = ?", run.runId)
    const card = await desktop.createKanbanCard({ title: 'Bound card' })
    await desktop.playKanbanCard({ cardId: card.id })
    const claim = await agent.claimKanbanCard({ cardId: card.id })
    const scoped = { ...binding, runId: null, cardId: card.id }
    bindYoloChat(ctx, scoped)
    approveYolo(ctx, scoped)
    const draft = await desktop.openDraft({ epicId: run.epicId })
    await agent.savePlan({ epicId: run.epicId, expectedDraftRevision: draft.draftRevision ?? 0 })
    const submission = { attemptId: claim.attemptId, claimToken: claim.claimToken ?? '', outputs: { summary: 'Finished scoped work' } }
    await expect(agent.submitKanbanCard(submission)).rejects.toMatchObject({ code: 'invalid_input' })
    const result = await agent.submitKanbanCard({ ...submission, evidence: { notes: '[YOLO plan.save] planner: Permit Save for one validated draft in the current folder, never grant issuance.' } })
    expect(result.evidence?.notes).toContain('Server-recorded YOLO usage')
    expect(result.evidence?.notes).toContain('savePlan')
    expect(result.evidence?.notes).toContain(`card=${card.id}`)
    expect(result.evidence?.notes).not.toContain('sprint retro')
  })

  it('refuses wrong runs, different grants and folders through actual command dispatch', async () => {
    const { ctx, run, issued, agent, binding } = await fixture()
    approveYolo(ctx, binding)
    const other = seedRun(ctx)
    await expect(agent.grantRetry({ runId: other.runId, ticketId: tid(1) })).rejects.toMatchObject({ code: 'unauthorized' })
    const second = await desktop.issueGrant({ role: 'orchestrator', label: 'Different chat' })
    const stranger = harness.open('reader', { transport: 'cli', grantToken: second.token, autoReconcile: false })
    await expect(stranger.grantRetry({ runId: run.runId, ticketId: tid(1) })).rejects.toMatchObject({ code: 'unauthorized' })
    const folder = createHarness()
    try {
      await folder.open('desktop').initializeRepository({ name: 'Other folder' })
      expect(() => folder.open('reader', { transport: 'cli', grantToken: issued.token })).toThrow()
    } finally { folder.cleanup() }
  })

  it.each(['expiry', 'parent revoke', 'new generation', 'chat exit'])('rechecks %s before the next privileged command', async (ending) => {
    const { ctx, run, issued, agent, binding } = await fixture()
    approveYolo(ctx, binding)
    if (ending === 'expiry') harness.clock.advanceSeconds(60 * 60)
    if (ending === 'parent revoke') await desktop.revokeGrant({ grantId: issued.grant.id })
    if (ending === 'new generation') bindYoloChat(ctx, { ...binding, generation: 'different-start' })
    if (ending === 'chat exit') endYoloChat(ctx, issued.grant.id)
    await expect(agent.grantRetry({ runId: run.runId, ticketId: tid(1) })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('rejects the old token after another desktop starts while the bound folder is unavailable', async () => {
    const { ctx, run, agent, binding } = await fixture()
    approveYolo(ctx, binding)
    // Startup rotates the machine-local fence without opening this temporarily unavailable folder.
    writeFileSync(binding.fencePath, JSON.stringify({ instance: 'new-desktop', pid: process.pid }))
    await expect(agent.grantRetry({ runId: run.runId, ticketId: tid(1) })).rejects.toMatchObject({ code: 'unauthorized' })
    expect(ctx.db.get('SELECT extra FROM retry_grants WHERE run_id = ?', run.runId)).toBeUndefined()
  })

  it('rejects the old token when its desktop process has ended but the parent grant is unexpired', async () => {
    const { ctx, run, agent, binding } = await fixture()
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready');process.stdin.once('data',()=>process.exit(0));setTimeout(()=>process.exit(1),2000)"], { stdio: ['pipe', 'pipe', 'pipe'] })
    await once(child.stdout, 'data')
    if (child.pid === undefined) throw new Error('The fixture desktop did not start.')
    const live = { ...binding, desktopPid: child.pid }
    writeFileSync(binding.fencePath, JSON.stringify({ instance: live.desktopId, pid: live.desktopPid, proofEndpoint: live.proofEndpoint, proofPublicKey: live.proofPublicKey }))
    bindYoloChat(ctx, live)
    approveYolo(ctx, live)
    child.stdin.end('exit')
    expect((await once(child, 'exit'))[0]).toBe(0)
    await expect(agent.grantRetry({ runId: run.runId, ticketId: tid(1) })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('audits each missing combined-command capability and requires both recommendations', async () => {
    const { ctx, run, agent, binding } = await fixture('reviewer')
    approveYolo(ctx, binding)
    acceptTickets(ctx, run, [1, 2])
    const reporter = harness.open('orchestrator')
    const report = await reporter.submitSprintReport({ runId: run.runId, sprintId: run.bundle.sprints[0]?.id ?? '', report: { summary: 'Ready', retro: { wentWell: ['Work verified'] } } })
    await agent.approveAndAdvance({ runId: run.runId, reportId: report.id })
    const admitted = listYoloAudit(ctx).filter((entry) => entry.command === 'approveAndAdvance' && entry.result === 'admitted')
    expect(admitted.map((entry) => entry.capability).sort()).toEqual(['checkpoint.advance', 'checkpoint.approve'])
    await expect(agent.approveAndAdvance({ runId: run.runId, reportId: report.id })).rejects.toThrow()
    const failed = listYoloAudit(ctx).filter((entry) => entry.command === 'approveAndAdvance' && entry.result === 'failed')
    expect(failed.map((entry) => entry.capability).sort()).toEqual(['checkpoint.advance', 'checkpoint.approve'])
    await expect(reporter.submitSprintReport({ runId: run.runId, sprintId: run.bundle.sprints[1]?.id ?? '', report: { summary: 'Needs both recommendations', retro: { actions: ['[YOLO checkpoint.approve] reviewer: Approve only a fully verified checkpoint within this run.'] } } })).rejects.toMatchObject({ code: 'invalid_input' })
    const written = await reporter.submitSprintReport({ runId: run.runId, sprintId: run.bundle.sprints[1]?.id ?? '', report: { summary: 'Both recommendations', retro: { actions: [
      '[YOLO checkpoint.approve] reviewer: Approve only a verified checkpoint in this bound run.',
      '[YOLO checkpoint.advance] orchestrator: Advance only after all unchanged evidence gates pass.'
    ] } } })
    expect(written.report.retro?.yoloUsage).toEqual(expect.arrayContaining([
      expect.stringContaining('checkpoint.advance | approveAndAdvance | failed'),
      expect.stringContaining('checkpoint.approve | approveAndAdvance | failed')
    ]))
  })

  it('records distinct validated workflow targets without conflating the bound card', async () => {
    const { ctx, run, agent, binding } = await fixture()
    approveYolo(ctx, binding)
    for (const ticketId of [tid(1), tid(2)]) await agent.grantRetry({ runId: run.runId, ticketId })
    await expect(agent.grantRetry({ runId: run.runId, ticketId: tid(999) })).rejects.toThrow()
    const entries = listYoloAudit(ctx).filter((entry) => entry.command === 'grantRetry' && entry.result === 'admitted')
    expect(entries.map((entry) => entry.targetId)).toEqual([tid(1), tid(2), tid(999)])
  })

  it.each(['worker', 'non-grant reporter'])('retains complete card usage when a separate %s submits', async (submitterKind) => {
    const { ctx, run, agent, binding } = await fixture()
    ctx.db.run("UPDATE runs SET state = 'canceled' WHERE id = ?", run.runId)
    const card = await desktop.createKanbanCard({ title: 'Shared completion evidence' })
    await desktop.playKanbanCard({ cardId: card.id })
    const claim = await agent.claimKanbanCard({ cardId: card.id })
    const scoped = { ...binding, runId: null, cardId: card.id }
    bindYoloChat(ctx, scoped)
    approveYolo(ctx, scoped)
    const draft = await desktop.openDraft({ epicId: run.epicId })
    await agent.savePlan({ epicId: run.epicId, expectedDraftRevision: draft.draftRevision ?? 0 })
    const worker = await desktop.issueGrant({ role: 'worker', label: 'Different submitting worker' })
    const submitter = submitterKind === 'worker'
      ? harness.open('reader', { transport: 'cli', grantToken: worker.token, autoReconcile: false })
      : harness.open('orchestrator')
    const input = { attemptId: claim.attemptId, claimToken: claim.claimToken ?? '', outputs: { summary: 'Completed by another participant' } }
    await expect(submitter.submitKanbanCard(input)).rejects.toMatchObject({ code: 'invalid_input' })
    const result = await submitter.submitKanbanCard({ ...input, evidence: { notes: '[YOLO plan.save] planner: Save only a validated draft after scoped review, not checkpoint approval.' } })
    expect(result.evidence?.notes).toContain('savePlan')
    expect(result.evidence?.notes).toContain(binding.grantId)
  })

async function signedDesktopReply(endpoint: string, nonce: Buffer): Promise<string> {
  const socket = createConnection(endpoint)
  socket.write(nonce)
  let frame = ''
  for await (const data of socket) {
    frame += String(data)
    if (frame.includes('\n')) break
  }
  return frame
}

it('denies Save without mutation if its epic maps to a replacement run while desktop proof is pending', async () => {
  const { ctx, run, agent, binding } = await fixture()
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\dm-yolo-delayed-${randomUUID()}` : join(harness.homeDir, 'delayed.sock')
  let held: Socket | undefined
  const server = createServer((socket) => { held = socket; socket.pause() })
  server.listen(endpoint)
  await once(server, 'listening')
  disposers.push(async () => { held?.destroy(); const closed = once(server, 'close'); server.close(); await closed })
  const delayed = { ...binding, proofEndpoint: endpoint }
  writeFileSync(binding.fencePath, JSON.stringify({ instance: binding.desktopId, pid: binding.desktopPid, proofEndpoint: endpoint, proofPublicKey: binding.proofPublicKey }))
  bindYoloChat(ctx, delayed)
  approveYolo(ctx, delayed)
  await desktop.openDraft({ epicId: run.epicId })
  const edited = await desktop.updatePlanDraft({ epicId: run.epicId, ops: [
    { op: 'set_epic', title: 'Must remain unsaved' },
    { op: 'set_policies', patch: { retryLimit: run.bundle.policies.retryLimit + 1 } }
  ] })
  const savedBefore = await desktop.getPlan({ epicId: run.epicId, view: 'saved' })
  const draftBefore = await desktop.getPlan({ epicId: run.epicId, view: 'draft' })
  const connected = once(server, 'connection')
  const outcome = agent.savePlan({ epicId: run.epicId, expectedDraftRevision: edited.draftRevision }).then(
    (value) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }))
  const [socket] = await connected as [Socket]
  const request = once(socket, 'data')
  socket.resume()
  const [nonce] = await request as [Buffer]
  ctx.db.tx(() => {
    ctx.db.run("UPDATE runs SET state = 'canceled' WHERE id = ?", run.runId)
    ctx.db.run(`INSERT INTO runs (id, epic_id, number, revision_id, state, active_sprint_id, owner_machine_id, created_at, started_at, updated_at)
      SELECT ?, epic_id, 2, revision_id, 'running', active_sprint_id, owner_machine_id, created_at, started_at, updated_at FROM runs WHERE id = ?`, ctx.ids.next('run'), run.runId)
  })
  const reply = await signedDesktopReply(binding.proofEndpoint, nonce)
  expect(reply).toMatch(/^[0-9a-f]{128}\n$/)
  socket.end(reply)
  expect(await outcome).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  expect(await desktop.getPlan({ epicId: run.epicId, view: 'saved' })).toEqual(savedBefore)
  expect(await desktop.getPlan({ epicId: run.epicId, view: 'draft' })).toEqual(draftBefore)
  expect(listYoloAudit(ctx).filter((entry) => entry.command === 'savePlan')).toEqual([])
})

  it('refuses a reused live PID when the former desktop instance has no challenge endpoint', async () => {
    const { ctx, run, agent, binding } = await fixture()
    const proofEndpoint = process.platform === 'win32' ? `\\\\.\\pipe\\dm-yolo-missing-${randomUUID()}` : join(harness.homeDir, 'missing.sock')
    const proofPublicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const reused = { ...binding, proofEndpoint, proofPublicKey }
    writeFileSync(binding.fencePath, JSON.stringify({ instance: reused.desktopId, pid: process.pid, proofEndpoint, proofPublicKey }))
    bindYoloChat(ctx, reused)
    approveYolo(ctx, reused)
    // The PID is live but belongs to a different process instance; its former listener is gone.
    await expect(agent.grantRetry({ runId: run.runId, ticketId: tid(1) })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('retains complete card usage when the clock moves behind the claim timestamp', async () => {
    const { ctx, run, agent, binding } = await fixture()
    ctx.db.run("UPDATE runs SET state = 'canceled' WHERE id = ?", run.runId)
    const card = await desktop.createKanbanCard({ title: 'Clock rollback evidence' })
    await desktop.playKanbanCard({ cardId: card.id })
    const claim = await agent.claimKanbanCard({ cardId: card.id })
    const scoped = { ...binding, runId: null, cardId: card.id }
    bindYoloChat(ctx, scoped)
    approveYolo(ctx, scoped)
    const draft = await desktop.openDraft({ epicId: run.epicId })
    harness.clock.advanceSeconds(-1)
    await agent.savePlan({ epicId: run.epicId, expectedDraftRevision: draft.draftRevision ?? 0 })
    const input = { attemptId: claim.attemptId, claimToken: claim.claimToken ?? '', outputs: { summary: 'Current actual usage' } }
    await expect(agent.submitKanbanCard(input)).rejects.toMatchObject({ code: 'invalid_input' })
    const submitted = await agent.submitKanbanCard({ ...input, evidence: { notes: '[YOLO plan.save] planner: Save only reviewed drafts for this folder, never native grant controls.' } })
    expect(submitted.evidence?.notes).toContain('savePlan')
  })

  it('includes prior attempts of the same card while excluding another card’s actual usage', async () => {
    const { ctx, run, agent, binding } = await fixture()
    ctx.db.run("UPDATE runs SET state = 'canceled' WHERE id = ?", run.runId)
    const card = await desktop.createKanbanCard({ title: 'Complete affected card history' })
    await desktop.playKanbanCard({ cardId: card.id })
    const first = await agent.claimKanbanCard({ cardId: card.id })
    const scope = { ...binding, runId: null, cardId: card.id }
    bindYoloChat(ctx, scope)
    approveYolo(ctx, scope)
    const draft = await desktop.openDraft({ epicId: run.epicId })
    await agent.savePlan({ epicId: run.epicId, expectedDraftRevision: draft.draftRevision ?? 0 })
    await agent.failKanbanCard({ attemptId: first.attemptId, claimToken: first.claimToken ?? '', reason: 'Another attempt is needed' })
    await desktop.playKanbanCard({ cardId: card.id })
    const second = await agent.claimKanbanCard({ cardId: card.id })
    const unrelated = await desktop.createKanbanCard({ title: 'Unrelated card' })
    const issued = await desktop.issueGrant({ role: 'orchestrator', label: 'Other card agent' })
    const other = harness.open('reader', { transport: 'cli', grantToken: issued.token, autoReconcile: false })
    const otherScope = { ...binding, grantId: issued.grant.id, runId: null, cardId: unrelated.id, chatId: 'other-chat' }
    bindYoloChat(ctx, otherScope)
    approveYolo(ctx, otherScope)
    const nextDraft = await desktop.openDraft({ epicId: run.epicId })
    await other.savePlan({ epicId: run.epicId, expectedDraftRevision: nextDraft.draftRevision ?? 0 })
    const input = { attemptId: second.attemptId, claimToken: second.claimToken ?? '', outputs: { summary: 'Whole card history retained' } }
    await expect(agent.submitKanbanCard(input)).rejects.toMatchObject({ code: 'invalid_input' })
    const result = await agent.submitKanbanCard({ ...input, evidence: { notes: '[YOLO plan.save] planner: Permit reviewed Save for this card scope, never broader human powers.' } })
    expect(result.evidence?.notes).toContain('complete card history')
    expect(result.evidence?.notes).toContain('savePlan')
    expect(result.evidence?.notes).not.toContain(issued.grant.id)
    expect(result.evidence?.notes).not.toContain(unrelated.id)
  })

  it('audits failed handlers outside rollback without payloads and preserves audit across real workspace reopen', async () => {
    const { ctx, run, issued, agent, binding } = await fixture()
    approveYolo(ctx, binding)
    const marker = 'private-request-DO-NOT-PERSIST-582710'
    await expect(agent.savePlan({ epicId: run.epicId, expectedDraftRevision: 999, idempotencyKey: marker })).rejects.toThrow()
    const log = listYoloAudit(ctx)
    expect(log.filter((entry) => entry.command === 'savePlan').map((entry) => entry.result)).toEqual(['admitted', 'failed'])
    expect(JSON.stringify(log)).not.toContain(marker)
    expect(log.every((entry) => Object.keys(entry).sort().join(',') === 'boundCardId,capability,command,folder,grantId,id,result,runId,sessionId,targetId,time')).toBe(true)
    agent.close()
    desktop.close()
    desktop = harness.open('desktop', { autoReconcile: false })
    const nextDesktop = createYoloDesktopRuntime(binding.fencePath)
    await nextDesktop.ready
    disposers.push(nextDesktop.dispose)
    expect(listYoloAudit(desktop.ctx())).toEqual(log)
    const restarted = harness.open('reader', { transport: 'cli', grantToken: issued.token, autoReconcile: false })
    await expect(restarted.grantRetry({ runId: run.runId, ticketId: tid(1) })).rejects.toMatchObject({ code: 'unauthorized' })
  })
