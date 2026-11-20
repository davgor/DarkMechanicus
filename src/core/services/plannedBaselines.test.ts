/**
 * DM-171 c3: planned budgets are draft fields frozen by saving a revision (server time, append-only versions) and
 * pinned for a run at dispatch; a late edit is a prospective version, never a retroactive raise.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlannedBudgetView } from '../../shared/domain/metrics'
import { metricsWorld, type MetricsWorld, usage } from '../../test/metricsWorld'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { dropAcceptanceNodes } from '../../test/acceptanceNodes'
import type { Workspace } from '../workspace'
import { budgetBaselineEpic } from './plannedBaselines'

const SAVED_AT = '2026-03-01T10:00:00.000Z'
/** Run started 10:01; alpha claimed 10:02, done 10:03; the late edit at 10:13 and its save at 10:14. */
const ALPHA_DISPATCHED = '2026-03-01T10:02:00.000Z'
const LATE_SAVED_AT = '2026-03-01T10:14:00.000Z'

let harness: Harness
let w: MetricsWorld
let reader: Workspace

beforeEach(async () => {
  harness = createHarness()
  w = await metricsWorld(
    harness,
    {
      alpha: {
        title: 'Alpha',
        budget: { tokens: 200_000, activeMs: 3_600_000 }
      },
      beta: { title: 'Beta', budget: { tokens: 50_000 } },
      gamma: { title: 'Gamma' },
      done: { title: 'Done early', budget: { tokens: 10_000 } }
    },
    ['alpha', 'done']
  )
  const done = w.attempt.done ?? { id: '', token: '' }
  await w.orchestrator.submitAttempt({
    attemptId: done.id,
    claimToken: done.token,
    outputs: { summary: 'done' }
  })
  await w.orchestrator.acceptAttempt({ attemptId: done.id })
  reader = harness.open('reader')
})

afterEach(() => {
  harness.cleanup()
})

async function budget(ref: string, metric = 'tokens', withRun = true): Promise<PlannedBudgetView | undefined> {
  const view = await reader.getPlannedBaselines(withRun ? { epicId: w.epicId, runId: w.runId } : { epicId: w.epicId })
  return view.tickets.find((item) => item.ticketId === w.ticket[ref])?.budgets.find((item) => item.metric === metric)
}

/** Raises alpha, beta and done and budgets gamma's time in the draft at 10:13; returns the new draft revision. */
async function lateEdit(): Promise<number> {
  harness.clock.advanceSeconds(600)
  const edit = await w.orchestrator.updatePlanDraft({
    epicId: w.epicId,
    ops: [
      {
        op: 'update_ticket',
        ticket: w.ticket.alpha ?? '',
        patch: { budget: { tokens: 600_000, activeMs: 3_600_000 } }
      },
      {
        op: 'update_ticket',
        ticket: w.ticket.beta ?? '',
        patch: { budget: { tokens: 80_000 } }
      },
      {
        op: 'update_ticket',
        ticket: w.ticket.gamma ?? '',
        patch: { budget: { activeMs: 900_000 } }
      },
      {
        op: 'update_ticket',
        ticket: w.ticket.done ?? '',
        patch: { budget: { tokens: 99_000 } }
      }
    ]
  })
  return edit.draftRevision
}

/** The late edit, saved at 10:14; returns the saved revision id. */
async function lateSave(): Promise<string> {
  const draftRevision = await lateEdit()
  harness.clock.advanceSeconds(60)
  return (
    await w.orchestrator.savePlan({
      epicId: w.epicId,
      expectedDraftRevision: draftRevision
    })
  ).revisionId
}

/**
 * A one-ticket plan (20,000 token budget) saved at `savedAt`, then a run started and the ticket claimed at
 * `dispatchedAt`, in a harness of its own; answers the ticket's token budget read against the run.
 */
