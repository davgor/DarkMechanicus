/** Pure view model for a completed epic's overview: the recorded outcome and every sprint report. */
import type { CriterionResult, EpicDetailView, RunView, SprintReportView } from '../../../shared/domain/views'
import { formatAgo } from '../epic/time'
import type { OverviewData } from '../epic/workspaceState'
import { criterionLines, reportView, type CriterionLine, type ReportSections } from './gateView'

interface OverviewInput {
  epic: EpicDetailView
  run: RunView
  overview: OverviewData
  now: number
}

export interface OverviewView {
  /** "COMPLETED 40M AGO · RUN #1 · REV 1". */
  eyebrow: string
  /** The outcome summary; null when no outcome was recorded. */
  summary: string | null
  criteria: CriterionLine[]
  reports: { id: string; label: string; sections: ReportSections }[]
}

/** The outcome recorded when the epic completed, else the one its final sprint report proposed. */
function outcomeOf(input: OverviewInput): { summary: string; successCriteria: CriterionResult[] } | null {
  return input.epic.outcome ?? input.overview.reports.at(-1)?.report.epicOutcome ?? null
}

function reportLabel(report: SprintReportView, overview: OverviewData): string {
  const ordinal = overview.bundle?.sprints.find((item) => item.id === report.sprintId)?.ordinal
  return ordinal === undefined ? 'Sprint report' : `Sprint ${ordinal} report`
}

export function overviewView(input: OverviewInput): OverviewView {
  const { epic, run, overview, now } = input
  const outcome = outcomeOf(input)
  const context = { run, bundle: overview.bundle, now }
  const ended = formatAgo(epic.completedAt ?? run.endedAt, now)
  return {
    eyebrow: `COMPLETED ${ended} · RUN #${run.number} · REV ${run.revisionNumber}`.toUpperCase(),
    summary: outcome?.summary ?? null,
    criteria: criterionLines(outcome?.successCriteria ?? [], overview.bundle?.epic.successCriteria ?? epic.successCriteria),
    reports: overview.reports.map((report) => ({
      id: report.id,
      label: reportLabel(report, overview),
      // The overview shows the recorded outcome once, beside the reports.
      sections: { ...reportView(report, context), outcome: null }
    }))
  }
}
