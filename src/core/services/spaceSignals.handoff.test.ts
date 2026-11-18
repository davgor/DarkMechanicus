/**
 * DM-174 c3: handoff checks derived on submission tell missing required evidence or a broken output contract from a
 * purposeful clarification; every C deduction links to the concrete check, review or coordination record behind it;
 * measurement never blocks the lifecycle.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { MetricObservation } from '../../shared/domain/space'
import { LEDGER_LIMITS } from '../space/ledger'
import { graded, mcpSession, type SignalsWorld, signalsWorld } from '../../test/spaceSignalsWorld'
import { recordHumanFeedback } from './humanFeedback'
import { insertObservationRow, listObservations } from './observations'
import { recordHandoffChecks } from './spaceSignals'

const worlds: SignalsWorld[] = []

async function open(...args: Parameters<typeof signalsWorld>): Promise<SignalsWorld> {
  const w = await signalsWorld(...args)
  worlds.push(w)
  return w
}

afterEach(() => {
  for (const w of worlds.splice(0)) w.close()
})

function handoffChecks(w: SignalsWorld, attemptId: string): MetricObservation[] {
  return listObservations(w.orchestrator.ctx().db, { attemptId }).filter((item) => item.metric === 'handoff_check')
}

/** Each stored check as `name=value[missing]`, in `HANDOFF_CHECKS` order. */
function checksOf(w: SignalsWorld, attemptId: string): string[] {
  const order = ['criteria_evidence', 'verification_checks', 'outputs_contract']
  return handoffChecks(w, attemptId)
    .sort((a, b) => order.indexOf(String(a.attributes.check)) - order.indexOf(String(b.attributes.check)))
    .map((item) => {
      const value = item.measurement.state === 'missing' ? '?' : String(item.measurement.value)
      const missing = item.attributes.missing === undefined ? '' : `[${(JSON.parse(String(item.attributes.missing)) as string[]).join(', ')}]`
      return `${String(item.attributes.check)}=${value}${missing}`
    })
}

function attemptState(w: SignalsWorld, attemptId: string): string | undefined {
  return w.orchestrator.ctx().db.get<{ state: string }>('SELECT state FROM attempts WHERE id = ?', attemptId)?.state
}

function defect(eventId: string, patch: Record<string, unknown>): Record<string, unknown> {
  return {
    metric: 'coordination_defect',
    unit: 'count',
    source: { kind: 'agent', actor: 'orchestrator-session' },
    measurement: { state: 'observed', value: 1 },
    accumulation: 'event',
    eventId,
    observedAt: '2026-03-01T10:30:00.000Z',
    ...patch
  }
}

describe('handoff checks recorded on submission (DM-174 c3)', () => {
  it('passes all three checks for a complete handoff', async () => {
    const w = await open({ good: { title: 'Good', acceptanceCriteria: ['Parses input', 'Writes output'] } })
    const good = await w.claim('good')
    await w.submit('good', good)
    expect(checksOf(w, good.id)).toEqual(['criteria_evidence=1', 'verification_checks=1', 'outputs_contract=1'])
  })

  it('records each piece of missing evidence and each broken contract field', async () => {
    const w = await open({ poor: { title: 'Poor', acceptanceCriteria: ['Parses input', 'Writes output'], expectedArtifacts: ['Schema doc'] } })
    const poor = await w.claim('poor')
    await w.submit('poor', poor, {
      outputs: { summary: 'Did it', commits: ['def5678'] },
      evidence: { criteria: [{ criterionId: 'c1', met: true, note: 'parser done' }], notes: '' }
    })
    expect(checksOf(w, poor.id)).toEqual(['criteria_evidence=0[c2]', 'verification_checks=0[any check]', 'outputs_contract=0[branch, artifacts]'])
  })

  it('records no check when a worker stops to ask, and passes a retry that reports a criterion unmet with its reason', async () => {
    const w = await open({ asks: { title: 'Asks first', acceptanceCriteria: ['Uses the agreed format'] } })
    const asks = await w.claim('asks')
    await w.orchestrator.failAttempt({ attemptId: asks.id, claimToken: asks.token, failure: { reason: 'Question: which output format?', retryable: true } })
    expect(checksOf(w, asks.id)).toEqual([])
    recordHumanFeedback(w.desktop.ctx(), { target: { epicId: w.epicId, attemptId: asks.id }, feedback: { kind: 'rescue', minutes: 10, intervention: 'clarification', cause: 'requirement' } })
    const retry = await w.claim('asks')
    await w.submit('asks', retry, {
      evidence: { checks: [{ name: 'npm test', status: 'passed', detail: 'ok' }], criteria: [{ criterionId: 'c1', met: false, note: 'Used CSV as clarified; JSON awaits the owner' }], notes: '' }
    })
    expect(checksOf(w, retry.id)).toEqual(['criteria_evidence=1', 'verification_checks=1', 'outputs_contract=1'])
    await w.accept(retry, [{ criterionId: 'c1', met: true, note: 'reviewer: CSV is what was asked' }])

    const view = w.signals({ level: 'ticket', id: w.ticket.asks ?? '' })
    expect(view.C.clarifications).toBe(1)
    expect(view.C.deductions).toEqual([])
    expect(graded(view, 'C')).toMatchObject({ state: 'observed', score: 100 })
  })
})