async function budgetDispatchedAt(savedAt: string, dispatchedAt: string): Promise<PlannedBudgetView | undefined> {
  const own = createHarness()
  try {
    const agent = own.open('orchestrator')
    await agent.initializeRepository({ name: 'boundary-repo' })
    const epic = await agent.createEpic({ title: 'Boundary' })
    await dropAcceptanceNodes(agent, epic.id)
    const draft = await agent.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'add_ticket', ref: 't', sprint: '1', ticket: { title: 'T', budget: { tokens: 20_000 } } }] })
    own.clock.set(savedAt)
    await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
    own.clock.set(dispatchedAt)
    const run = await agent.startRun({ epicId: epic.id })
    await agent.claimTicket({ runId: run.id, ticketId: draft.refMap.t ?? '', worker: { label: 'worker-t' } })
    const view = await agent.getPlannedBaselines({ epicId: epic.id, runId: run.id })
    return view.tickets[0]?.budgets.find((item) => item.metric === 'tokens')
  } finally {
    own.cleanup()
  }
}

describe('DM-171 c3: a budget applies only when frozen strictly before dispatch', () => {
  it('a budget frozen at the same millisecond as the dispatch does not apply: none, with the version still listed', async () => {
    const tokens = await budgetDispatchedAt('2026-03-01T11:00:00.000Z', '2026-03-01T11:00:00.000Z')
    expect([tokens?.state, tokens?.applied]).toEqual(['none', null])
    expect(tokens?.versions.map((item) => [item.version, item.value, item.frozenAt, item.status])).toEqual([[1, 20_000, '2026-03-01T11:00:00.000Z', 'pinned']])
  })

  it('a budget frozen one millisecond before the dispatch applies, frozen', async () => {
    const tokens = await budgetDispatchedAt('2026-03-01T10:59:59.999Z', '2026-03-01T11:00:00.000Z')
    expect([tokens?.state, tokens?.applied?.value, tokens?.applied?.frozenAt]).toEqual(['frozen', 20_000, '2026-03-01T10:59:59.999Z'])
  })
})

