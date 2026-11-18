/**
 * Read-only MCP tools over the SPACE scorecard reads and the project metrics summary (`src/core/commands/scores.ts`).
 * Each adapts one command and returns its read model unchanged, so a tool answers the same JSON as the desktop's
 * command channel and `dm call` for the same ids and cutoff. Human feedback and escaped defect records
 * (`recordHumanFeedback`, `recordEscapedDefects`) and budget edits (`setTicketBudget`) stay desktop-only: no tool here
 * records feedback, defects or budgets. Like `get_run`, a read of a run may settle that run's overdue leases.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { COMMAND_SCHEMAS } from '../../core/commandSchemas'
import { stableId } from '../../core/schemas'
import type { CommandApi } from '../../shared/domain/api'
import { GRADE_SUBJECT_LEVELS } from '../../shared/domain/space'
import { defineTool, registerTools } from './define'
import { epicId, runId, sprintId, ticketId } from './params'

const cutoff = COMMAND_SCHEMAS.getTicketGrade.shape.cutoff.describe(
  'Optional ISO 8601 server time with a Z or ±hh:mm offset (a time without an offset is refused); default now, and a later time is clamped to now. Only records stored by then count.'
)
const reportId = stableId.describe('Sprint report revision id (from get_sprint_report).')
const reportRevision = COMMAND_SCHEMAS.getReportScorecard.shape.reportRevision.describe(
  'Optional: the revision number the report id must have; any other fails with `not_found`.'
)

/** Every tool here reads values the server computed; agents relay them and never grade themselves. */
const COMPUTED =
  'Dark Mechanicus computes every value from its records: relay it as returned, never regrade, average letters or scores, or fill a missing value. Unknown ids fail with `not_found`.'

/** Units and coverage of a SPACE grade. */
const GRADE_UNITS =
  'Seven components (S, P, A, C, E, T, K), each a score in points 0–100 with its inputs, rule, evidence and base/effective weight; the composite is in points 0–100 with a letter whose thresholds come from the grading policy the grade names (grade.policy). Coverage is the share of base weight scored; a missing component has a null score and its reason, never 0. Time inputs are in milliseconds and token inputs in tokens.'

/** What a grade's status means. */
const GRADE_STATUS =
  "status: final (every required component observed), provisional (a required component missing or an estimated input; score and letter shown but may change), or ungraded (verification pending or missing, or fewer components scored than the grade's policy requires: no score, no letter). A confirmed mandatory failure letters F with the score capped at the policy's cap; statusReasons say which rule applied."

/** Units and coverage of resource measures. */
const MEASURE_UNITS =
  'Tokens are in tokens and time in milliseconds; each measure states its coverage (observed, estimated, partial as a lower bound, or missing as null with its reason, never 0).'

