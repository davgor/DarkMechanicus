import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftOp } from '../../shared/domain/api'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { openDatabase } from '../db/database'
import { encodeBase32, ID_PREFIXES } from '../ids'
import { nodeFs } from '../repo/nodeFs'
import type { Workspace } from '../workspace'

/** Sprint 1: First. Sprint 2: Second, which requires First. */
const TWO_SPRINTS: DraftOp[] = [
  { op: 'set_epic', successCriteria: ['Both parts work'] },
  { op: 'add_ticket', ref: 'first', sprint: '1', ticket: { title: 'First', acceptanceCriteria: ['First works'] } },
  { op: 'add_sprint', ref: 's2', sprint: { goal: 'Finish' } },
  { op: 'add_ticket', ref: 'second', sprint: 's2', ticket: { title: 'Second', acceptanceCriteria: ['Second works'] } },
  { op: 'add_dependency', from: 'first', to: 'second' }
]

interface Planned {
  epicId: string
  ticket(ref: string): string
}

async function savedEpic(agent: Workspace, title: string, ops: DraftOp[]): Promise<Planned> {
  const epic = await agent.createEpic({ title, idempotencyKey: `create-${title}` })
  const draft = await agent.updatePlanDraft({ epicId: epic.id, ops })
  await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  return { epicId: epic.id, ticket: (ref) => draft.refMap[ref] ?? '' }
}

async function deliver(agent: Workspace, runId: string, ticketId: string): Promise<void> {
  const claim = await agent.claimTicket({ runId, ticketId, worker: { label: 'worker-1' } })
  await agent.submitAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken, outputs: { summary: 'done' } })
  await agent.acceptAttempt({ attemptId: claim.attempt.id })
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error: unknown) {
    return (error as { code?: string }).code ?? 'thrown'
  }
}

let harness: Harness

beforeEach(() => {
  harness = createHarness()
})

afterEach(() => {
  harness.cleanup()
})

function dmPath(...parts: string[]): string {
  return join(harness.root, '.darkmechanicus', ...parts)
}

/** Every database row (FTS internals aside) that mentions one of `ids`, as `table: row`. */
function rowsMentioning(ids: string[]): string[] {
  const db = openDatabase(dmPath('local', 'state.sqlite'))
  try {
    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'search_index_%' AND name <> 'sqlite_sequence'"
    )
    return tables.flatMap(({ name }) =>
      db
        .all<Record<string, unknown>>(`SELECT * FROM "${name}"`)
        .map((row) => `${name}: ${JSON.stringify(row)}`)
        .filter((line) => ids.some((id) => line.includes(id)))
    )
  } finally {
    db.close()
  }
}

/** An epic with a canceled run (accepted work, a sprint report, an approved checkpoint, a retry grant), comments and a draft. */
async function busyEpic(agent: Workspace, desktop: Workspace): Promise<{ epicId: string; runId: string }> {
  const plan = await savedEpic(agent, 'Doomed', TWO_SPRINTS)
  const run = await agent.startRun({ epicId: plan.epicId })
  await deliver(agent, run.id, plan.ticket('first'))
  const sprintOne = (await agent.getPlan({ epicId: plan.epicId, view: 'saved' })).bundle.sprints[0]?.id ?? ''
  const report = await agent.submitSprintReport({ runId: run.id, sprintId: sprintOne, report: { summary: 'Sprint 1 done.' } })
  await desktop.approveAndAdvance({ runId: run.id, reportId: report.id })
  await agent.claimTicket({ runId: run.id, ticketId: plan.ticket('second'), worker: { label: 'worker-2' } })
  await desktop.grantRetry({ runId: run.id, ticketId: plan.ticket('second') })
  await agent.cancelRun({ runId: run.id, reason: 'Changed course' })
  await agent.addComment({ epicId: plan.epicId, body: 'Decision: drop this epic' })
  await agent.addComment({ epicId: plan.epicId, ticketId: plan.ticket('second'), body: 'Half done' })
  await desktop.updatePlanDraft({ epicId: plan.epicId, ops: [{ op: 'set_rationale', rationale: 'Unsaved thoughts' }] })
  return { epicId: plan.epicId, runId: run.id }
}

