/**
 * The whole loop through the commands: a sprint ends with a leftover that used up its retries (and a ticket
 * waiting on it) and a discovery; the orchestrator reports with a retro and redrafts the next sprint; the
 * checkpoint holds until the redraft is saved and adopted; the person approves the retro and the redraft in one
 * step, which saves, adopts, approves and advances; and the run ends up running the next sprint.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Workspace } from '../core/workspace'
import type { RedraftResultView } from '../shared/domain/views'
import { dropAcceptanceNodes } from '../test/acceptanceNodes'
import { createHarness, type Harness } from '../test/workspaceHarness'

interface Planned {
  epicId: string
  sprintId: string
  parseId: string
  wireId: string
  docsId: string
}

interface Started extends Planned {
  runId: string
}

/** Sprint 1: parse, then wire (needs parse), then docs (needs wire). Saved without acceptance nodes. */
async function planSprint(planner: Workspace): Promise<Planned> {
  await planner.initializeRepository({ name: 'demo-repo', keyPrefix: 'DM' })
  const epic = await planner.createEpic({ title: 'Parser epic', successCriteria: ['The parser ships'] })
  const first = await dropAcceptanceNodes(planner, epic.id)
  const update = await planner.updatePlanDraft({
    epicId: epic.id,
    expectedDraftRevision: first,
    ops: [
      { op: 'add_ticket', ref: 'parse', sprint: '1', ticket: { title: 'Build the parser', acceptanceCriteria: ['It parses'] } },
      { op: 'add_ticket', ref: 'wire', sprint: '1', ticket: { title: 'Wire the parser in', acceptanceCriteria: ['It is wired'] } },
      { op: 'add_ticket', ref: 'docs', sprint: '1', ticket: { title: 'Document the parser', acceptanceCriteria: ['Docs written'] } },
      { op: 'add_dependency', from: 'parse', to: 'wire' },
      { op: 'add_dependency', from: 'wire', to: 'docs' }
    ]
  })
  await planner.savePlan({ epicId: epic.id, expectedDraftRevision: update.draftRevision })
  const saved = await planner.getPlan({ epicId: epic.id, view: 'saved' })
  return {
    epicId: epic.id,
    sprintId: saved.bundle.sprints[0]?.id ?? '',
    parseId: update.refMap['parse'] ?? '',
    wireId: update.refMap['wire'] ?? '',
    docsId: update.refMap['docs'] ?? ''
  }
}

/** Parse is accepted; wire fails at every try it has; docs never start. */
async function workTheSprint(orchestrator: Workspace, run: Started): Promise<void> {
  const parse = await orchestrator.claimTicket({ runId: run.runId, ticketId: run.parseId, worker: { label: 'Claude Code' } })
  await orchestrator.submitAttempt({ attemptId: parse.attempt.id, claimToken: parse.packet.claimToken, outputs: { summary: 'Done.' } })
  await orchestrator.acceptAttempt({ attemptId: parse.attempt.id })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wire = await orchestrator.claimTicket({ runId: run.runId, ticketId: run.wireId, worker: { label: 'Claude Code' } })
    const failure = { reason: 'The signing identity is missing' }
    await orchestrator.failAttempt({ attemptId: wire.attempt.id, claimToken: wire.packet.claimToken, failure })
  }
}

/** The report with its retro, then the redraft of the next sprint from it. */
async function reportAndRedraft(orchestrator: Workspace, run: Started): Promise<RedraftResultView> {
  await orchestrator.submitSprintReport({
    runId: run.runId,
    sprintId: run.sprintId,
    report: {
      summary: 'Sprint 1 built the parser; wiring is still open.',
      retro: {
        wentPoorly: ['Wiring needs a signing identity nobody had'],
        leftovers: [{ ticket: run.wireId, reason: 'Waiting on a signing identity' }],
        discoveries: [{ title: 'Cache the parser output', body: 'Every run reparses the same files.', ticket: run.parseId }]
      }
    }
  })
  return orchestrator.redraftNextSprint({ runId: run.runId })
}

let harness: Harness
let orchestrator: Workspace
let desktop: Workspace
let run: Started

beforeEach(async () => {
  harness = createHarness()
  const planned = await planSprint(harness.open('planner'))
  orchestrator = harness.open('orchestrator', { allowSave: true })
  desktop = harness.open('desktop')
  const started = await orchestrator.startRun({ epicId: planned.epicId })
  run = { ...planned, runId: started.id }
  await workTheSprint(orchestrator, run)
})

afterEach(() => {
  harness.cleanup()
})

async function planCurrent(workspace: Workspace) {
  return (await workspace.getCheckpoint({ runId: run.runId })).conditions.find((item) => item.id === 'plan_current')
}

describe('report with retro, redraft, then approve with redraft', () => {
  it('holds the checkpoint while the redraft is unsaved, so the plain approval is refused', async () => {
    const redraft = await reportAndRedraft(orchestrator, run)
    expect(await planCurrent(desktop)).toMatchObject({
      met: false,
      detail: `The draft (revision ${redraft.draftRevision}) has changes the saved plan lacks: save it and adopt the new revision, or discard the draft`
    })
    const report = await desktop.getSprintReport({ runId: run.runId })
    await expect(desktop.approveAndAdvance({ runId: run.runId, reportId: report?.id ?? '' })).rejects.toMatchObject({ code: 'gate_blocked' })
  })

  it('saves, adopts, approves and advances in one step, and ends with the next sprint running', async () => {
    const redraft = await reportAndRedraft(orchestrator, run)
    const result = await desktop.approveWithRedraft({ runId: run.runId, expectedDraftRevision: redraft.draftRevision })
    const saved = await desktop.getPlan({ epicId: run.epicId, view: 'saved' })
    expect(result).toMatchObject({
      save: { status: 'saved', revisionId: saved.revisionId, revisionNumber: 2 },
      adoption: { revisionId: saved.revisionId, kept: [run.parseId] },
      approval: { runId: run.runId, sprintId: run.sprintId },
      advance: { outcome: 'advanced', activeSprintId: redraft.nextSprintId },
      run: { id: run.runId, state: 'running', activeSprintId: redraft.nextSprintId, revisionId: saved.revisionId }
    })
    const next = saved.bundle.sprints.find((sprint) => sprint.id === redraft.nextSprintId)
    expect(next?.ticketIds).toEqual(expect.arrayContaining([run.wireId, run.docsId, redraft.added[0]?.ticketId]))
    const ready = await orchestrator.getReadyTickets({ runId: run.runId })
    expect(ready.ready.map((ticket) => ticket.ticketId).sort()).toEqual([run.wireId, redraft.added[0]?.ticketId].sort())
    expect(await planCurrent(desktop)).toMatchObject({ met: true })
  })
})

describe('who may approve with redraft', () => {
  it.each([['orchestrator'], ['planner'], ['worker'], ['reviewer']] as const)('refuses a %s session and leaves the draft unsaved', async (role) => {
    const redraft = await reportAndRedraft(orchestrator, run)
    const agent = harness.open(role, { allowSave: true })
    await expect(agent.approveWithRedraft({ runId: run.runId, expectedDraftRevision: redraft.draftRevision })).rejects.toMatchObject({
      code: 'unauthorized'
    })
    expect((await desktop.getPlan({ epicId: run.epicId, view: 'draft' })).draftRevision).toBe(redraft.draftRevision)
    expect(await desktop.listRevisions({ epicId: run.epicId })).toHaveLength(1)
  })
})
