import type { PlanBundle } from '../../shared/domain/bundle'
import type { ValidationReport } from '../../shared/domain/views'
import type { Ctx } from '../context'
import { runAwareWarnings } from '../plan/runWarnings'
import { activeRun } from './epics'
import { loadBundle, requireRun } from './execution'

/**
 * The validation report with the run-aware warnings of the epic's active run added (editing a sprint the run has
 * passed, inserting a sprint before the active one). Without a run that has started a sprint, the report is
 * returned as it is. The warnings never change `valid`.
 */
export function withRunWarnings(ctx: Ctx, epicId: string, bundle: PlanBundle, report: ValidationReport): ValidationReport {
  const found = activeRun(ctx, epicId)
  const run = found === null ? null : requireRun(ctx, found.id)
  if (run === null || run.active_sprint_id === null) {
    return report
  }
  const warnings = runAwareWarnings(bundle, {
    number: run.number,
    activeSprintId: run.active_sprint_id,
    bundle: loadBundle(ctx, run.revision_id)
  })
  return warnings.length === 0 ? report : { ...report, warnings: [...report.warnings, ...warnings] }
}