describe('handoff checks are a record of the submission, independent of its review (DM-174 c3)', () => {
  it('re-deriving a stored submission, even after the review merged its criteria in, changes nothing', async () => {
    const w = await open({ good: { title: 'Good', acceptanceCriteria: ['Works'] } })
    const good = await w.claim('good')
    await w.submit('good', good)
    const before = handoffChecks(w, good.id).map((item) => `${item.observationId}:${item.recordedAt}`)
    await w.accept(good, [{ criterionId: 'c1', met: true, note: 'reviewer filled this in' }])
    w.harness.clock.advanceSeconds(60)
    expect(recordHandoffChecks(w.orchestrator.ctx(), good.id)).toBe(true)
    expect(handoffChecks(w, good.id).map((item) => `${item.observationId}:${item.recordedAt}`)).toEqual(before)
  })

  it('records nothing for an attempt that was never submitted', async () => {
    const w = await open({ open: { title: 'Open', acceptanceCriteria: ['Works'] } })
    const claimed = await w.claim('open')
    expect(recordHandoffChecks(w.orchestrator.ctx(), claimed.id)).toBe(false)
    expect(handoffChecks(w, claimed.id)).toEqual([])
  })

  it('keeps the checks of a submission canceled with its run before review, so C is scored', async () => {
    const w = await open({ late: { title: 'Canceled before review', acceptanceCriteria: ['Done'] } })
    const late = await w.claim('late')
    await w.submit('late', late)
    await w.orchestrator.cancelRun({ runId: w.runId, reason: 'stopping early' })
    expect(attemptState(w, late.id)).not.toBe('submitted')
    const view = w.signals({ level: 'ticket', id: w.ticket.late ?? '' })
    expect(view.C.uncheckedSubmissions).toEqual([])
    expect(graded(view, 'C')).toMatchObject({ state: 'observed', score: 100 })
  })
})

/** Poor: a first submission missing evidence and contract fields, rejected; a complete retry, accepted. Asks: claimed. */
async function poorWorld(): Promise<{ w: SignalsWorld; poorId: string; asksId: string }> {
  const w = await open({
    poor: { title: 'Poor', acceptanceCriteria: ['Parses input', 'Writes output'], expectedArtifacts: ['Schema doc'] },
    asks: { title: 'Asks', acceptanceCriteria: ['Works'] }
  })
  const poor = await w.claim('poor')
  await w.submit('poor', poor, {
    outputs: { summary: 'Did it', commits: ['def5678'] },
    evidence: { criteria: [{ criterionId: 'c1', met: true, note: 'parser done' }], notes: '' }
  })
  await w.reject(poor, 'missing evidence for c2')
  const retry = await w.claim('poor')
  await w.submit('poor', retry, {
    outputs: { summary: 'Did it', commits: ['def5679'], branch: 'work-poor', artifacts: [{ label: 'Schema doc', location: 'docs/schema.md', hash: null, remoteOnly: false }] }
  })
  await w.accept(retry)
  const asks = await w.claim('asks')
  return { w, poorId: poor.id, asksId: asks.id }
}