describe('deleteEpic', () => {
  it('removes every row and tracked file of the epic, leaves other epics alone, and stays gone after a reconcile', async () => {
    const agent = harness.open('orchestrator')
    const desktop = harness.open('desktop')
    await agent.initializeRepository({ name: 'delete-repo' })
    const keeper = await savedEpic(agent, 'Keeper', [{ op: 'add_ticket', ref: 'only', sprint: '1', ticket: { title: 'Only' } }])
    await agent.addComment({ epicId: keeper.epicId, body: 'Keep me' })
    const { epicId, runId } = await busyEpic(agent, desktop)
    expect(existsSync(dmPath('epics', epicId, 'comments'))).toBe(true)
    expect(existsSync(dmPath('history', runId, 'run.json'))).toBe(true)
    expect(rowsMentioning([epicId, runId]).length).toBeGreaterThan(20)
    const keeperRows = rowsMentioning([keeper.epicId])
    expect(keeperRows.filter((row) => row.startsWith('idempotency: '))).toHaveLength(1)

    const result = await desktop.deleteEpic({ epicId })

    expect(result).toEqual({
      epicId,
      title: 'Doomed',
      removedRuns: 1,
      removedPaths: [`.darkmechanicus/epics/${epicId}`, `.darkmechanicus/history/${runId}`]
    })
    expect(rowsMentioning([epicId, runId])).toEqual([])
    expect(rowsMentioning([keeper.epicId])).toEqual(keeperRows)
    expect(existsSync(dmPath('epics', epicId))).toBe(false)
    expect(existsSync(dmPath('history', runId))).toBe(false)
    expect(existsSync(dmPath('epics', keeper.epicId, 'current.json'))).toBe(true)
    expect((await desktop.reconcileRepository()).imported).toEqual([])
    expect((await desktop.listEpics()).map((epic) => epic.title)).toEqual(['Keeper'])
    expect((await desktop.listComments({ epicId: keeper.epicId })).map((comment) => comment.body)).toEqual(['Keep me'])
    expect(await codeOf(desktop.getEpic({ epicId }))).toBe('not_found')
  })

  it('logs the deletion without naming the deleted epic', async () => {
    const desktop = harness.open('desktop')
    await desktop.initializeRepository({ name: 'delete-repo' })
    const plan = await savedEpic(desktop, 'Short lived', [{ op: 'add_ticket', sprint: '1', ticket: { title: 'One' } }])
    await desktop.deleteEpic({ epicId: plan.epicId })
    const events = (await desktop.listEvents({})).events
    expect(events.filter((event) => event.epicId !== null)).toEqual([])
    expect(events.filter((event) => event.kind === 'epic.deleted').map((event) => [event.epicId, event.payload])).toEqual([
      [null, { title: 'Short lived', runs: 0 }]
    ])
  })
})

describe('deleteEpic of finished and unsaved epics', () => {
  it('deletes a completed epic and one that was never saved', async () => {
    const agent = harness.open('orchestrator')
    const desktop = harness.open('desktop')
    await agent.initializeRepository({ name: 'delete-repo' })
    const done = await savedEpic(agent, 'Done', [{ op: 'add_ticket', ref: 'only', sprint: '1', ticket: { title: 'Only' } }])
    const run = await agent.startRun({ epicId: done.epicId })
    await deliver(agent, run.id, done.ticket('only'))
    const sprint = (await agent.getRun({ runId: run.id }))?.activeSprintId ?? ''
    const criterion = (await agent.getEpic({ epicId: done.epicId })).successCriteria[0]?.id
    const report = await agent.submitSprintReport({
      runId: run.id,
      sprintId: sprint,
      report: {
        summary: 'All done.',
        epicOutcome: { summary: 'Delivered.', successCriteria: criterion ? [{ criterionId: criterion, met: true, note: 'ok' }] : [] }
      }
    })
    await desktop.approveAndAdvance({ runId: run.id, reportId: report.id })
    expect((await desktop.getEpic({ epicId: done.epicId })).status).toBe('completed')
    const draftOnly = await agent.createEpic({ title: 'Draft only' })

    expect((await desktop.deleteEpic({ epicId: done.epicId })).removedPaths).toHaveLength(2)
    expect((await desktop.deleteEpic({ epicId: draftOnly.id })).removedPaths).toEqual([])
    expect(await desktop.listEpics()).toEqual([])
  })
})

