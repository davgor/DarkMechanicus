import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { dropAcceptanceNodes } from '../test/acceptanceNodes'
import { issued } from '../test/execution'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { bindForge, FORGE_POINTER, withForgeTransfer } from './repo/forgeBinding'
import { createGitAdapter } from './repo/git'
import { dbProjectDir } from './repo/storageMode'

let h: Harness
beforeEach(() => { h = createHarness() })
afterEach(() => h.cleanup())

async function pausedProject(mode: 'repo' | 'db') {
  const source = h.open('desktop', { transport: 'desktop', mode })
  await source.initializeRepository({ name: 'Paused project' })
  const epic = await source.createEpic({ title: 'Work survives migration' })
  await dropAcceptanceNodes(source, epic.id)
  const draft = await source.updatePlanDraft({ epicId: epic.id, ops: [
    { op: 'add_ticket', ref: 'first', sprint: '1', ticket: { title: 'Already accepted' } },
    { op: 'add_ticket', ref: 'next', sprint: '1', ticket: { title: 'Resume this work' } },
    { op: 'add_dependency', from: 'first', to: 'next' }
  ] })
  await source.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  const agent = h.open('orchestrator')
  const run = await agent.startRun({ epicId: epic.id })
  const claim = issued(await agent.claimTicket({ runId: run.id, ticketId: draft.refMap.first!, worker: { label: 'First worker' } }))
  await agent.submitAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken, outputs: { summary: 'Accepted before migration' } })
  await agent.acceptAttempt({ attemptId: claim.attempt.id })
  await agent.pauseRun({ runId: run.id, reason: 'Move tickets without losing progress' })
  agent.close()
  return { source, runId: run.id, nextId: draft.refMap.next! }
}

it.each(['repo', 'db'] as const)('preserves and resumes a paused %s run after Forge export and source retirement', async mode => {
  const { source, runId, nextId } = await pausedProject(mode)
  const before = await source.getRun({ runId })
  const member = join(h.homeDir, 'Forge', 'Project')
  mkdirSync(member, { recursive: true })
  // The desktop conversion exports first, retires repo storage through the normal switch,
  // then archives the source database and binds the code checkout to the Forge member.
  await withForgeTransfer(h.homeDir, h.root, member, async () => {
    source.exportForge!(member)
    // ForgeService.sync reconciles the registered member before retiring the source.
    // Use the real adapter: the member has no .git, unlike the code checkout's main branch.
    const syncing = h.open('desktop', { root: member, transport: 'desktop', git: createGitAdapter(member) })
    expect((await syncing.reconcileRepository()).rejected).toEqual([])
    syncing.close()
    if (mode === 'repo') await source.switchStorageMode({ mode: 'db', confirmed: true })
    source.close()
    const oldStore = dbProjectDir(h.root, h.homeDir)
    renameSync(oldStore, oldStore + '.archived')
    const note = 'Forge World: https://github.com/test/world.git\nProject folder: Project\n'
    writeFileSync(join(h.root, FORGE_POINTER), note)
    bindForge(h.homeDir, h.root, member, note)
  })
  expect(existsSync(join(h.root, '.darkmechanicus'))).toBe(false)
  const destination = h.open('orchestrator', { git: createGitAdapter(member) })
  expect(destination.repoRoot).toBe(member)
  expect(await destination.getRun({ runId })).toEqual(before)
  expect(await destination.resumeRun({ runId })).toMatchObject({ id: runId, state: 'running', pauseReason: null })
  expect((await destination.getReadyTickets({ runId })).ready.map(ticket => ticket.ticketId)).toEqual([nextId])
  const continued = issued(await destination.claimTicket({ runId, ticketId: nextId, worker: { label: 'After migration' } }))
  expect(continued.attempt.ticketId).toBe(nextId)
  expect((await destination.getRun({ runId }))?.attempts).toEqual(expect.arrayContaining(before!.attempts))
})

it.each(['claimed', 'running', 'lease_expired'] as const)('refuses a paused run with an unresolved %s attempt before exporting', async state => {
  const { source, runId, nextId } = await pausedProject('db')
  const agent = h.open('orchestrator')
  await agent.resumeRun({ runId })
  const claim = issued(await agent.claimTicket({ runId, ticketId: nextId, worker: { label: 'Unresolved worker' } }))
  await agent.pauseRun({ runId })
  agent.close()
  source.ctx().db.run('UPDATE attempts SET state = ? WHERE id = ?', state, claim.attempt.id)
  const before = await source.getRun({ runId })
  const member = join(h.homeDir, 'Forge', 'Blocked')
  mkdirSync(member, { recursive: true })
  await expect(withForgeTransfer(h.homeDir, h.root, member, async () => source.exportForge!(member))).rejects.toThrow('Resolve every claimed or uncertain attempt')
  expect(existsSync(join(member, '.darkmechanicus'))).toBe(false)
  expect(await source.getRun({ runId })).toEqual(before)
})
