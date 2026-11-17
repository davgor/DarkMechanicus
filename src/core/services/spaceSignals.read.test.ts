/**
 * DM-174: the S, A and C read (`getSpaceSignals`) on what it is asked and on records as stored: refused subjects and
 * cutoffs, where a person's entry was recorded, the scope of a ticket added or removed after its sprint froze, and
 * handoff checks, decisions and refusals read as another machine may have stored them.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { HumanFeedbackEntry } from '../../shared/domain/spaceSignals'
import { domainErrorOf } from '../../test/repoFixtures'
import { type Claimed, type SignalsWorld, signalsWorld } from '../../test/spaceSignalsWorld'
import { appendEvent } from './events'
import { recordHumanFeedback } from './humanFeedback'

const worlds: SignalsWorld[] = []

async function open(...args: Parameters<typeof signalsWorld>): Promise<SignalsWorld> {
  const w = await signalsWorld(...args)
  worlds.push(w)
  return w
}

afterEach(() => {
  for (const w of worlds.splice(0)) w.close()
})

const UNKNOWN_EPIC = 'ep_01m7gg00000000000000000099'

describe('getSpaceSignals: refused subjects and cutoffs', () => {
  it('refuses a cutoff that is not a time as invalid_input', async () => {
    const w = await open({ one: { title: 'One' } })
    expect(domainErrorOf(() => w.signals({ level: 'run', id: w.runId, cutoff: 'soon' }))).toMatchObject({ code: 'invalid_input', details: { cutoff: 'soon' } })
  })

  it('refuses an unknown epic, and an epic with no saved plan, as not_found', async () => {
    const w = await open({ one: { title: 'One' } })
    const unplanned = await w.orchestrator.createEpic({ title: 'Never planned' })
    expect(domainErrorOf(() => w.signals({ level: 'epic', id: UNKNOWN_EPIC }))).toMatchObject({ code: 'not_found', details: { epicId: UNKNOWN_EPIC } })
    expect(domainErrorOf(() => w.signals({ level: 'epic', id: unplanned.id }))).toMatchObject({ code: 'not_found', message: `Epic ${unplanned.id} has no saved plan.` })
  })

  it('refuses a ticket the run neither ran nor plans as not_found', async () => {
    const w = await open({ one: { title: 'One' } })
    const ticketId = 'tk_01m7gg00000000000000000099'
    expect(domainErrorOf(() => w.signals({ level: 'ticket', id: ticketId }))).toMatchObject({ code: 'not_found', details: { ticketId } })
  })
})

describe('getSpaceSignals: where a person’s entry was recorded', () => {
  /** A sprint rating whose stored record `edit` (a SQLite JSON expression over `observation_json`) rewrote, as read back. */
  async function ratedThenEdited(edit: string): Promise<HumanFeedbackEntry | undefined> {
    const w = await open({ one: { title: 'One' } })
    const rating = recordHumanFeedback(w.desktop.ctx(), { target: { epicId: w.epicId, sprintId: w.sprintId }, feedback: { kind: 'rating', value: 4, sharedWithTickets: true } })
    w.orchestrator.ctx().db.run(`UPDATE metric_observations SET observation_json = ${edit} WHERE id = ?`, rating.observationId)
    return w.signals({ level: 'sprint', id: w.sprintId }).S.ratings[0]
  }

  it.each([
    ['no desktop session', "json_remove(observation_json, '$.attributes.desktopSession')"],
    ['no machine', "json_remove(observation_json, '$.attributes.machine')"]
  ])('reads an entry that names %s as unattested', async (_label, edit) => {
    expect((await ratedThenEdited(edit))?.recordedBy.origin).toBe('unattested')
  })

  it('reads an entry recorded on another machine as other_machine', async () => {
    expect((await ratedThenEdited("json_set(observation_json, '$.attributes.machine', 'mc_01m7gg00000000000000000099')"))?.recordedBy.origin).toBe('other_machine')
  })

  it('reads an entry whose person was not kept as nobody named, never as another person', async () => {
    expect((await ratedThenEdited("json_set(observation_json, '$.source.actor', json('null'))"))?.person).toBe('')
  })
})

describe('getSpaceSignals: an acceptance a later adoption superseded', () => {
  it('still delivers the ticket at a cutoff before the adoption, and no longer after it', async () => {
    const w = await open({ alpha: { title: 'Alpha', acceptanceCriteria: ['Alpha works'] }, beta: { title: 'Beta' } })
    const alpha = await w.claim('alpha')
    await w.submit('alpha', alpha)
    await w.accept(alpha)
    const beforeReplan = w.harness.clock.nowIso()
    await w.replan([{ op: 'update_ticket', ticket: w.ticket.alpha ?? '', patch: { title: 'Alpha, reworded' } }])
    expect(w.signals({ level: 'ticket', id: w.ticket.alpha ?? '', cutoff: beforeReplan }).A.input).toMatchObject({ committed: 1, delivered: 1 })
    expect(w.signals({ level: 'ticket', id: w.ticket.alpha ?? '' }).A.input).toMatchObject({ committed: 1, delivered: 0 })
  })
})

