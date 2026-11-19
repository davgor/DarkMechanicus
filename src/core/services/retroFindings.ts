/**
 * The retro findings of a sprint report revision (`src/core/plan/retroFindings.ts`), read from the scorecard frozen with
 * it. Derived on every read and never stored: they follow from the frozen snapshot alone, so they never change after
 * submission and are not part of the report's content hash. Tickets are named by the key and title the run's plan gives
 * them, so a reader (MCP included) sees `DM-3 "…"` rather than an internal id.
 */
import type { RetroFindingsView } from '../../shared/domain/retroFindings'
import type { GetReportScorecardInput } from '../../shared/domain/scoreReads'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { deriveRetroFindings } from '../plan/retroFindings'
import { loadBundle, requireRun } from './execution'
import { getReportScorecard } from './scorecards'

/**
 * The ranked findings of the scorecard frozen with a report revision (checked against its seal and regraded as
 * `getReportScorecard` reads it). A report submitted before scorecards were frozen has none: `conflict`.
 */
export function getRetroFindings(ctx: Ctx, input: GetReportScorecardInput): RetroFindingsView {
  const read = getReportScorecard(ctx, input)
  if (read.state === 'legacy') {
    fail('conflict', `Report ${read.report.reportId} was submitted before scorecards were frozen with reports, so it has no measured findings.`, {
      reportId: read.report.reportId
    })
  }
  const { snapshot } = read.scorecard
  const tickets = new Map(loadBundle(ctx, requireRun(ctx, snapshot.runId).revision_id).tickets.map((ticket) => [ticket.id, { key: ticket.key, title: ticket.title }]))
  return deriveRetroFindings(snapshot, { names: (ticketId) => tickets.get(ticketId) ?? null })
}
