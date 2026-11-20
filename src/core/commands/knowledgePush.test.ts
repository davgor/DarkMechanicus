import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PushedContext } from '../../shared/domain/knowledge'
import { dropAcceptanceNodes } from '../../test/acceptanceNodes'
import { issued } from '../../test/execution'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { encodeBase32, ID_PREFIXES } from '../ids'
import type { Workspace } from '../workspace'

const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

const EVENTS = [
  'run.started',
  'ticket.claimed',
  'acceptance.claimed',
  'attempt.accepted',
  'attempt.rejected',
  'attempt.failed',
  'row_check.failed',
  'sprint.reported',
  'checkpoint.approved',
  'kanban.claimed',
  'run.recovery'
]

let harness: Harness
let agent: Workspace

const knowledgeDir = (): string => join(harness.root, '.darkmechanicus', 'knowledge')

/** Writes a repository-layer fact; built-in facts are never asserted on, only facts these tests write. */
function writeFact(id: string, event: string, options: { paths?: string[]; priority?: number } = {}): void {
  mkdirSync(knowledgeDir(), { recursive: true })
  const lines = [
    '---',
    `id: ${id}`,
    'type: convention',
    `title: Fact ${id}`,
    'scope.roles: [orchestrator, worker]',
    `scope.events: [${event}]`,
    `scope.paths: [${(options.paths ?? []).join(', ')}]`,
    `priority: ${options.priority ?? 50}`,
    '---',
    '',
    `Body of ${id}.`
  ]
  writeFileSync(join(knowledgeDir(), `${id}.md`), `${lines.join('\n')}\n`)
}

/** The repository-layer facts a result pushed; throws when it carries no `context`. */
function pushed(result: PushedContext): string[] {
  const context = result.context
  if (context === undefined) throw new Error('The result carries no knowledge context.')
  return context.facts.filter((fact) => fact.layer === 'repo').map((fact) => fact.id)
}

const protocolFacts = (result: PushedContext): string[] =>
  (result.context?.facts ?? [])
    .filter((fact) => fact.layer === 'builtin' && (
      fact.id === 'orchestrator.final-validation-ci' || fact.id === 'orchestrator.post-checkpoint-delivery'
    ))
    .map((fact) => fact.id)

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error: unknown) {
    return (error as { code?: string }).code ?? 'thrown'
  }
}

interface Planned {
  epicId: string
  sprintOne: string
  ticket(ref: string): string
}

/** Sprint 1: `first` (a file reference under src/push) and `other`; sprint 2: `next`. No acceptance nodes. */
async function planned(): Promise<Planned> {
  const epic = await agent.createEpic({ title: 'Push epic' })
  const start = await dropAcceptanceNodes(agent, epic.id)
  const draft = await agent.updatePlanDraft({
    epicId: epic.id,
    expectedDraftRevision: start,
    ops: [
      { op: 'add_sprint', ref: 's2', sprint: { goal: 'Later' } },
      {
        op: 'add_ticket',
        ref: 'first',
        sprint: '1',
        ticket: {
          title: 'First',
          references: [{ kind: 'file', label: 'Code', location: 'src/push/a.ts', hash: null, remoteOnly: false }]
        }
      },
      { op: 'add_ticket', ref: 'other', sprint: '1', ticket: { title: 'Other' } },
      { op: 'add_ticket', ref: 'next', sprint: 's2', ticket: { title: 'Next' } }
    ]
  })
  const last = await dropAcceptanceNodes(agent, epic.id)
  await agent.savePlan({ epicId: epic.id, expectedDraftRevision: last })
  const saved = await agent.getPlan({ epicId: epic.id, view: 'saved' })
  return { epicId: epic.id, sprintOne: saved.bundle.sprints[0]?.id ?? '', ticket: (ref) => draft.refMap[ref] ?? '' }
}

beforeEach(async () => {
  harness = createHarness()
  agent = harness.open('orchestrator')
  await agent.initializeRepository({ name: 'push-repo' })
  // Fact ids allow no underscore, so `row_check.failed` gets `repo.row-check.failed`.
  for (const event of EVENTS) writeFact(`repo.${event.replace('_', '-')}`, event)
})

afterEach(() => {
  harness.cleanup()
})