describe('getSpaceSignals: a ticket added after its sprint froze, then removed', () => {
  /** Alpha delivered (its claim freezing the sprint), gamma added by a replan, claimed and rejected. */
  async function addedThenRemoved(): Promise<{ w: SignalsWorld; gamma: Claimed; claimedAt: string }> {
    const w = await open({ alpha: { title: 'Alpha', acceptanceCriteria: ['Alpha works'] } })
    const alpha = await w.claim('alpha')
    await w.submit('alpha', alpha)
    await w.accept(alpha)
    await w.replan([{ op: 'add_ticket', ref: 'gamma', sprint: w.sprintId, ticket: { title: 'Gamma', acceptanceCriteria: ['Gamma works', 'Gamma logs'] } }])
    const gamma = await w.claim('gamma')
    const claimedAt = w.harness.clock.nowIso()
    await w.submit('gamma', gamma)
    await w.reject(gamma, 'not what was asked')
    return { w, gamma, claimedAt }
  }

  it('freezes the added ticket’s scope with its own first claim, not its sprint’s', async () => {
    const { w, claimedAt } = await addedThenRemoved()
    const gamma = w.signals({ level: 'ticket', id: w.ticket.gamma ?? '' })
    expect(gamma.A.frozenAt).toBe(claimedAt)
    expect(gamma.A.frozenRevisionId).toBe(gamma.A.currentRevisionId)
    expect(gamma.A.input).toMatchObject({ committed: 2, delivered: 0, removed: 0, added: 0 })
  })

  it('keeps the removed ticket’s frozen criteria committed, every one of them removed', async () => {
    const { w } = await addedThenRemoved()
    await w.replan([{ op: 'remove_ticket', ticket: w.ticket.gamma ?? '' }])
    const gamma = w.signals({ level: 'ticket', id: w.ticket.gamma ?? '' })
    expect(gamma.A.input).toMatchObject({ committed: 2, delivered: 0, removed: 2, added: 0 })
    expect(gamma.A.removed.map((item) => item.label)).toEqual(['Gamma works', 'Gamma logs'])
  })
})

describe('getSpaceSignals: C read from records as stored', () => {
  /** A submission missing every piece of evidence, rejected; its stored criteria check rewritten by `edit`. */
  async function rejectedPoorly(edit: string): Promise<{ w: SignalsWorld; poor: Claimed }> {
    const w = await open({ poor: { title: 'Poor', acceptanceCriteria: ['Parses input'] } })
    const poor = await w.claim('poor')
    await w.submit('poor', poor, { outputs: { summary: 'Did it', commits: [] }, evidence: { criteria: [], notes: '' } })
    await w.reject(poor, 'no evidence')
    w.orchestrator
      .ctx()
      .db.run(
        `UPDATE metric_observations SET observation_json = ${edit} WHERE metric = 'handoff_check' AND attempt_id = ? AND json_extract(observation_json, '$.attributes.check') = 'criteria_evidence'`,
        poor.id
      )
    return { w, poor }
  }

  const failedChecks = (w: SignalsWorld, poor: Claimed) =>
    w.signals({ level: 'ticket', id: w.ticket.poor ?? '' }).C.deductions.flatMap((item) => (item.kind === 'failed_handoff_check' && item.attemptId === poor.id ? [item] : []))

  it('reads a failed check that kept no name, list or count as an unnamed check missing nothing', async () => {
    const { w, poor } = await rejectedPoorly("json_remove(observation_json, '$.attributes.check', '$.attributes.missing', '$.attributes.missingCount')")
    const [unnamed] = failedChecks(w, poor)
    expect([unnamed?.check, unnamed?.missing, unnamed?.missingCount]).toEqual(['', [], 0])
  })

  it.each([
    ['a list that is not JSON', "json_set(observation_json, '$.attributes.missing', 'c1, c2')"],
    ['JSON that is not a list', "json_set(observation_json, '$.attributes.missing', '{\"c1\":true}')"]
  ])('reads a stored missing value that is %s as missing nothing, keeping its count', async (_label, edit) => {
    const { w, poor } = await rejectedPoorly(edit)
    const [check] = failedChecks(w, poor)
    expect([check?.check, check?.missing, check?.missingCount]).toEqual(['criteria_evidence', [], 1])
  })

  it('reads a decided submission whose decision was not kept as unreviewed, never as a rejection', async () => {
    const { w, poor } = await rejectedPoorly('observation_json')
    w.orchestrator.ctx().db.run('UPDATE attempts SET decision_json = NULL WHERE id = ?', poor.id)
    const view = w.signals({ level: 'ticket', id: w.ticket.poor ?? '' })
    expect(failedChecks(w, poor).map((item) => item.review)).toEqual([null, null, null])
    expect(view.C.deductions.filter((item) => item.kind === 'rejected_submission')).toEqual([])
  })

  it('names a logged refusal that kept no code or message as an internal refusal', async () => {
    const { w, poor } = await rejectedPoorly('observation_json')
    const ctx = w.orchestrator.ctx()
    ctx.db.run("DELETE FROM metric_observations WHERE metric = 'handoff_check' AND attempt_id = ?", poor.id)
    appendEvent(ctx, { kind: 'attempt.handoff_checks_refused', epicId: w.epicId, runId: w.runId, payload: { attemptId: poor.id } })
    expect(w.signals({ level: 'ticket', id: w.ticket.poor ?? '' }).C.unchecked).toEqual([
      { attemptId: poor.id, reason: 'checks_refused', code: 'internal', detail: 'The ledger refused the handoff checks when the submission arrived: ' }
    ])
  })
})
