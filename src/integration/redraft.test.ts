/**
 * Redrafting the next sprint from the retro, end to end through the commands: a sprint ends with a leftover that
 * used up its retries (and a ticket waiting on it) and a discovery; the orchestrator redrafts, the plan is saved and
 * adopted, the sprint advances, and the leftover is ready again with a fresh budget. Also: who may redraft, and the
 * warnings a draft earns while the run is on a later sprint.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Workspace } from '../core/workspace'
import type { RedraftResultView, SprintReportView } from '../shared/domain/views'
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

/** Sprint 1: parse, then wire (needs parse), then docs (needs wire). A plan saved before acceptance nodes, so no node holds the sprint. */
async function planSprint(agent: Workspace): Promise<Planned> {
  await agent.initializeRepository({ name: 'demo-repo', keyPrefix: 'DM' })
  const epic = await agent.createEpic({ title: 'Parser epic', successCriteria: ['The parser ships'] })
  const first = await dropAcceptanceNodes(agent, epic.id)
  const update = await agent.updatePlanDraft({
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
  await agent.savePlan({ epicId: epic.id, expectedDraftRevision: update.draftRevision })
  const saved = await agent.getPlan({ epicId: epic.id, view: 'saved' })
  return {
    epicId: epic.id,
    sprintId: saved.bundle.sprints[0]?.id ?? '',
    parseId: update.refMap['parse'] ?? '',
    wireId: update.refMap['wire'] ?? '',
    docsId: update.refMap['docs'] ?? ''
  }
}

async function acceptTicket(agent: Workspace, run: Started, ticketId: string): Promise<void> {
  const claim = await agent.claimTicket({ runId: run.runId, ticketId, worker: { label: 'Claude Code' } })
  await agent.submitAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken, outputs: { summary: 'Done.' } })
  await agent.acceptAttempt({ attemptId: claim.attempt.id })
}

async function failTicket(agent: Workspace, run: Started, ticketId: string): Promise<void> {
  const claim = await agent.claimTicket({ runId: run.runId, ticketId, worker: { label: 'Claude Code' } })
  await agent.failAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken, failure: { reason: 'The signing identity is missing' } })
}

/** Parse is accepted; wire fails at every try it has; docs never start. */
async function workTheSprint(agent: Workspace, run: Started): Promise<void> {
  await acceptTicket(agent, run, run.parseId)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await failTicket(agent, run, run.wireId)
  }
}