describe('knowledge pushed with run and attempt commands', () => {
  it('start_run, claim_ticket, accept_attempt, reject_attempt and fail_attempt push their event to an orchestrator', async () => {
    const plan = await planned()
    const run = await agent.startRun({ epicId: plan.epicId })
    expect(pushed(run)).toEqual(['repo.run.started'])
    expect(protocolFacts(run)).toEqual([])

    const claim = await agent.claimTicket({ runId: run.id, ticketId: plan.ticket('first'), worker: { label: 'w' } })
    expect(pushed(claim)).toEqual(['repo.ticket.claimed'])
    const claimToken = claim.packet.claimToken ?? ''
    expect(JSON.stringify(claim.context)).not.toContain(claimToken)

    await agent.submitAttempt({ attemptId: claim.attempt.id, claimToken, outputs: { summary: 'v1' } })
    expect(pushed(await agent.rejectAttempt({ attemptId: claim.attempt.id, reasons: ['Not yet.'] }))).toEqual(['repo.attempt.rejected'])

    const retry = issued(await agent.claimTicket({ runId: run.id, ticketId: plan.ticket('first'), worker: { label: 'w' } }))
    await agent.submitAttempt({ attemptId: retry.attempt.id, claimToken: retry.packet.claimToken, outputs: { summary: 'v2' } })
    expect(pushed(await agent.acceptAttempt({ attemptId: retry.attempt.id }))).toEqual(['repo.attempt.accepted'])

    const other = issued(await agent.claimTicket({ runId: run.id, ticketId: plan.ticket('other'), worker: { label: 'w' } }))
    const failed = await agent.failAttempt({ attemptId: other.attempt.id, failure: { reason: 'Blocked.' } })
    expect(pushed(failed)).toEqual(['repo.attempt.failed'])
  })
})

describe('knowledge pushed with ticket claims', () => {
  it('ranks the facts scoped to a claimed ticket\'s file references first', async () => {
    writeFact('repo.a-plain', 'ticket.claimed', { priority: 90 })
    writeFact('repo.z-path', 'ticket.claimed', { priority: 10, paths: ['src/push/**'] })
    const plan = await planned()
    const run = await agent.startRun({ epicId: plan.epicId })
    const claim = await agent.claimTicket({ runId: run.id, ticketId: plan.ticket('first'), worker: { label: 'w' } })
    expect(pushed(claim)).toEqual(['repo.z-path', 'repo.a-plain', 'repo.ticket.claimed'])
  })

  it('claim_ticket pushes acceptance.claimed for a sprint acceptance node', async () => {
    const epic = await agent.createEpic({ title: 'Node epic' })
    const draft = await agent.updatePlanDraft({
      epicId: epic.id,
      ops: [{ op: 'add_ticket', ref: 'work', sprint: '1', ticket: { title: 'Work' } }]
    })
    await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
    const saved = await agent.getPlan({ epicId: epic.id, view: 'saved' })
    const node = saved.bundle.tickets.find((ticket) => ticket.kind === 'acceptance')?.id ?? ''
    const run = await agent.startRun({ epicId: epic.id })
    const work = issued(await agent.claimTicket({ runId: run.id, ticketId: draft.refMap.work ?? '', worker: { label: 'w' } }))
    await agent.submitAttempt({ attemptId: work.attempt.id, claimToken: work.packet.claimToken, outputs: { summary: 'done' } })
    await agent.acceptAttempt({ attemptId: work.attempt.id })
    const claim = await agent.claimTicket({ runId: run.id, ticketId: node, worker: { label: 'w' } })
    expect(protocolFacts(claim)).toEqual(['orchestrator.final-validation-ci'])
    expect(pushed(claim)).toEqual(['repo.acceptance.claimed'])
  })

  it('record_row_check pushes row_check.failed only for a check that did not pass', async () => {
    const plan = await planned()
    const run = await agent.startRun({ epicId: plan.epicId })
    const check = { runId: run.id, sprintId: plan.sprintOne, row: 1, commit: COMMIT }
    const failed = await agent.recordRowCheck({ ...check, checks: [{ name: 'tests', status: 'failed', detail: '2 failed' }] })
    expect(pushed(failed)).toEqual(['repo.row-check.failed'])
    const passed = await agent.recordRowCheck({ ...check, checks: [{ name: 'tests', status: 'passed' }] })
    expect(passed.context).toBeUndefined()
  })

})