const METRICS_TOOLS = [
  defineTool({
    name: 'get_ticket_grade',
    description: `Returns a ticket's live SPACE grade in one run as of a cutoff: the grade with every component, the explanation, the baselines used and the inputs it was graded from. ${GRADE_UNITS} ${GRADE_STATUS} ${COMPUTED}`,
    kind: 'read',
    input: { runId, ticketId, cutoff },
    run: (api, input) => api.getTicketGrade(input)
  }),
  defineTool({
    name: 'get_sprint_grade',
    description: `Returns a sprint's live SPACE grade within one run as of a cutoff, graded on the sprint's own raw measures (never an average of ticket grades), with the ticket grades it rolled up. A submitted sprint report's frozen grade is read with get_report_scorecard instead. ${GRADE_UNITS} ${GRADE_STATUS} ${COMPUTED}`,
    kind: 'read',
    input: { runId, sprintId, cutoff },
    run: (api, input) => api.getSprintGrade(input)
  }),
  defineTool({
    name: 'get_run_grade',
    description: `Returns a run's live SPACE grade as of a cutoff, graded on the run's own raw measures (overhead included; never an average of ticket grades). ${GRADE_UNITS} ${GRADE_STATUS} ${COMPUTED}`,
    kind: 'read',
    input: { runId, cutoff },
    run: (api, input) => api.getRunGrade(input)
  }),
  defineTool({
    name: 'get_epic_grade',
    description: `Returns an epic's live SPACE grade over every run that executed work, as of a cutoff, graded on the epic's own raw measures (each ticket counted once; never an average of run grades). ${GRADE_UNITS} ${GRADE_STATUS} ${COMPUTED}`,
    kind: 'read',
    input: { epicId, cutoff },
    run: (api, input) => api.getEpicGrade(input)
  }),
  defineTool({
    name: 'get_report_scorecard',
    description: `Returns the scorecard frozen with one sprint report revision (reportId), pinned to that revision and never live data: { state: "frozen", report, scorecard } with the sprint, run, (final sprint) epic and ticket grades as they stood at the submission's server time, or { state: "legacy", report, reason } for a report submitted before scorecards (ungraded, never an empty grade). ${GRADE_UNITS} ${GRADE_STATUS} ${COMPUTED}`,
    kind: 'read',
    input: { reportId, reportRevision },
    run: (api, input) => api.getReportScorecard(input)
  }),
  defineTool({
    name: 'reassess_report_scorecard',
    description: `Read-only dated reassessment of a sprint report revision's scorecard: returns the approved snapshot untouched and regrades each subject at the approved cutoff and at the reassessment cutoff, naming the cause of every changed component (policy_changed, records_at_cutoff_changed, later_records, window_start_moved) and each subject's membership (kept, left, joined, legacy). It records no assessment and the frozen scorecard never changes; like get_run, reading the run may settle its overdue leases. ${GRADE_UNITS} ${GRADE_STATUS} ${COMPUTED}`,
    kind: 'read',
    input: { reportId, reportRevision, cutoff },
    run: (api, input) => api.reassessReportScorecard(input)
  }),
  defineTool({
    name: 'get_space_signals',
    description: `Returns the S (a person's rating, 1–5), A (delivered over committed feature tickets, counts) and C (handoff checks passed and failed, coordination defects, counts) inputs of a ticket or sprint (within runId), a run, or an epic (every run) as of a cutoff, each with the records behind it and its coverage; a missing signal is null with its reason, never 0. These are grader inputs, not scores or grades (final/provisional/ungraded belongs to the grade reads). ${COMPUTED}`,
    kind: 'read',
    input: {
      level: z.enum(GRADE_SUBJECT_LEVELS).describe('The subject level: ticket, sprint, run or epic.'),
      id: stableId.describe('The ticket, sprint, run or epic id.'),
      runId: runId.optional().describe('The run a ticket or sprint is read within; required for those levels.'),
      cutoff
    },
    run: (api, input) => api.getSpaceSignals(input)
  }),
  defineTool({
    name: 'get_ticket_performance',
    description: `Returns a ticket's P input in one run as of a cutoff: the verification state (verified, failed, missing or pending, with its reason) from the review decision, each criterion and check with its basis (reviewer_checked, worker_claim, review_unknown for an acceptance recorded before reviewers' results were kept apart, skipped, missing), and the regressions charged or passed as unassigned, by severity. Units: counts of items and regressions. Coverage: only records stored by the cutoff count; an item without a reviewer's result is missing, never passed, and a worker's claim is never verification. It is a grader input, not a grade: final, provisional and ungraded belong to the grade reads (missing verification leaves the grade ungraded). ${COMPUTED}`,
    kind: 'read',
    input: { runId, ticketId, cutoff },
    run: (api, input) => api.getTicketPerformance(input)
  }),
  defineTool({
    name: 'get_escaped_defects',
    description: `Returns an epic's escaped defects as of a cutoff, resolved from the ledger: each defect (counted once however many reports fold into it) with its severity, attribution, discovery phase, origin, status (open, fixed, withdrawn) and records, plus anomalies such as conflicting reports. Units: counts of defects, never scores. Coverage: only records stored by the cutoff count; only attributed defects are charged in P. They are grader inputs, not a grade: final, provisional and ungraded belong to the grade reads. A record that changes charging comes only from a person at the desktop or a session that reviews work (an orchestrator or reviewer), never through this tool. ${COMPUTED}`,
    kind: 'read',
    input: { epicId, cutoff },
    run: (api, input) => api.getEscapedDefects(input)
  }),
  defineTool({
    name: 'get_run_efficiency',
    description: `Returns a run's E, T and K inputs as of a cutoff per ticket, per sprint and for the run (ticketId keeps one ticket): observed effort and its corrective and productive classification in milliseconds, actual tokens_total in tokens, the excluded waits, retries, and each ticket's baseline (budget or cohort) with its state. ${MEASURE_UNITS} These are grader inputs, not grades (final/provisional/ungraded belongs to the grade reads). ${COMPUTED}`,
    kind: 'read',
    input: { runId, ticketId: ticketId.optional().describe('Keeps only this ticket\'s entry.'), cutoff },
    run: (api, input) => api.getRunEfficiency(input)
  }),
  defineTool({
    name: 'get_run_timing',
    description: `Returns a run's time projection as of a cutoff (ticketId keeps only that ticket's entry): attempt elapsed, ticket cycle and lead time, measured active time, waits by class, resource effort and wall clock, each a quantity in milliseconds naming its kind, aggregation (single, union or sum), state (observed, estimated, partial as a lower bound, or missing as null, never 0), coverage and whether it is still open; plus anomalies. Measures, not grades (final/provisional/ungraded belongs to the grade reads). ${COMPUTED}`,
    kind: 'read',
    input: { runId, ticketId: ticketId.optional().describe('Keeps only this ticket\'s entry; `not_found` when the run holds no such ticket.'), cutoff },
    run: (api, input) => api.getRunTiming(input)
  }),
  defineTool({
    name: 'get_metrics_summary',
    description: `Returns the project metrics summary as of until: one row per epic (its grade with status final, provisional, ungraded, failed on a confirmed mandatory failure, or in_progress while a run is going; token total in tokens, active time and elapsed time in milliseconds, corrective share as a 0–1 fraction of classified time), totals recomputed from the raw measures of the epics that executed work (never an average of scores or letters), the distribution by grade status, the sprint trend (frozen report scorecards, else live grades, compared only when comparable), the weakest components and failures (gaps), and coverage: every unknown measure is null with its reason and reported lower bound, never 0. ${COMPUTED}`,
    kind: 'read',
    input: {
      epicIds: COMMAND_SCHEMAS.getMetricsSummary.shape.epicIds.describe('Optional: only these epics (each must exist); every epic when absent.'),
      since: COMMAND_SCHEMAS.getMetricsSummary.shape.since.describe(
        'Optional ISO 8601 window start with a Z or ±hh:mm offset. Filters rows and trend entries only; grades and measures still cover the whole history up to until.'
      ),
      until: COMMAND_SCHEMAS.getMetricsSummary.shape.until.describe(
        'Optional ISO 8601 cutoff with a Z or ±hh:mm offset (default now; a later time is clamped to now). Only records stored and epics created by then are read.'
      )
    },
    run: (api, input) => api.getMetricsSummary(input)
  })
]

export function registerMetricsTools(server: McpServer, api: CommandApi): void {
  registerTools(server, api, METRICS_TOOLS)
}
