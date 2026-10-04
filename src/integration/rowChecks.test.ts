import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftOp, RecordRowCheckInput } from '../shared/domain/api'
import type { ReadinessView, RunView } from '../shared/domain/views'
import type { Workspace } from '../core/workspace'
import { dropAcceptanceNodes } from '../test/acceptanceNodes'
import { createHarness, type Harness } from '../test/workspaceHarness'

const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

/** Sprint 1: a (row 1) and f (row 1, independent); b and c need a (row 2). Sprint 2: d needs b and c. */
const OPS: DraftOp[] = [
  { op: 'set_epic', successCriteria: ['Every ticket delivered'] },
  { op: 'add_sprint', ref: 's2', sprint: { goal: 'Integrate' } },
  { op: 'add_ticket', ref: 'a', sprint: '1', ticket: { title: 'Schema', acceptanceCriteria: ['Tables exist'] } },
  { op: 'add_ticket', ref: 'b', sprint: '1', ticket: { title: 'API', acceptanceCriteria: ['Endpoints respond'] } },
  { op: 'add_ticket', ref: 'c', sprint: '1', ticket: { title: 'UI', acceptanceCriteria: ['Screens render'] } },
  { op: 'add_ticket', ref: 'f', sprint: '1', ticket: { title: 'Docs', acceptanceCriteria: ['Docs written'] } },
  { op: 'add_ticket', ref: 'd', sprint: 's2', ticket: { title: 'Integration', acceptanceCriteria: ['Parts work together'] } },
  { op: 'add_dependency', from: 'a', to: 'b' },
  { op: 'add_dependency', from: 'a', to: 'c' },
  { op: 'add_dependency', from: 'b', to: 'd' },
  { op: 'add_dependency', from: 'c', to: 'd' }
]

interface Planned {
  epicId: string
  sprintOne: string
  /** The acceptance node of sprint 1; only a plan made with `acceptanceNodes: true` has one. */
  nodeOne: string
  ids: Record<'a' | 'b' | 'c' | 'd' | 'f', string>
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error: unknown) {
    return (error as { code?: string }).code ?? 'thrown'
  }
}

/** Plans OPS. A new epic and `add_sprint` each add an acceptance node, which the plan keeps only on request. */
async function plan(agent: Workspace, options: { acceptanceNodes?: boolean } = {}): Promise<Planned> {
  const keep = options.acceptanceNodes === true
  await agent.initializeRepository({ name: 'demo-repo' })
  const epic = await agent.createEpic({ title: 'Rows', intent: 'Check a row before building on it.' })
  const first = keep ? 1 : await dropAcceptanceNodes(agent, epic.id)
  const update = await agent.updatePlanDraft({ epicId: epic.id, ops: OPS, expectedDraftRevision: first })
  expect(update.validation.errors).toEqual([])
  const last = keep ? update.draftRevision : await dropAcceptanceNodes(agent, epic.id)
  await agent.savePlan({ epicId: epic.id, expectedDraftRevision: last })
  const saved = await agent.getPlan({ epicId: epic.id, view: 'saved' })
  const sprintOne = saved.bundle.sprints[0]
  const node = saved.bundle.tickets.find((ticket) => ticket.kind === 'acceptance' && sprintOne?.ticketIds.includes(ticket.id))
  const id = (ref: string): string => update.refMap[ref] ?? ''
  return {
    epicId: epic.id,
    sprintOne: sprintOne?.id ?? '',
    nodeOne: node?.id ?? '',
    ids: { a: id('a'), b: id('b'), c: id('c'), d: id('d'), f: id('f') }
  }
}

async function accept(agent: Workspace, runId: string, ticketId: string): Promise<void> {
  const claim = await agent.claimTicket({ runId, ticketId, worker: { label: 'worker-1' } })
  await agent.submitAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken, outputs: { summary: 'done' } })
  await agent.acceptAttempt({ attemptId: claim.attempt.id })
}

function sorted(values: string[]): string[] {
  return [...values].sort()
}

