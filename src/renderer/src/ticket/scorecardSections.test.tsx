// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComponentDifference, ScorecardReassessment, SubjectReassessment, TicketGradeView } from '../../../shared/domain/spaceGrades'
import type { CollaborationDeduction, HumanFeedbackEntry } from '../../../shared/domain/spaceSignals'
import type { TicketTiming } from '../../../shared/domain/timing'
import { CUTOFF, subjectReassessment, TICKET_A, ticketGrade, ticketTiming } from '../__mocks__/ticketScorecardFixtures'
import type { ReadPart, ScoreReadError, TicketReportRead } from '../scorecard/scoreReads'
import { localTime } from '../scorecard/scorecardFormat'
import type { EvidenceOpener } from '../scorecard/ScorecardParts'
import { AttemptsSection, CorrectionsSection, FeedbackSection, ReportSection, UsageAndTime } from './scorecardSections'

const READ_AT = Date.parse('2026-03-04T10:05:00.000Z')
const FAILED: ScoreReadError = { code: 'internal', message: 'usage store locked', action: 'retry' }
const opener: EvidenceOpener = { target: () => null, open: () => undefined }

afterEach(cleanup)

const section = (label: string): HTMLElement => screen.getByRole('region', { name: label })

/** The value beside a fact's label in the named facts list. */
function fact(list: string, label: string): string {
  const term = within(screen.getByLabelText(list)).getByText(label, { selector: 'dt' })
  return term.nextElementSibling?.textContent ?? ''
}

function timing(byRole: TicketTiming['effort']['byRole']): ReadPart<TicketTiming> {
  const value = ticketTiming(TICKET_A, [])
  return { ok: true, value: { ...value, effort: { ...value.effort, byRole } } }
}

let entryCount = 0
function entry(patch: Partial<HumanFeedbackEntry>): HumanFeedbackEntry {
  entryCount += 1
  return {
    observationId: `ob_${entryCount}`,
    person: 'dana',
    recordedAt: CUTOFF,
    scope: { level: 'ticket', epicId: 'ep', sprintId: null, runId: null, ticketId: TICKET_A, attemptId: null },
    value: 4,
    sharedWithTickets: null,
    intervention: null,
    cause: null,
    activity: null,
    recordedBy: { origin: 'other_machine', desktopSession: 'ds_9', machine: 'box-2' },
    ...patch
  } as HumanFeedbackEntry
}

/** A grade whose S holds these feedback entries, with the minutes the core summed for them. */
function withFeedback(S: { ratings?: HumanFeedbackEntry[]; rescue?: HumanFeedbackEntry[]; plannedReview?: HumanFeedbackEntry[]; rescueMinutes?: number; plannedReviewMinutes?: number }): TicketGradeView {
  const grade = ticketGrade()
  return { ...grade, sources: { ...grade.sources, signals: { ...grade.sources.signals, S: { ...grade.sources.signals.S, ...S } } } }
}

function reassessed(subject: SubjectReassessment | null): ReadPart<TicketReportRead> {
  const reassessment: ScorecardReassessment = { reportId: 'rp_1', reportRevision: 4, legacy: false, approved: null, assessedAt: CUTOFF, policy: { policyId: 'balanced', version: 2, hash: 'h' }, subjects: [] }
  return { ok: true, value: { state: 'reassessed', reportId: 'rp_1', reportRevision: 4, reassessment, subject } }
}

describe('UsageAndTime: effort by role', () => {
  it('reads effort by role as unavailable when no role reported a span, never as 0', () => {
    render(<UsageAndTime grade={ticketGrade()} runLabel="Run #1" timing={timing({ worker: 0, orchestrator: 0, reviewer: 0, other: 0 })} onRetry={() => undefined} />)
    expect(fact('Time', 'Effort by role (roles that reported)')).toBe('unavailable')
  })
})

describe('AttemptsSection: empty, failed and unknown reads', () => {
  it('says no attempt ran yet and reads unknown retries as unavailable', () => {
    const grade = ticketGrade({ attempts: [], retries: null })
    render(<AttemptsSection grade={grade} timing={timing({ worker: 1, orchestrator: 0, reviewer: 0, other: 0 })} usage={{ ok: true, value: [] }} readAt={READ_AT} opener={opener} onRetry={() => undefined} />)
    const attempts = section('Attempts in this run')
    expect(within(attempts).getByText('ATTEMPTS IN THIS RUN (0)')).toBeTruthy()
    expect(within(attempts).getByText('No attempt of this ticket ran in this run yet.')).toBeTruthy()
    expect(within(attempts).getByText('Retries: unavailable (a diagnostic, never scored as waste).')).toBeTruthy()
  })

  it('a failed usage read marks every attempt\'s tokens as read failed, shows the error once and offers a retry', () => {
    let retried = 0
    render(<AttemptsSection grade={ticketGrade()} timing={timing({ worker: 1, orchestrator: 0, reviewer: 0, other: 0 })} usage={{ ok: false, error: FAILED }} readAt={READ_AT} opener={opener} onRetry={() => (retried += 1)} />)
    const attempts = section('Attempts in this run')
    expect(within(attempts).getByText(/· tokens read failed$/)).toBeTruthy()
    expect(attempts.textContent).not.toContain('Tokens as of')
    expect(within(attempts).getByRole('alert').textContent).toContain('usage store locked')
    fireEvent.click(within(attempts).getByRole('button', { name: 'Try again' }))
    expect(retried).toBe(1)
  })
})

const handoff = (missing: string[], missingCount: number): CollaborationDeduction => ({ kind: 'failed_handoff_check', observationId: `ob_h${missingCount}`, attemptId: 'at_1', check: 'criteria', missing, missingCount, review: null, evidence: [] })