describe('DM-171 c3: saved budgets are frozen by the server and pinned at dispatch', () => {
  it('a dispatched ticket’s saved budget is frozen at the server save time, strictly before its dispatch', async () => {
    const view = await reader.getPlannedBaselines({
      epicId: w.epicId,
      runId: w.runId
    })
    const alpha = view.tickets.find((item) => item.ticketId === w.ticket.alpha)
    expect(alpha?.dispatchedAt).toBe(ALPHA_DISPATCHED)
    expect(alpha?.budgets.find((item) => item.metric === 'tokens')).toMatchObject({
      state: 'frozen',
      applied: {
        kind: 'budget',
        value: 200_000,
        unit: 'tokens',
        version: 1,
        frozenAt: SAVED_AT
      }
    })
  })

  it('active time has its own budget in milliseconds', async () => {
    const active = await budget('alpha', 'active_ms')
    expect([active?.applied?.unit, active?.applied?.value]).toEqual(['milliseconds', 3_600_000])
  })

  it('an undispatched ticket shows the budget it would get, as planned', async () => {
    const beta = await budget('beta')
    expect([beta?.state, beta?.applied?.value]).toEqual(['planned', 50_000])
  })

  it('a ticket without a budget has none: no applied baseline and no versions, never zero', async () => {
    const gamma = await budget('gamma')
    expect([gamma?.state, gamma?.applied, gamma?.versions]).toEqual(['none', null, []])
  })

  it('a caller cannot supply a freeze time with a budget', async () => {
    const patch = {
      budget: { tokens: 1, frozenAt: '2020-01-01T00:00:00.000Z' }
    }
    await expect(
      w.orchestrator.updatePlanDraft({
        epicId: w.epicId,
        ops: [{ op: 'update_ticket', ticket: w.ticket.alpha ?? '', patch } as never]
      })
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('DM-171 c3: budget edits participate in the draft', () => {
  it('the draft diff names each budget change with its unit', async () => {
    await lateEdit()
    const draft = await w.orchestrator.getPlan({
      epicId: w.epicId,
      view: 'draft'
    })
    const details = draft.changes.map((change) => change.detail)
    expect(details.some((text) => text.includes('token budget 200000 tokens → 600000 tokens'))).toBe(true)
  })

  it('an unsaved edit is only a draft value; the applied budget is unchanged', async () => {
    await lateEdit()
    const alpha = await budget('alpha')
    expect([alpha?.draft, alpha?.applied?.value, alpha?.versions.length]).toEqual([{ value: 600_000, basis: null }, 200_000, 1])
    expect((await budget('alpha', 'active_ms'))?.draft).toBeNull()
  })
})

describe('DM-171 c3: a late save is a prospective version, not a retroactive raise', () => {
  it('the raise mid-run is version 2, prospective, frozen at its own save; dispatched alpha keeps 200,000', async () => {
    const revisionId = await lateSave()
    const alpha = await budget('alpha')
    expect(alpha?.applied?.value).toBe(200_000)
    expect(alpha?.versions.map((item) => [item.version, item.value, item.status, item.frozenAt, item.revisionId === revisionId])).toEqual([
      [1, 200_000, 'pinned', SAVED_AT, false],
      [2, 600_000, 'prospective', LATE_SAVED_AT, true]
    ])
    expect(alpha?.draft).toBeNull()
  })

  it('versions are append-only: version 1 keeps its baseline id after the late save', async () => {
    const before = await budget('alpha')
    await lateSave()
    const after = await budget('alpha')
    expect(after?.versions[0]?.baselineId).toBe(before?.applied?.baselineId)
    expect(after?.versions[1]?.baselineId).not.toBe(before?.applied?.baselineId)
  })

  it('an unchanged budget adds no version', async () => {
    await lateSave()
    expect((await budget('alpha', 'active_ms'))?.versions.map((item) => item.version)).toEqual([1])
  })

  it('accepted work keeps the budget it was dispatched under', async () => {
    await lateSave()
    const done = await budget('done')
    expect([done?.state, done?.applied?.value, done?.versions.map((item) => item.status)]).toEqual(['frozen', 10_000, ['pinned', 'prospective']])
  })

  it('without adoption the run stays on its revision: beta is still planned at 50,000', async () => {
    await lateSave()
    const beta = await budget('beta')
    expect([beta?.state, beta?.applied?.value]).toEqual(['planned', 50_000])
  })

  it('the epic view without a run shows the current revision’s 600,000 as planned', async () => {
    await lateSave()
    const current = await budget('alpha', 'tokens', false)
    expect([current?.state, current?.applied?.value, current?.applied?.version]).toEqual(['planned', 600_000, 2])
  })
})

describe('DM-171 c3: adopting the revision moves only undispatched tickets', () => {
  async function adoptLateSave(): Promise<string> {
    const revisionId = await lateSave()
    const alpha = w.attempt.alpha ?? { id: '', token: '' }
    await w.orchestrator.failAttempt({
      attemptId: alpha.id,
      claimToken: alpha.token,
      failure: { reason: 'retry' }
    })
    await w.orchestrator.pauseRun({ runId: w.runId })
    await w.orchestrator.adoptRevision({ reason: 'Test adoption: the plan changed mid-run.', runId: w.runId, revisionId })
    await w.orchestrator.resumeRun({ runId: w.runId })
    return revisionId
  }

  it('undispatched beta plans on the adopted version 2, and is frozen at it when claimed', async () => {
    await adoptLateSave()
    const planned = await budget('beta')
    expect([planned?.state, planned?.applied?.value]).toEqual(['planned', 80_000])
    harness.clock.advanceSeconds(60)
    await w.orchestrator.claimTicket({
      runId: w.runId,
      ticketId: w.ticket.beta ?? '',
      worker: { label: 'worker-beta' }
    })
    const frozen = await budget('beta')
    expect([frozen?.state, frozen?.applied?.value, frozen?.applied?.version]).toEqual(['frozen', 80_000, 2])
  })

  it('a retry claimed under the adopted revision still uses the first dispatch’s 200,000', async () => {
    const revisionId = await adoptLateSave()
    harness.clock.advanceSeconds(60)
    const retry = await w.orchestrator.claimTicket({
      runId: w.runId,
      ticketId: w.ticket.alpha ?? '',
      worker: { label: 'worker-alpha-2' }
    })
    const alpha = await budget('alpha')
    expect(retry.attempt.revisionId).toBe(revisionId)
    expect([alpha?.state, alpha?.applied?.value, alpha?.applied?.version]).toEqual(['frozen', 200_000, 1])
  })
})

describe('DM-171 c3: versions travel with the saved plan snapshots', () => {
  it('a clone derives the same baseline ids, versions and freeze times', async () => {
    await lateSave()
    const ids = (view: PlannedBudgetView | undefined) => view?.versions.map((item) => [item.baselineId, item.version, item.value, item.frozenAt])
    const here = await budget('alpha', 'tokens', false)
    const clone = harness.open('reader', { root: harness.cloneTracked() })
    const there = (await clone.getPlannedBaselines({ epicId: w.epicId })).tickets
      .find((item) => item.ticketId === w.ticket.alpha)
      ?.budgets.find((item) => item.metric === 'tokens')
    expect(ids(there)).toEqual(ids(here))
    expect(there?.versions).toHaveLength(2)
  })
})

describe('DM-171 c3: metric evidence can cite a frozen budget version', () => {
  it('an observation citing alpha’s budget version is stored; an unknown baseline id is not_found', async () => {
    const baselineId = (await budget('alpha'))?.applied?.baselineId ?? ''
    const alpha = w.attempt.alpha ?? { id: '', token: '' }
    const worker = harness.open('worker')
    const cited = await worker.recordAttemptMetrics({
      attemptId: alpha.id,
      claimToken: alpha.token,
      reports: [
        usage({
          eventId: 'cite-1',
          evidence: [{ kind: 'baseline', id: baselineId, detail: null }]
        })
      ]
    })
    expect(cited.observations[0]?.evidence).toEqual([{ kind: 'baseline', id: baselineId, detail: null }])
    const unknown = usage({
      eventId: 'cite-2',
      evidence: [{ kind: 'baseline', id: 'bl_00000000000000000000000000', detail: null }]
    })
    await expect(
      worker.recordAttemptMetrics({
        attemptId: alpha.id,
        claimToken: alpha.token,
        reports: [unknown]
      })
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a baseline id resolves to its epic, and one introduced by a later save resolves after it', async () => {
    const db = w.orchestrator.ctx().db
    const first = (await budget('alpha'))?.applied?.baselineId ?? ''
    expect(budgetBaselineEpic(db, first)).toBe(w.epicId)
    expect(budgetBaselineEpic(db, 'bl_00000000000000000000000000')).toBeUndefined()
    await lateSave()
    const second = (await budget('alpha', 'tokens', false))?.applied?.baselineId ?? ''
    expect(budgetBaselineEpic(db, second)).toBe(w.epicId)
  })
})

describe('DM-171 c3: the run named must belong to the epic', () => {
  it('a run of another epic is refused as invalid_input', async () => {
    const other = await w.orchestrator.createEpic({ title: 'Other' })
    const draft = await w.orchestrator.updatePlanDraft({
      epicId: other.id,
      ops: [
        {
          op: 'add_ticket',
          ref: 'x',
          sprint: '1',
          ticket: { title: 'X', budget: { tokens: 5 } }
        }
      ]
    })
    await w.orchestrator.savePlan({
      epicId: other.id,
      expectedDraftRevision: draft.draftRevision
    })
    await expect(reader.getPlannedBaselines({ epicId: other.id, runId: w.runId })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('an epic with no saved plan has no planned budgets: not_found, naming the epic', async () => {
    const unplanned = await w.orchestrator.createEpic({ title: 'Never planned' })
    await expect(reader.getPlannedBaselines({ epicId: unplanned.id })).rejects.toMatchObject({
      code: 'not_found',
      message: `Epic ${unplanned.id} has no saved plan, so it has no planned budgets yet.`
    })
  })
})