async function submitReport(agent: Workspace, run: Started): Promise<SprintReportView> {
  return agent.submitSprintReport({
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
}

let harness: Harness
let orchestrator: Workspace
let run: Started

beforeEach(async () => {
  harness = createHarness()
  const planned = await planSprint(harness.open('planner'))
  orchestrator = harness.open('orchestrator')
  const started = await orchestrator.startRun({ epicId: planned.epicId })
  run = { ...planned, runId: started.id }
  await workTheSprint(orchestrator, run)
})

afterEach(() => {
  harness.cleanup()
})

async function stateOf(agent: Workspace, ticketId: string) {
  const readiness = await agent.getRun({ runId: run.runId })
  return readiness?.tickets.find((ticket) => ticket.ticketId === ticketId)
}

describe('redraft_next_sprint at the checkpoint', () => {
  it('starts from a leftover at its retry limit and a ticket waiting on it', async () => {
    expect(await stateOf(orchestrator, run.wireId)).toMatchObject({
      state: 'failed',
      attemptCount: 3,
      blockers: [{ kind: 'retry_limit', attempts: 3, limit: 3 }]
    })
    expect(await stateOf(orchestrator, run.docsId)).toMatchObject({ state: 'blocked' })
  })

  it('moves the leftover and what waits on it to a new sprint after the final one, adds the discovery, and keeps the draft valid', async () => {
    await submitReport(orchestrator, run)
    const result = await orchestrator.redraftNextSprint({ runId: run.runId })
    expect(result).toMatchObject({
      epicId: run.epicId,
      runId: run.runId,
      changed: true,
      sprintId: run.sprintId,
      sprintAdded: true,
      nextSprintOrdinal: 2,
      moved: [{ ticketId: run.wireId, title: 'Wire the parser in', reason: 'Waiting on a signing identity' }],
      dependentsMoved: [{ ticketId: run.docsId, title: 'Document the parser', requires: expect.stringMatching(/^DM-\d+$/) }],
      added: [{ title: 'Cache the parser output', source: expect.stringMatching(/^DM-\d+$/) }],
      skipped: []
    })
    expect(result.validation).toMatchObject({ valid: true, errors: [] })
    const draft = (await orchestrator.getPlan({ epicId: run.epicId, view: 'draft' })).bundle
    const [first, second] = draft.sprints
    expect(first?.ticketIds).toEqual([run.parseId])
    expect(second?.ticketIds.slice(0, 3)).toEqual([run.wireId, run.docsId, result.added[0]?.ticketId])
    const discovery = draft.tickets.find((ticket) => ticket.id === result.added[0]?.ticketId)
    expect(discovery).toMatchObject({ body: 'Every run reparses the same files.', references: [{ kind: 'ticket', location: result.added[0]?.source }] })
    expect(discovery).not.toHaveProperty('size')
  })

  it('leaves the saved plan and the run where they were until the draft is saved and adopted', async () => {
    await submitReport(orchestrator, run)
    await orchestrator.redraftNextSprint({ runId: run.runId })
    const saved = await orchestrator.getPlan({ epicId: run.epicId, view: 'saved' })
    expect(saved.bundle.sprints).toHaveLength(1)
    expect(await stateOf(orchestrator, run.wireId)).toMatchObject({ state: 'failed', attemptCount: 3 })
  })

})

describe('redraft_next_sprint called again, or too early', () => {
  it('changes nothing when called twice', async () => {
    await submitReport(orchestrator, run)
    const first = await orchestrator.redraftNextSprint({ runId: run.runId })
    const draftAfterFirst = await orchestrator.getPlan({ epicId: run.epicId, view: 'draft' })
    const second = await orchestrator.redraftNextSprint({ runId: run.runId })
    expect(second).toMatchObject({ changed: false, moved: [], dependentsMoved: [], added: [], draftRevision: first.draftRevision })
    expect(second.skipped.map((item) => item.code)).toEqual(['already_in_next_sprint', 'already_drafted'])
    expect(await orchestrator.getPlan({ epicId: run.epicId, view: 'draft' })).toEqual(draftAfterFirst)
  })

  it('refuses until a report with a retro is submitted', async () => {
    await expect(orchestrator.redraftNextSprint({ runId: run.runId })).rejects.toMatchObject({ code: 'run_not_active' })
    await orchestrator.submitSprintReport({ runId: run.runId, sprintId: run.sprintId, report: { summary: 'No retro.' } })
    await expect(orchestrator.redraftNextSprint({ runId: run.runId })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('retro')
    })
  })
})

describe('who may redraft the next sprint', () => {
  it.each(['worker', 'reviewer', 'planner'] as const)('refuses a %s session', async (role) => {
    await submitReport(orchestrator, run)
    await expect(harness.open(role).redraftNextSprint({ runId: run.runId })).rejects.toMatchObject({ code: 'unauthorized' })
    const plan = await orchestrator.getPlan({ epicId: run.epicId, view: 'draft' }).catch(() => null)
    expect(plan).toBeNull()
  })

  it('lets the desktop do it', async () => {
    await submitReport(orchestrator, run)
    const result: RedraftResultView = await harness.open('desktop').redraftNextSprint({ runId: run.runId })
    expect(result).toMatchObject({ changed: true, moved: [{ ticketId: run.wireId }] })
  })
})

describe('after the redraft is saved and adopted', () => {
  async function saveAndAdopt(): Promise<RedraftResultView> {
    await submitReport(orchestrator, run)
    const result = await orchestrator.redraftNextSprint({ runId: run.runId })
    await orchestrator.savePlan({ epicId: run.epicId, expectedDraftRevision: result.draftRevision })
    const saved = await orchestrator.getPlan({ epicId: run.epicId, view: 'saved' })
    await orchestrator.adoptRevision({ runId: run.runId, revisionId: saved.revisionId ?? '' })
    return result
  }

  it('gives the leftover a fresh budget in the sprint it moved to, and keeps the old attempts in history', async () => {
    await saveAndAdopt()
    expect(await stateOf(orchestrator, run.wireId)).toMatchObject({ state: 'later_sprint', attemptCount: 0, blockers: [] })
    const report = await orchestrator.getSprintReport({ runId: run.runId })
    const desktop = harness.open('desktop')
    await desktop.approveAndAdvance({ runId: run.runId, reportId: report?.id ?? '' })
    expect(await stateOf(orchestrator, run.wireId)).toMatchObject({ state: 'ready', attemptCount: 0, blockers: [] })
    const ticket = await orchestrator.getTicket({ epicId: run.epicId, ticketId: run.wireId, view: 'saved' })
    expect(ticket.attempts.map((attempt) => [attempt.state, attempt.superseded])).toEqual([
      ['failed', true],
      ['failed', true],
      ['failed', true]
    ])
  })

  it('lets the leftover be claimed and tried again, and holds what waits on it until it is accepted', async () => {
    const result = await saveAndAdopt()
    const report = await orchestrator.getSprintReport({ runId: run.runId })
    await harness.open('desktop').approveAndAdvance({ runId: run.runId, reportId: report?.id ?? '' })
    const ready = await orchestrator.getReadyTickets({ runId: run.runId })
    expect(ready.ready.map((ticket) => ticket.ticketId).sort()).toEqual([run.wireId, result.added[0]?.ticketId].sort())
    expect(await stateOf(orchestrator, run.docsId)).toMatchObject({ state: 'waiting' })
    const claim = await orchestrator.claimTicket({ runId: run.runId, ticketId: run.wireId, worker: { label: 'Claude Code' } })
    expect(claim.attempt.number).toBe(4)
    await acceptTicket(orchestrator, run, result.added[0]?.ticketId ?? '')
  })
})

describe('validate_plan while the run is on a later sprint', () => {
  async function advanceToSprintTwo(): Promise<void> {
    await submitReport(orchestrator, run)
    const result = await orchestrator.redraftNextSprint({ runId: run.runId })
    await orchestrator.savePlan({ epicId: run.epicId, expectedDraftRevision: result.draftRevision })
    const saved = await orchestrator.getPlan({ epicId: run.epicId, view: 'saved' })
    await orchestrator.adoptRevision({ runId: run.runId, revisionId: saved.revisionId ?? '' })
    const report = await orchestrator.getSprintReport({ runId: run.runId })
    await harness.open('desktop').approveAndAdvance({ runId: run.runId, reportId: report?.id ?? '' })
  }

  it('warns about an edit to the passed sprint and about a sprint inserted before the active one, and stays valid', async () => {
    await advanceToSprintTwo()
    const edit = await orchestrator.updatePlanDraft({
      epicId: run.epicId,
      ops: [
        { op: 'update_ticket', ticket: run.parseId, patch: { title: 'Build the parser, again' } },
        { op: 'add_sprint', sprint: { goal: 'Squeezed in' }, position: 2 }
      ]
    })
    expect(edit.validation.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['edits_passed_sprint', 'sprint_before_active'])
    )
    const validated = await orchestrator.validatePlan({ epicId: run.epicId, view: 'draft' })
    expect(validated.valid).toBe(true)
    expect(validated.warnings.filter((warning) => warning.code === 'edits_passed_sprint')).toMatchObject([
      { sprintIds: [run.sprintId], ticketIds: [run.parseId] }
    ])
    expect(validated.warnings.filter((warning) => warning.code === 'sprint_before_active')).toHaveLength(1)
  })

  it('is quiet about an edit to the sprint the run is on', async () => {
    await advanceToSprintTwo()
    await orchestrator.updatePlanDraft({
      epicId: run.epicId,
      ops: [{ op: 'update_ticket', ticket: run.wireId, patch: { title: 'Wire the parser in, properly' } }]
    })
    const validated = await orchestrator.validatePlan({ epicId: run.epicId, view: 'draft' })
    expect(validated.warnings.map((warning) => warning.code)).not.toContain('edits_passed_sprint')
  })
})