describe('CorrectionsSection: deductions and person time', () => {
  it('names each deduction kind with its own details', () => {
    const deductions: CollaborationDeduction[] = [
      handoff(['c1', 'c2'], 5),
      handoff(['c9'], 1),
      { kind: 'coordination_defect', observationId: 'ob_d1', count: 2, reportedBy: 'reviewer-1', evidence: [] },
      { kind: 'coordination_defect', observationId: 'ob_d2', count: 1, reportedBy: null, evidence: [] },
      { kind: 'rejected_submission', attemptId: 'at_1', checks: 3, decidedBy: 'orchestrator', decidedAt: CUTOFF, evidence: [] }
    ]
    render(<CorrectionsSection grade={ticketGrade({ deductions })} opener={opener} />)
    const items = within(section('Corrections')).getAllByRole('listitem').map((item) => item.textContent)
    expect(items).toEqual([
      'Handoff check criteria failed: missing c1, c2 and 3 more',
      'Handoff check criteria failed: missing c9',
      '2 coordination defect(s) reported by reviewer-1',
      '1 coordination defect(s)',
      `Submission rejected by orchestrator at ${localTime(CUTOFF)} (3 check(s) count failed)`
    ])
    expect(screen.queryByText('No handoff failure, rejected submission or coordination defect recorded.')).toBeNull()
  })

  it('lists corrective effort by cause and counts rescue and review entries without minutes apart', () => {
    const grade = withFeedback({ rescue: [entry({ intervention: 'rescue', value: 30 }), entry({ intervention: 'redirect', value: null })], rescueMinutes: 30, plannedReview: [entry({ activity: 'review', value: 15 })], plannedReviewMinutes: 15 })
    const classified = { ...grade, sources: { ...grade.sources, efficiency: { ...grade.sources.efficiency, classification: { ...grade.sources.efficiency.classification, correctiveByCause: { tooling: 90_000, requirement: 60_000 } } } } } as TicketGradeView
    render(<CorrectionsSection grade={classified} opener={opener} />)
    expect(fact('Corrective effort', 'Corrective by cause')).toBe('tooling 1 min 30 s · requirement 1 min')
    expect(fact('Corrective effort', 'Rescue by a person')).toBe('2 recorded, 30 min given (1 without minutes, not counted as 0)')
    expect(fact('Corrective effort', 'Planned review or playtesting')).toBe('1 recorded, 15 min given')
  })
})

describe('FeedbackSection: every entry with its provenance', () => {
  it('describes ratings, rescues and planned reviews as the person recorded them', () => {
    const sprintScope = { level: 'sprint', epicId: 'ep', sprintId: 'sp', runId: null, ticketId: null, attemptId: null } as const
    const grade = withFeedback({
      ratings: [entry({ value: 5 }), entry({ scope: sprintScope, sharedWithTickets: true, value: 3 }), entry({ scope: sprintScope, sharedWithTickets: false, value: null })],
      rescue: [entry({ intervention: 'rescue', cause: 'tooling', value: 20 }), entry({ intervention: 'clarification', cause: null, value: null })],
      plannedReview: [entry({ activity: 'playtest', value: 45 })]
    })
    render(<FeedbackSection grade={grade} />)
    const lines = within(section("People's feedback"))
      .getAllByRole('listitem')
      .map((item) => item.firstElementChild?.textContent)
    const by = ` · by dana at ${localTime(CUTOFF)}`
    expect(lines).toEqual([
      `Ticket rating: 5 of 5${by}`,
      `Sprint rating, shared with its tickets: 3 of 5${by}`,
      `Sprint rating, not shared: — of 5${by}`,
      `Rescue · Took over or repaired the work · Tooling problem · 20 min${by}`,
      `Rescue · Answered a question · no reason given · minutes not given${by}`,
      `Playtesting · 45 min${by}`
    ])
    expect(screen.queryByText('No rating, rescue or planned review recorded for this ticket.')).toBeNull()
    expect(screen.getAllByText('Recorded by: recorded on another machine (imported, not checkable here); desktop session ds_9, machine box-2')).toHaveLength(6)
  })
})

describe('ReportSection: failed reads, ungraded subjects and differences', () => {
  it('shows a failed report read as an error with a retry', () => {
    let retried = 0
    render(<ReportSection report={{ ok: false, error: { code: 'internal', message: 'report store locked', action: 'retry' } }} onRetry={() => (retried += 1)} />)
    const report = section('Original and reassessed grades')
    expect(within(report).getByText('ORIGINAL AND REASSESSED')).toBeTruthy()
    fireEvent.click(within(report).getByRole('button', { name: 'Try again' }))
    expect(retried).toBe(1)
  })

  it('says the report froze no grade for this ticket when its scorecard holds no subject for it', () => {
    render(<ReportSection report={reassessed(null)} onRetry={() => undefined} />)
    const report = section('Original and reassessed grades')
    expect(within(report).getByText('ORIGINAL AND REASSESSED · REPORT REVISION 4')).toBeTruthy()
    expect(within(report).getByText('This report froze no grade for this ticket.')).toBeTruthy()
  })

  it('lists each component that changed with its detail and causes', () => {
    const difference: ComponentDifference = { component: 'K', approved: null, sameWindow: null, current: null, causes: ['policy_changed', 'later_records'], detail: 'tokens rose' }
    render(<ReportSection report={reassessed(subjectReassessment({ differences: [difference] }))} onRetry={() => undefined} />)
    expect(screen.getByRole('list', { name: 'Differences' }).textContent).toBe('K tokens rose (policy changed, later records)')
  })
})
