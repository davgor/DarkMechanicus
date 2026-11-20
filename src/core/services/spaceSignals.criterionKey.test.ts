// DM-177 (pinned by DM-269): a committed criterion is the same deliverable when only its casing or spacing changed;
// substantive rewording is new scope; every undelivered committed item says why.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Workspace } from '../workspace'
import type { TicketInput } from '../../shared/domain/api'
import type { GetSpaceSignalsInput, ScopeItem, SpaceSignalsView } from '../../shared/domain/spaceSignals'
import { dropAcceptanceNodes } from '../../test/acceptanceNodes'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { getSpaceSignals } from './spaceSignals'

const TICKETS: Record<string, TicketInput> = {
  alpha: { title: 'Alpha', acceptanceCriteria: [{ id: 'c1', text: 'Parses input' }, { id: 'c2', text: 'Writes output' }] },
  beta: { title: 'Beta', acceptanceCriteria: [{ id: 'c1', text: 'Beta works' }] },
  gamma: { title: 'Gamma', acceptanceCriteria: [{ id: 'c1', text: 'Gamma works' }] },
  delta: { title: 'Delta', acceptanceCriteria: [{ id: 'c1', text: 'Delta works' }] }
}

interface Scene {
  api: Workspace
  epicId: string
  runId: string
  sprintId: string
  ids: Record<string, string>
}

let harness: Harness

beforeEach(() => {
  harness = createHarness()
})

afterEach(() => {
  harness.cleanup()
})

const step = (): void => harness.clock.advanceSeconds(60)

async function setup(): Promise<Scene> {
  const api = harness.open('orchestrator')
  await api.initializeRepository({ name: 'criterion-key' })
  const epic = await api.createEpic({ title: 'Criterion key' })
  await dropAcceptanceNodes(api, epic.id)
  const ops = Object.entries(TICKETS).map(([ref, ticket]) => ({ op: 'add_ticket' as const, ref, sprint: '1', ticket }))
  const draft = await api.updatePlanDraft({ epicId: epic.id, ops })
  await api.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  const sprintId = (await api.getPlan({ epicId: epic.id, view: 'saved' })).bundle.sprints[0]?.id ?? ''
  step()
  const run = await api.startRun({ epicId: epic.id })
  return { api, epicId: epic.id, runId: run.id, sprintId, ids: draft.refMap }
}

/** Claims and submits `ref`; returns the attempt id. */
async function submit(s: Scene, ref: string, criteria: string[]): Promise<string> {
  step()
  const claimed = await s.api.claimTicket({ runId: s.runId, ticketId: s.ids[ref] ?? '', worker: { label: `worker-${ref}` } })
  step()
  await s.api.submitAttempt({
    attemptId: claimed.attempt.id,
    claimToken: claimed.packet.claimToken ?? '',
    outputs: { summary: 'done', commits: ['abc1234'], branch: 'work' },
    evidence: { checks: [{ name: 'npm run typecheck', status: 'passed', detail: 'exit 0' }], criteria: criteria.map((criterionId) => ({ criterionId, met: true, note: 'shown' })), notes: '' }
  })
  step()
  return claimed.attempt.id
}

async function deliver(s: Scene, ref: string, review: Record<string, boolean>): Promise<void> {
  const attemptId = await submit(s, ref, Object.keys(review))
  const criteria = Object.entries(review).map(([criterionId, met]) => ({ criterionId, met, note: met ? 'ok' : 'fails offline' }))
  await s.api.acceptAttempt({ attemptId, criteria })
}

/**
 * Alpha is dispatched (freezing the sprint scope) and rejected; then alpha's criteria change only in casing and
 * spacing and beta's c1 is reworded, saved and adopted mid-run. Alpha and beta are then accepted with every criterion
 * met, gamma with c1 unmet; delta is never worked.
 */
async function replannedRun(): Promise<{ read: (input: Omit<GetSpaceSignalsInput, 'runId'>) => SpaceSignalsView; s: Scene }> {
  const s = await setup()
  await s.api.rejectAttempt({ attemptId: await submit(s, 'alpha', ['c1', 'c2']), reasons: ['tidy the criteria'] })
  step()
  await s.api.pauseRun({ runId: s.runId, reason: 'replan' })
  const edited = await s.api.updatePlanDraft({
    epicId: s.epicId,
    ops: [
      { op: 'update_ticket', ticket: s.ids.alpha ?? '', patch: { acceptanceCriteria: [{ id: 'c1', text: '  parses   INPUT' }, { id: 'c2', text: 'Writes\toutput ' }] } },
      { op: 'update_ticket', ticket: s.ids.beta ?? '', patch: { acceptanceCriteria: [{ id: 'c1', text: 'Beta works offline too' }] } }
    ]
  })
  const saved = await s.api.savePlan({ epicId: s.epicId, expectedDraftRevision: edited.draftRevision })
  step()
  await s.api.adoptRevision({ reason: 'Test adoption: the plan changed mid-run.', runId: s.runId, revisionId: saved.revisionId })
  await s.api.resumeRun({ runId: s.runId })
  await deliver(s, 'alpha', { c1: true, c2: true })
  await deliver(s, 'beta', { c1: true })
  await deliver(s, 'gamma', { c1: false })
  return { s, read: (input) => getSpaceSignals(s.api.ctx(), { runId: s.runId, ...input }) }
}

describe('DM-177 criterionKey: casing/spacing edits keep a criterion, rewording changes it', () => {
  it('at sprint level only alpha (casing/spacing edit) is delivered, and each undelivered item says why', async () => {
    const { s, read } = await replannedRun()
    const sprint = read({ level: 'sprint', id: s.sprintId })
    const reason = (ref: string): ScopeItem['undelivered'] | undefined => sprint.A.committed.find((entry) => entry.id === s.ids[ref])?.undelivered
    expect(sprint.A.committed.find((entry) => entry.id === s.ids.alpha)?.delivered).toBe(true)
    expect(reason('alpha')).toBeNull()
    expect(reason('beta')).toEqual({ reason: 'criteria_unverified', criteria: [{ criterionId: 'c1', cause: 'changed' }] })
    expect(reason('gamma')).toEqual({ reason: 'criteria_unverified', criteria: [{ criterionId: 'c1', cause: 'not_met' }] })
    expect(reason('delta')).toEqual({ reason: 'not_accepted', criteria: [] })
    expect([sprint.A.input.delivered, sprint.A.input.committed]).toEqual([1, 4])
  })

  it('at ticket level alpha delivers both criteria with no added or removed scope; beta’s rewording is added and removed', async () => {
    const { s, read } = await replannedRun()
    const alpha = read({ level: 'ticket', id: s.ids.alpha ?? '' })
    expect(alpha.A.committed.map((entry) => entry.label)).toEqual(['Parses input', 'Writes output'])
    expect(alpha.A.input).toMatchObject({ committed: 2, delivered: 2, added: 0, removed: 0 })
    const beta = read({ level: 'ticket', id: s.ids.beta ?? '' })
    expect(beta.A.input).toMatchObject({ committed: 1, delivered: 0, added: 1, removed: 1 })
    expect(beta.A.committed[0]?.undelivered).toEqual({ reason: 'criteria_unverified', criteria: [{ criterionId: 'c1', cause: 'changed' }] })
  })
})
