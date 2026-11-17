/**
 * Fixtures for the Improvement tab and the corrective planner (DM-187, DM-188): a sprint 2 report of the sample run
 * (`epic/__mocks__/fixtures.ts`) with a frozen scorecard, findings read from it, experiments drawn from them, their
 * standing and outcome, and corrective previews and results. Every builder returns a fresh object.
 */
import type { CorrectionPlanView, CorrectionsResultView, CorrectionTicketView } from '../../../shared/domain/corrections'
import type { ExperimentComparison, ExperimentOutcome, ExperimentReading, ExperimentView, RetroExperiment } from '../../../shared/domain/experiments'
import type { RetroFinding, RetroFindingsView } from '../../../shared/domain/retroFindings'
import type { ScorecardSummary } from '../../../shared/domain/spaceGrades'
import type { SprintReportView } from '../../../shared/domain/views'
import { reportWithRetro, retroView, validation } from '../epic/__mocks__/fixtures'

export const REPORT_ID = 'sr_1'
const ASSESSMENT = 'as_202'

function scorecard(patch: Partial<ScorecardSummary> = {}): ScorecardSummary {
  return {
    snapshotId: 'ss_9',
    snapshotHash: 'sha256:abcdef0123456789abcdef',
    cutoff: '2026-09-30T11:00:00.000Z',
    policy: { policyId: 'space-default', version: 3, hash: 'sha256:0011223344556677889900' },
    grades: [
      { subject: { level: 'ticket', id: 'tk_202' }, assessmentId: ASSESSMENT, status: 'final', score: 52, displayScore: '52', letter: 'D', coverage: 0.857, inputHash: 'ih1', policyHash: 'ph' },
      { subject: { level: 'sprint', id: 'sp_2' }, assessmentId: 'as_sp2', status: 'final', score: 71.4, displayScore: '71', letter: 'C', coverage: 0.75, inputHash: 'ih2', policyHash: 'ph' },
      { subject: { level: 'run', id: 'rn_2' }, assessmentId: 'as_rn2', status: 'provisional', score: 70, displayScore: '70', letter: 'C', coverage: 0.75, inputHash: 'ih3', policyHash: 'ph' }
    ],
    ticketCount: 4,
    ...patch
  }
}

/** An experiment of the report's own scorecard, drawn from the DM-202 ticket grade: T.actual_ms −20%, two sized items. */
export function experiment(id: string, patch: Partial<RetroExperiment> = {}): RetroExperiment {
  return {
    id,
    source: {
      revision: 'own',
      epicId: 'ep_1',
      runId: 'rn_2',
      sprintId: 'sp_2',
      reportId: REPORT_ID,
      reportRevision: 1,
      snapshotId: 'ss_9',
      policyHash: 'ph',
      assessmentId: ASSESSMENT,
      subject: { level: 'ticket', id: 'tk_202' },
      inputHash: 'ih1'
    },
    concern: 'plan_context',
    issue: { summary: `${id}: DM-202 ran 90 minutes against a 30 minute budget`, evidence: [{ kind: 'attempt', id: 'at_202_1', detail: 'first attempt' }] },
    hypothesis: 'Hypothesis: the importer context is missing from the claim packet.',
    destination: { kind: 'source_repository', repository: null },
    proposedWork: [
      { title: `${id} work one`, body: 'List the importer record files in the claim packet.', size: 'small' },
      { title: `${id} work two`, body: 'Add the schema modules to the context section.', size: 'small' }
    ],
    baseline: { measure: 'T.actual_ms', unit: 'milliseconds', value: 5_400_000, state: 'observed' },
    expectedChange: { direction: 'decrease', amount: 20, unit: 'percent' },
    guardrails: [{ measure: 'A.delivered', unit: 'count', comparator: 'at_least', threshold: 4 }],
    window: { basis: 'sprints', count: 1 },
    ...patch
  }
}

export function finding(id: string, patch: Partial<RetroFinding> = {}): RetroFinding {
  return {
    id,
    rank: 1,
    kind: 'budget_overrun',
    subject: { level: 'ticket', id: 'tk_202' },
    assessmentId: ASSESSMENT,
    component: 'T',
    statement: 'tk_202 used 90 minutes of active time against a 30 minute budget.',
    magnitude: { measure: 'T.actual_ms', value: 5_400_000, unit: 'milliseconds', reference: 1_800_000, ratio: 3, state: 'observed', text: '90 min against 30 min (3×)' },
    severity: 2,
    coverage: { grade: 0.857, items: { measured: 2, total: 3 } },
    origins: { attemptIds: ['at_202_1'], criteria: [], observationIds: [], checks: [], ticketIds: ['tk_202'] },
    evidence: [{ kind: 'attempt', id: 'at_202_1', detail: null }],
    hypotheses: [{ concern: 'plan_context', hypothesis: 'The importer context was missing.' }],
    concern: 'plan_context',
    contradictedBy: [],
    proposal: null,
    withheld: 'sparse_data',
    ...patch
  }
}

export function findings(rows: RetroFinding[], patch: Partial<RetroFindingsView> = {}): RetroFindingsView {
  return {
    runId: 'rn_2',
    sprintId: 'sp_2',
    reportId: REPORT_ID,
    reportRevision: 1,
    snapshotId: 'ss_9',
    cutoff: '2026-09-30T11:00:00.000Z',
    policyHash: 'ph',
    status: 'findings',
    findings: rows,
    contradictions: [],
    thresholds: { overrun: 0.25, correctiveShare: 0.3, correctiveOfOwn: 0.3, sparseCoverage: 0.5 },
    notes: [],
    ...patch
  }
}