/** Opens a fresh repository harness around each test and hands the current one to the test. */
function useHarness(): () => Harness {
  let harness: Harness | undefined
  beforeEach(() => {
    harness = createHarness()
  })
  afterEach(() => {
    harness?.cleanup()
  })
  return () => {
    if (harness === undefined) {
      throw new Error('The harness is only open while a test runs.')
    }
    return harness
  }
}

function passing(runId: string, sprintId: string): RecordRowCheckInput {
  return { runId, sprintId, row: 1, commit: COMMIT, checks: [{ name: 'combined tests', status: 'passed', detail: '' }] }
}

describe('rows in get_ready_tickets and get_run', () => {
  const harness = useHarness()

  it('reports the row of every ticket and the tickets and latest check of every row', async () => {
    const agent = harness().open('orchestrator')
    const { epicId, sprintOne, ids } = await plan(agent)
    const run = await agent.startRun({ epicId })
    const readiness = await agent.getReadyTickets({ runId: run.id })
    expect(readiness.rows.map((item) => [item.sprintId, item.row, sorted(item.tickets.map((ticket) => ticket.ticketId)), item.latestCheck])).toEqual([
      [sprintOne, 1, sorted([ids.a, ids.f]), null],
      [sprintOne, 2, sorted([ids.b, ids.c]), null]
    ])
    expect([...readiness.ready, ...readiness.blocked].map((ticket) => [ticket.ticketId, ticket.row]).sort()).toEqual(
      [[ids.a, 1], [ids.f, 1], [ids.b, 2], [ids.c, 2]].sort()
    )
    const view = await agent.getRun({ runId: run.id })
    expect(view?.rows).toHaveLength(3)
    expect(view?.tickets.find((ticket) => ticket.ticketId === ids.d)?.row).toBe(1)
  })
})

describe('holding back the dependents of a failed row', () => {
  const harness = useHarness()

  it('holds the dependents, leaves other tickets alone, and lets a passing check clear the hold', async () => {
    const agent = harness().open('orchestrator')
    const { epicId, sprintOne, ids } = await plan(agent)
    const run = await agent.startRun({ epicId })
    await accept(agent, run.id, ids.a)
    const open = await agent.getReadyTickets({ runId: run.id })
    expect(sorted(open.ready.map((ticket) => ticket.ticketId))).toEqual(sorted([ids.b, ids.c, ids.f]))
    const failed = await agent.recordRowCheck({
      ...passing(run.id, sprintOne),
      checks: [{ name: 'combined tests', status: 'failed', detail: '2 failed' }]
    })
    expect(failed).toMatchObject({ number: 1, passed: false, commit: COMMIT, row: 1 })
    const held = await agent.getReadyTickets({ runId: run.id })
    expect(held.ready.map((ticket) => ticket.ticketId)).toEqual([ids.f])
    for (const id of [ids.b, ids.c]) {
      const ticket = held.blocked.find((item) => item.ticketId === id)
      expect(ticket?.blockers).toEqual([{ kind: 'row_check_failed', sprintId: sprintOne, row: 1, checkId: failed.id }])
    }
    expect(held.rows[0]?.latestCheck).toEqual(failed)
    expect(await codeOf(agent.claimTicket({ runId: run.id, ticketId: ids.b, worker: { label: 'w' } }))).toBe('unmet_prerequisite')
    await agent.recordRowCheck(passing(run.id, sprintOne))
    const cleared = await agent.getReadyTickets({ runId: run.id })
    expect(sorted(cleared.ready.map((ticket) => ticket.ticketId))).toEqual(sorted([ids.b, ids.c, ids.f]))
  })
})