describe('knowledge pushed with recovery', () => {
  it('takeover_run and adopt_revision push run.recovery', async () => {
    const plan = await planned()
    const run = await agent.startRun({ epicId: plan.epicId })
    const recovered = await agent.takeoverRun({ runId: run.id })
    expect(pushed(recovered)).toEqual(['repo.run.recovery'])
    expect(protocolFacts(recovered)).toEqual([
      'orchestrator.final-validation-ci', 'orchestrator.post-checkpoint-delivery'
    ])
    await agent.pauseRun({ runId: run.id })

    const draft = await agent.updatePlanDraft({
      epicId: plan.epicId,
      ops: [{ op: 'add_ticket', ref: 'extra', sprint: '1', ticket: { title: 'Extra' } }]
    })
    const saved = await agent.savePlan({ epicId: plan.epicId, expectedDraftRevision: draft.draftRevision })
    expect(pushed(await agent.adoptRevision({ reason: 'Test adoption: the plan changed mid-run.', runId: run.id, revisionId: saved.revisionId }))).toEqual(['repo.run.recovery'])
  })
})

describe('knowledge pushed with checkpoint and kanban commands', () => {
  it('submit_sprint_report pushes sprint.reported and advance_sprint pushes checkpoint.approved', async () => {
    const plan = await planned()
    const run = await agent.startRun({ epicId: plan.epicId })
    for (const ref of ['first', 'other']) {
      const claim = issued(await agent.claimTicket({ runId: run.id, ticketId: plan.ticket(ref), worker: { label: 'w' } }))
      await agent.submitAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken, outputs: { summary: 'done' } })
      await agent.acceptAttempt({ attemptId: claim.attempt.id })
    }
    const report = await agent.submitSprintReport({ runId: run.id, sprintId: plan.sprintOne, report: { summary: 'Done.' } })
    expect(protocolFacts(report)).toEqual([])
    expect(pushed(report)).toEqual(['repo.sprint.reported'])
    await harness.open('desktop').approveCheckpoint({ runId: run.id, reportId: report.id })
    const advanced = await agent.advanceSprint({ runId: run.id })
    expect(pushed(advanced)).toEqual(['repo.checkpoint.approved'])
    expect(protocolFacts(advanced)).toEqual(['orchestrator.post-checkpoint-delivery'])
  })

  it('claim_kanban_card pushes kanban.claimed', async () => {
    const desktop = harness.open('desktop')
    const card = await desktop.createKanbanCard({ title: 'Isolated fix' })
    await desktop.playKanbanCard({ cardId: card.id })
    const packet = await agent.claimKanbanCard({ cardId: card.id })
    expect(pushed(packet)).toEqual(['repo.kanban.claimed'])
    expect(JSON.stringify(packet.context)).not.toContain(packet.claimToken ?? '')
  })
})

describe('knowledge is pushed to orchestrators only', () => {
  it('gives a worker no context on fail_attempt, the one table command its role may run', async () => {
    const plan = await planned()
    const run = await agent.startRun({ epicId: plan.epicId })
    const claim = issued(await agent.claimTicket({ runId: run.id, ticketId: plan.ticket('first'), worker: { label: 'w' } }))
    const worker = harness.open('worker')
    const failed = await worker.failAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken, failure: { reason: 'Stuck.' } })
    expect(failed.state).toBe('failed')
    expect(failed.context).toBeUndefined()
  })

  it('refuses a worker every other table command, so none of them can push context to it', async () => {
    const worker = harness.open('worker')
    const id = (kind: keyof typeof ID_PREFIXES): string => `${ID_PREFIXES[kind]}_${encodeBase32(7n, 26)}`
    const [run, attempt, sprint] = [id('run'), id('attempt'), id('sprint')]
    const calls: (() => Promise<unknown>)[] = [
      () => worker.startRun({ epicId: id('epic') }),
      () => worker.claimTicket({ runId: run, ticketId: id('ticket'), worker: { label: 'w' } }),
      () => worker.acceptAttempt({ attemptId: attempt }),
      () => worker.rejectAttempt({ attemptId: attempt, reasons: ['x'] }),
      () => worker.recordRowCheck({ runId: run, sprintId: sprint, row: 1, commit: COMMIT, checks: [{ name: 't', status: 'failed' }] }),
      () => worker.submitSprintReport({ runId: run, sprintId: sprint, report: { summary: 'x' } }),
      () => worker.advanceSprint({ runId: run }),
      () => worker.claimKanbanCard({ cardId: id('kanbanCard') }),
      () => worker.takeoverRun({ runId: run }),
      () => worker.adoptRevision({ reason: 'Test adoption: the plan changed mid-run.', runId: run, revisionId: id('revision') })
    ]
    for (const call of calls) expect(await codeOf(call())).toBe('unauthorized')
  })
})