export function reading(patch: Partial<ExperimentReading> = {}): ExperimentReading {
  return { value: 5_400_000, unit: 'milliseconds', state: 'observed', assessment: null, sampleSize: 1, perTicket: null, size: 'small', sizeMix: null, window: null, ...patch }
}

export function comparison(patch: Partial<ExperimentComparison> = {}): ExperimentComparison {
  return {
    eventId: 'ev_2',
    eventNumber: 2,
    recordedAt: '2026-10-07T10:00:00.000Z',
    note: '',
    after: reading({ value: 3_600_000, window: { from: '2026-10-01T09:00:00.000Z', to: '2026-10-06T17:00:00.000Z' } }),
    evidence: [{ kind: 'run', id: 'rn_3', detail: 'sprint 3 run' }],
    basis: 'value',
    before: 5_400_000,
    measured: 3_600_000,
    target: 4_320_000,
    difference: -1_800_000,
    percentChange: -33.3,
    guardrails: [{ measure: 'A.delivered', unit: 'count', comparator: 'at_least', threshold: 4, after: 5, verdict: 'held', detail: 'A.delivered 5 at least 4' }],
    classification: 'improved',
    reasons: ['It moved past the target and every guardrail held.'],
    ...patch
  }
}

export function outcome(experimentId: string, patch: Partial<ExperimentOutcome> = {}): ExperimentOutcome {
  return {
    experimentId,
    status: 'in_progress',
    classification: 'improved',
    decidedBy: 'ev_2',
    reasons: ['Result #2 moved past the target.'],
    baseline: reading(),
    target: { direction: 'decrease', amount: 20, unit: 'percent', value: 4_320_000 },
    guardrails: [],
    window: { basis: 'sprints', count: 1 },
    landing: { at: '2026-10-01T09:00:00.000Z', by: 'corrective_tickets', detail: 'DM-205 accepted' },
    corrections: {
      tickets: [
        { epicId: 'ep_1', epicTitle: 'Checkout revamp', ticketId: 'tk_204', key: 'DM-204', title: 'Sidebar plan buckets', role: 'work', workIndex: 0, revisionNumber: 5, accepted: { runId: 'rn_3', attemptId: 'at_9', at: '2026-10-01T09:00:00.000Z' } }
      ],
      runIds: ['rn_3']
    },
    comparisons: [comparison()],
    evidence: 'observational',
    caveat: 'Observational: a before/after difference over different work, not proof of cause.',
    ...patch
  }
}

export function experimentRead(of: RetroExperiment, patch: Partial<ExperimentView> = {}): ExperimentView {
  return {
    experiment: of,
    definedIn: { runId: 'rn_2', sprintId: 'sp_2', reportId: REPORT_ID, reportRevision: 1, experimentHash: 'xh' },
    status: 'proposed',
    withdrawn: false,
    executionProblems: [],
    events: [],
    outcome: outcome(of.id, { comparisons: [], classification: 'insufficient_evidence', corrections: { tickets: [], runIds: [] } }),
    crossRepoResults: [],
    ...patch
  }
}

/** The sample sprint 2 report, revision `reportRevision`, with its frozen scorecard and these experiments. */
export function improvementReport(experiments: RetroExperiment[], patch: Partial<SprintReportView> = {}): SprintReportView {
  return reportWithRetro(retroView({ experiments }), { scorecard: scorecard(), ...patch })
}

export function workTicket(experimentId: string, index: number, patch: Partial<CorrectionTicketView> = {}): CorrectionTicketView {
  return {
    ref: `${experimentId}#${index}`,
    role: 'work',
    experimentId,
    workIndex: index,
    key: `DM-${310 + index}`,
    ticketId: null,
    existing: false,
    title: `${experimentId} work ${index === 0 ? 'one' : 'two'}`,
    body: 'List the importer record files in the claim packet.\n\n## Corrective experiment\nxp context',
    size: 'small',
    tags: ['correction'],
    repo: null,
    acceptanceCriteria: [{ id: 'c1', text: 'The claim packet lists the importer files', covers: null }],
    dependsOn: [],
    ...patch
  }
}

export function planView(experimentIds: string[], patch: Partial<CorrectionPlanView> = {}): CorrectionPlanView {
  return {
    source: { epicId: 'ep_1', epicTitle: 'Checkout revamp', epicStatus: 'active', runId: 'rn_2', sprintId: 'sp_2', sprintOrdinal: 2, reportId: REPORT_ID, reportRevision: 1 },
    target: { kind: 'new_sprint', epicId: 'ep_1', epicTitle: 'Checkout revamp', sprintId: null, sprintOrdinal: 4, sprintGoal: 'Corrective work', afterOrdinal: 3 },
    experiments: experimentIds.map((experimentId) => ({ experimentId, concern: 'plan_context', key: `${REPORT_ID}/${experimentId}/epic:ep_1`, payloadHash: 'p', state: 'ready', problems: [], restatement: null, existing: null })),
    createdIn: [],
    tickets: experimentIds.flatMap((experimentId) => [workTicket(experimentId, 0), workTicket(experimentId, 1, { key: 'DM-311', dependsOn: [`${experimentId}#0`] })]),
    dependencies: experimentIds.map((experimentId) => ({ from: `${experimentId}#0`, to: `${experimentId}#1` })),
    draftRevision: 7,
    validation: validation({ warnings: [] }),
    nextSteps: ['Open the draft, review it and press Save.'],
    notes: [],
    ...patch
  }
}

export function resultOf(plan: CorrectionPlanView, patch: Partial<CorrectionsResultView> = {}): CorrectionsResultView {
  return { ...plan, draftRevision: (plan.draftRevision ?? 0) + 1, changed: true, tickets: plan.tickets.map((ticket, at) => ({ ...ticket, ticketId: `tk_new${at}` })), ...patch }
}
