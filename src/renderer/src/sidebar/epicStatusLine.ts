import type { RunState } from '../../../shared/domain/status'
import type { EpicSummaryView, RunSummaryView } from '../../../shared/domain/views'

type StatusTone =
  | 'running'
  | 'attention'
  | 'paused'
  | 'queued'
  | 'failed'
  | 'draft'
  | 'completed'
  | 'idle'

export interface EpicStatusLine {
  text: string
  tone: StatusTone
}

interface EpicBadge {
  kind: 'draft' | 'save-pending' | 'conflict'
  label: string
  title: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Sep 30, 2026" — unparseable input is returned unchanged. */
export function formatShortDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}

const FIXED_RUN_LINES: Partial<Record<RunState, EpicStatusLine>> = {
  awaiting_checkpoint: { text: 'Awaiting checkpoint', tone: 'attention' },
  paused: { text: 'Paused', tone: 'paused' },
  queued: { text: 'Queued', tone: 'queued' },
  failed: { text: 'Run failed', tone: 'failed' },
  canceled: { text: 'Run canceled', tone: 'idle' }
}

function runningText(run: RunSummaryView): string {
  const inSprint = run.activeSprintOrdinal !== null && run.sprintCount > 0
  return inSprint ? `Running · Sprint ${run.activeSprintOrdinal}/${run.sprintCount}` : 'Running'
}

function runLine(run: RunSummaryView): EpicStatusLine | null {
  if (run.state === 'running') {
    return { text: runningText(run), tone: 'running' }
  }
  return FIXED_RUN_LINES[run.state] ?? null
}

function completedLine(epic: EpicSummaryView): EpicStatusLine {
  const text = epic.completedAt ? `Completed ${formatShortDate(epic.completedAt)}` : 'Completed'
  return { text, tone: 'completed' }
}

/** The one-line status shown under an epic title: run condition first, then draft/backlog state. */
export function epicStatusLine(epic: EpicSummaryView): EpicStatusLine {
  if (epic.status === 'completed') {
    return completedLine(epic)
  }
  const fromRun = epic.run ? runLine(epic.run) : null
  if (fromRun) {
    return fromRun
  }
  if (epic.currentRevisionId === null) {
    return { text: 'Draft · not saved', tone: 'draft' }
  }
  return epic.status === 'in_progress'
    ? { text: 'In progress', tone: 'idle' }
    : { text: 'Not started', tone: 'idle' }
}

/**
 * Draft indicators are badges, never another bucket. A draft that still matches the saved plan (just
 * opened with Edit draft) has nothing unsaved, so it gets no badge.
 */
export function epicBadges(epic: EpicSummaryView): EpicBadge[] {
  const badges: EpicBadge[] = []
  if (epic.draftChanged) {
    badges.push({ kind: 'draft', label: 'draft', title: 'Has unsaved draft changes' })
  }
  if (epic.pendingSave) {
    badges.push({
      kind: 'save-pending',
      label: 'save pending',
      title: 'Saved, but not yet written to the repository'
    })
  }
  if (epic.conflict !== null) {
    badges.push({ kind: 'conflict', label: 'conflict', title: epic.conflict })
  }
  return badges
}