describe('record_row_check input', () => {
  const harness = useHarness()

  it('refuses malformed input before running anything', async () => {
    const agent = harness().open('orchestrator')
    const { epicId, sprintOne } = await plan(agent)
    const run = await agent.startRun({ epicId })
    const good = passing(run.id, sprintOne)
    expect(await codeOf(agent.recordRowCheck({ ...good, checks: [] }))).toBe('invalid_input')
    expect(await codeOf(agent.recordRowCheck({ ...good, commit: 'HEAD' }))).toBe('invalid_input')
    expect(await codeOf(agent.recordRowCheck({ ...good, row: 0 }))).toBe('invalid_input')
    expect(await codeOf(agent.recordRowCheck({ ...good, row: 1.5 }))).toBe('invalid_input')
    expect(await codeOf(agent.recordRowCheck({ ...good, extra: true } as typeof good))).toBe('invalid_input')
    expect(await codeOf(agent.recordRowCheck({ ...good, row: 9 }))).toBe('invalid_input')
    expect(await codeOf(agent.recordRowCheck(good))).toBe('ok')
  })
})

describe('row checks in the run history', () => {
  const harness = useHarness()

  it('are exported with the run history and come back in a clone', async () => {
    const agent = harness().open('orchestrator')
    const { epicId, sprintOne, ids } = await plan(agent)
    const run = await agent.startRun({ epicId })
    await accept(agent, run.id, ids.a)
    const record = (status: 'failed' | 'passed') =>
      agent.recordRowCheck({ ...passing(run.id, sprintOne), checks: [{ name: 'combined tests', status, detail: '' }] })
    await record('failed')
    await record('passed')
    const last = await record('failed')
    const file = join(harness().root, '.darkmechanicus', 'history', run.id, 'run.json')
    const written = JSON.parse(readFileSync(file, 'utf8')) as { rowChecks: { id: string; number: number; commit: string }[] }
    expect(written.rowChecks.map((item) => item.number)).toEqual([1, 2, 3])
    expect(written.rowChecks[2]).toMatchObject({ id: last.id, commit: COMMIT })
    const reopened = harness().open('orchestrator', { root: harness().cloneTracked() })
    const history = (await reopened.getRun({ runId: run.id })) as RunView
    expect(history.ownedByThisMachine).toBe(false)
    expect(history.rows[0]?.latestCheck).toEqual(last)
    expect(history.tickets.find((ticket) => ticket.ticketId === ids.b)?.blockers).toEqual([
      { kind: 'row_check_failed', sprintId: sprintOne, row: 1, checkId: last.id }
    ])
  })
})

function rowBlockersOf(readiness: ReadinessView, ticketId: string): unknown[] {
  const ticket = [...readiness.ready, ...readiness.blocked, ...readiness.inFlight].find((item) => item.ticketId === ticketId)
  return (ticket?.blockers ?? []).filter((blocker) => blocker.kind === 'row_check_failed')
}

describe('acceptance nodes and row checks', () => {
  const harness = useHarness()

  it('lists a node in no row and holds it while a row of its sprint has a failed check', async () => {
    const agent = harness().open('orchestrator')
    const { epicId, sprintOne, nodeOne } = await plan(agent, { acceptanceNodes: true })
    expect(nodeOne).not.toBe('')
    const run = await agent.startRun({ epicId })
    const start = await agent.getReadyTickets({ runId: run.id })
    expect([...start.ready, ...start.blocked].find((ticket) => ticket.ticketId === nodeOne)?.row).toBeNull()
    expect(start.rows.flatMap((item) => item.tickets.map((ticket) => ticket.ticketId))).not.toContain(nodeOne)
    expect((await agent.getRun({ runId: run.id }))?.rows.flatMap((item) => item.tickets.map((ticket) => ticket.ticketId))).not.toContain(nodeOne)
    const failed = await agent.recordRowCheck({ ...passing(run.id, sprintOne), row: 2, checks: [{ name: 'combined tests', status: 'failed', detail: '' }] })
    expect(rowBlockersOf(await agent.getReadyTickets({ runId: run.id }), nodeOne)).toEqual([
      { kind: 'row_check_failed', sprintId: sprintOne, row: 2, checkId: failed.id }
    ])
    await agent.recordRowCheck({ ...passing(run.id, sprintOne), row: 2 })
    expect(rowBlockersOf(await agent.getReadyTickets({ runId: run.id }), nodeOne)).toEqual([])
  })
})