describe('deleteEpic refusals', () => {
  it('refuses while a run is active and changes nothing', async () => {
    const agent = harness.open('orchestrator')
    const desktop = harness.open('desktop')
    await agent.initializeRepository({ name: 'delete-repo' })
    const plan = await savedEpic(agent, 'Running', TWO_SPRINTS)
    const run = await agent.startRun({ epicId: plan.epicId })
    const rows = rowsMentioning([plan.epicId, run.id])

    const refused = desktop.deleteEpic({ epicId: plan.epicId })

    await expect(refused).rejects.toMatchObject({
      code: 'active_run_exists',
      message: 'Run #1 is active. Cancel it before deleting the epic.'
    })
    expect(rowsMentioning([plan.epicId, run.id])).toEqual(rows)
    expect(existsSync(dmPath('epics', plan.epicId, 'current.json'))).toBe(true)
    expect(existsSync(dmPath('history', run.id, 'run.json'))).toBe(true)
  })

  it('keeps every row when removing the files fails', async () => {
    const agent = harness.open('orchestrator')
    await agent.initializeRepository({ name: 'delete-repo' })
    const plan = await savedEpic(agent, 'Stuck', TWO_SPRINTS)
    const rows = rowsMentioning([plan.epicId])
    const desktop = harness.open('desktop', {
      fs: {
        ...nodeFs,
        removeDir: () => {
          throw new Error('EBUSY: resource busy or locked')
        }
      }
    })

    await expect(desktop.deleteEpic({ epicId: plan.epicId })).rejects.toThrow('EBUSY')
    expect(rowsMentioning([plan.epicId])).toEqual(rows)
    expect((await desktop.getEpic({ epicId: plan.epicId })).title).toBe('Stuck')
  })

  it('answers not_found for an unknown epic', async () => {
    const desktop = harness.open('desktop')
    await desktop.initializeRepository({ name: 'delete-repo' })
    expect(await codeOf(desktop.deleteEpic({ epicId: `${ID_PREFIXES.epic}_${encodeBase32(9n, 26)}` }))).toBe('not_found')
  })
})

describe('deleteTicket command', () => {
  it('saves the plan without the ticket and writes the new snapshot', async () => {
    const agent = harness.open('orchestrator')
    const desktop = harness.open('desktop')
    await agent.initializeRepository({ name: 'delete-repo' })
    const plan = await savedEpic(agent, 'Trim', TWO_SPRINTS)

    const result = await desktop.deleteTicket({ epicId: plan.epicId, ticketId: plan.ticket('first') })

    expect([result.status, result.revisionNumber, result.error]).toEqual(['saved', 2, null])
    expect(existsSync(dmPath('epics', plan.epicId, 'snapshots', `${result.revisionId}.json`))).toBe(true)
    const saved = await desktop.getPlan({ epicId: plan.epicId, view: 'saved' })
    expect([saved.revisionId, saved.bundle.tickets.map((ticket) => ticket.title), saved.bundle.edges]).toEqual([
      result.revisionId,
      ['Second'],
      []
    ])
    expect((await desktop.getEpic({ epicId: plan.epicId })).hasDraft).toBe(false)
  })
})