describe('C deductions link to their records (DM-174 c3)', () => {
  it('links each failed check to its observation, the submission, the missing criterion and the rejection', async () => {
    const { w, poorId } = await poorWorld()
    const view = w.signals({ level: 'ticket', id: w.ticket.poor ?? '' })
    const failed = view.C.deductions.filter((item) => item.kind === 'failed_handoff_check')
    expect(failed.map((item) => [item.check, item.missing, item.missingCount, item.attemptId, item.review?.outcome])).toEqual([
      ['criteria_evidence', ['c2'], 1, poorId, 'rejected'],
      ['verification_checks', ['any check'], 1, poorId, 'rejected'],
      ['outputs_contract', ['branch', 'artifacts'], 2, poorId, 'rejected']
    ])
    for (const item of failed) {
      expect(item.evidence[0]).toEqual({ kind: 'observation', id: item.observationId, detail: null })
      expect(item.evidence).toContainEqual(expect.objectContaining({ kind: 'attempt', id: poorId }))
    }
    expect(failed[0]?.evidence).toContainEqual(expect.objectContaining({ kind: 'criterion', detail: 'c2' }))
    expect(view.C.input.handoffChecks).toEqual({ passed: 3, failed: 3 })
    expect(graded(view, 'C')).toMatchObject({ state: 'observed', score: 50 })
  })
})

describe('coordination defects cite run records (DM-174 c3)', () => {
  it('records a coordination defect only when it cites a run record and deducts it with that link', async () => {
    const { w, poorId } = await poorWorld()
    const orchestrator = await mcpSession(w.orchestrator, 'orchestrator')
    try {
      const uncited = await orchestrator.call('record_attempt_metrics', { attemptId: poorId, reports: [defect('d-2', {})] })
      expect(uncited.ok).toBe(false)
      expect(uncited.error?.code).toBe('invalid_input')
      const cited = await orchestrator.call('record_attempt_metrics', {
        attemptId: poorId,
        reports: [defect('d-1', { attributes: { kind: 'contract_mismatch' }, evidence: [{ kind: 'attempt', id: poorId, detail: 'no schema for its successor' }] })]
      })
      expect(cited.ok).toBe(true)
    } finally {
      await orchestrator.close()
    }
    const view = w.signals({ level: 'ticket', id: w.ticket.poor ?? '' })
    const defects = view.C.deductions.filter((item) => item.kind === 'coordination_defect')
    expect(defects).toHaveLength(1)
    expect(defects[0]?.count).toBe(1)
    expect(defects[0]?.evidence).toEqual([{ kind: 'attempt', id: poorId, detail: 'no schema for its successor' }])
    expect(view.C.input.coordinationDefects).toBe(1)
    // 100 × 3 passed ÷ 6 checked − 10 per defect.
    expect(graded(view, 'C')).toMatchObject({ score: 40 })
  })

  it('refuses a clarification reported as a coordination defect', async () => {
    const { w, asksId } = await poorWorld()
    const orchestrator = await mcpSession(w.orchestrator, 'orchestrator')
    try {
      const answer = await orchestrator.call('record_attempt_metrics', {
        attemptId: asksId,
        reports: [defect('d-3', { attributes: { kind: 'clarification' }, evidence: [{ kind: 'attempt', id: asksId, detail: 'asked about the format' }] })]
      })
      expect(answer.ok).toBe(false)
      expect(answer.error?.code).toBe('invalid_input')
    } finally {
      await orchestrator.close()
    }
    expect(w.signals({ level: 'ticket', id: w.ticket.asks ?? '' }).C.input.coordinationDefects).toBe(0)
  })
})

describe('measurement never blocks the lifecycle (DM-174 c3)', () => {
  it('stores the submission unchecked when the ledger refuses a Definition of Done name, and C names why', async () => {
    const w = await open({ work: { title: 'Work', acceptanceCriteria: ['Works'] } }, { acceptance: true })
    await w.desktop.setDefinitionOfDone({ checks: ['token: rotation check', 'lint'].map((name) => ({ name, command: 'npm run check' })) })
    const work = await w.claim('work')
    await w.submit('work', work)
    await w.accept(work)
    const node = await w.claim('acceptance')
    await w.submit('acceptance', node, { evidence: { checks: [{ name: 'Lint', status: 'passed', detail: 'ok' }], notes: '' } })
    expect(attemptState(w, node.id)).toBe('submitted')
    expect(handoffChecks(w, node.id)).toEqual([])
    const view = w.signals({ level: 'ticket', id: w.ticket.acceptance ?? '' })
    expect(view.C.uncheckedSubmissions).toEqual([node.id])
    expect(view.C.unchecked.map((item) => [item.attemptId, item.reason])).toEqual([[node.id, 'checks_refused']])
    expect(view.C.unchecked[0]?.code).not.toBeNull()
    expect(graded(view, 'C')).toMatchObject({ state: 'missing', missingReason: 'not_reported' })
  })
})

