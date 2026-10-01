/** Pure view model for the run bar: state pill, summary line, counts and available actions. */
import { isActiveRunState } from '../../../shared/domain/status'
import type { EpicDetailView, RunCounts, RunView } from '../../../shared/domain/views'
import { RUN_STATE_LABELS, RUN_STATE_TONES, type Tone } from '../graph/ticketStates'
import { formatAgo } from './time'

interface RunCountItem {
  key: keyof RunCounts
  label: string
  tone: Tone
}

export interface RunActions {
  pause: boolean
  resume: boolean
  cancel: boolean
  takeover: boolean
  /** "Sprint report" opens the checkpoint view. */
  report: boolean
}

export interface AdoptNotice {
  note: string
  enabled: boolean
  revisionId: string
}

const COUNT_ORDER: [keyof RunCounts, string, Tone][] = [
  ['accepted', 'accepted', 'accepted'],
  ['submitted', 'in review', 'review'],
  ['running', 'running', 'running'],
  ['ready', 'ready', 'ready'],
  ['waiting', 'waiting', 'waiting'],
  ['blocked', 'blocked', 'blocked'],
  ['needsReconciliation', 'needs reconciliation', 'blocked'],
  ['failed', 'failed', 'failed']
]

export function runLabel(run: RunView): string {
  return `Run #${run.number}`
}

export function runPill(run: RunView): { label: string; tone: Tone } {
  return { label: RUN_STATE_LABELS[run.state], tone: RUN_STATE_TONES[run.state] }
}

function sprintPart(run: RunView): string {
  return run.activeSprintOrdinal === null
    ? `${run.sprintCount} sprints`
    : `Sprint ${run.activeSprintOrdinal} of ${run.sprintCount}`
}

function phaseParts(run: RunView, now: number, reportAt: string | null): string[] {
  switch (run.state) {
    case 'queued':
      return [sprintPart(run), `queued ${formatAgo(run.createdAt, now)}`]
    case 'running':
      return [sprintPart(run), `started ${formatAgo(run.startedAt ?? run.createdAt, now)}`]
    case 'awaiting_checkpoint':
      return [
        `${sprintPart(run)} finished ${formatAgo(reportAt ?? run.updatedAt, now)}`,
        'no work is dispatched until you decide'
      ]
    case 'paused':
      return [sprintPart(run), run.pauseReason ? `paused: ${run.pauseReason}` : 'paused']
    default:
      return [`${run.state} ${formatAgo(run.endedAt ?? run.updatedAt, now)}`]
  }
}

/** "Run #2 · pinned to rev 4 · Sprint 2 of 3 · started 2h 14m ago · host Claude Code". */
export function runSummary(run: RunView, now: number, reportAt: string | null): string {
  const host = run.host ? [`host ${run.host.label}`] : []
  return [runLabel(run), `pinned to rev ${run.revisionNumber}`, ...phaseParts(run, now, reportAt), ...host].join(' · ')
}

/** Counts shown in the run bar; hidden while the run waits at a checkpoint (nothing is moving). */
export function runBarCounts(run: RunView): RunCountItem[] {
  return run.state === 'awaiting_checkpoint' ? [] : runCounts(run.counts)
}

export function runCounts(counts: RunCounts): RunCountItem[] {
  return COUNT_ORDER.filter(([key]) => counts[key] > 0).map(([key, label, tone]) => ({
    key,
    label: `${counts[key]} ${label}`,
    tone
  }))
}

export function runActions(run: RunView, hasCheckpoint: boolean): RunActions {
  const active = isActiveRunState(run.state)
  const owned = run.ownedByThisMachine
  return {
    pause: owned && (run.state === 'running' || run.state === 'queued'),
    resume: owned && run.state === 'paused',
    cancel: owned && active,
    takeover: active && !owned,
    report: hasCheckpoint
  }
}

/** A newer saved revision than the run's pinned one: adopt it at a checkpoint (or while paused). */
export function adoptNotice(run: RunView, epic: EpicDetailView): AdoptNotice | null {
  const current = epic.currentRevisionId
  if (current === null || current === run.revisionId || !isActiveRunState(run.state)) {
    return null
  }
  const atCheckpoint = run.state === 'awaiting_checkpoint' || run.state === 'paused'
  return {
    note: `Rev ${epic.currentRevisionNumber ?? ''} saved — adopt at the next checkpoint`,
    enabled: run.ownedByThisMachine && atCheckpoint,
    revisionId: current
  }
}