/**
 * Fills the epic's ledger to `count` observations, as a long-lived project would have: one row stored the usual way,
 * copied in SQL under fresh ids (one statement, not `count` round trips).
 */
function fillLedger(w: SignalsWorld, count: number): void {
  const db = w.orchestrator.ctx().db
  const first = 'mo_00000000000000000000000000'
  insertObservationRow(db, {
    observationId: first,
    metric: 'activity_volume',
    unit: 'count',
    scope: { level: 'epic', epicId: w.epicId, sprintId: null, runId: null, ticketId: null, attemptId: null },
    source: { kind: 'server', actor: null },
    measurement: { state: 'observed', value: 1 },
    accumulation: 'event',
    sequence: null,
    observedAt: '2026-03-01T10:00:00.000Z',
    recordedAt: '2026-03-01T10:00:00.000Z',
    attributes: { kind: 'tool_calls' },
    evidence: []
  })
  db.run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO metric_observations (id, metric, scope_level, epic_id, sprint_id, run_id, ticket_id, attempt_id, source_kind,
       measurement_state, recorded_at, payload_hash, observation_json)
     SELECT printf('mo_%026d', i), metric, scope_level, epic_id, sprint_id, run_id, ticket_id, attempt_id, source_kind,
       measurement_state, recorded_at, payload_hash, json_set(observation_json, '$.observationId', printf('mo_%026d', i))
     FROM metric_observations, n WHERE id = ?`,
    count - 1,
    first
  )
}

describe('a full ledger never blocks the lifecycle (DM-174 c3)', () => {
  it('stores and reviews a submission whose checks a full ledger refuses, leaving the ledger unchanged', async () => {
    const w = await open({ work: { title: 'Work', acceptanceCriteria: ['Works'] } })
    fillLedger(w, LEDGER_LIMITS.perFolder - 2)
    const db = w.orchestrator.ctx().db
    const count = (): number | undefined => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM metric_observations WHERE epic_id = ?', w.epicId)?.n
    const held = count()
    const work = await w.claim('work')
    await w.submit('work', work)
    expect(attemptState(w, work.id)).toBe('submitted')
    expect(handoffChecks(w, work.id)).toEqual([])
    expect(count()).toBe(held)
    await w.accept(work)
    expect(attemptState(w, work.id)).toBe('accepted')
    expect(graded(w.signals({ level: 'ticket', id: w.ticket.work ?? '' }), 'C')).toMatchObject({ state: 'missing', missingReason: 'not_reported' })
  })
})

describe('stored missing lists (DM-174 c3)', () => {
  it('shortens a long missing list by whole names only and keeps the full count', async () => {
    const long = Array.from({ length: 7 }, (_, index) => `integration suite part ${index + 1} of seven`)
    const w = await open({ work: { title: 'Work', acceptanceCriteria: ['Works'] } }, { acceptance: true })
    await w.desktop.setDefinitionOfDone({ checks: ['lint', ...long].map((name) => ({ name, command: 'npm run check' })) })
    const work = await w.claim('work')
    await w.submit('work', work)
    await w.accept(work)
    const node = await w.claim('acceptance')
    await w.submit('acceptance', node, { evidence: { checks: [{ name: ' Lint ', status: 'passed', detail: 'ok' }], notes: '' } })
    const deduction = w.signals({ level: 'ticket', id: w.ticket.acceptance ?? '' }).C.deductions.find((item) => item.kind === 'failed_handoff_check' && item.check === 'verification_checks')
    if (deduction?.kind !== 'failed_handoff_check') throw new Error('no verification deduction')
    expect(deduction.missingCount).toBe(7)
    expect(deduction.missing.length).toBeGreaterThan(0)
    expect(deduction.missing.length).toBeLessThan(7)
    expect(deduction.missing).toEqual(long.slice(0, deduction.missing.length))
  })
})
