/** Pure view model for the attempts strip under the graph (open and recent attempts). */
import { isOpenAttemptState } from '../../../shared/domain/status'
import type { AttemptView, RunView } from '../../../shared/domain/views'
import { ATTEMPT_LABELS, ATTEMPT_TONES, type Tone } from '../graph/ticketStates'
import { formatCountdown, formatElapsed } from './time'

interface StripItem {
  attemptId: string
  ticketId: string
  text: string
  tone: Tone
}

const STRIP_LIMIT = 3
const RECENT_LIMIT = 12
const NOTABLE = new Set<AttemptView['state']>(['failed', 'rejected', 'lease_expired'])

function leaseDetail(item: AttemptView, now: number): string {
  return item.leaseExpiresAt === null ? '' : `lease ${formatCountdown(item.leaseExpiresAt, now)}`
}

const DETAILS: Partial<Record<AttemptView['state'], (item: AttemptView, now: number) => string>> = {
  failed: (item) => item.failure?.reason ?? '',
  rejected: (item) => item.decision?.reasons[0] ?? '',
  lease_expired: () => 'needs reconciliation',
  claimed: leaseDetail,
  running: leaseDetail
}

function attemptDetail(item: AttemptView, now: number): string {
  return DETAILS[item.state]?.(item, now) ?? ''
}

/** "DM-202 #2 running · lease 04:12". */
export function attemptText(item: AttemptView, keys: ReadonlyMap<string, string>, now: number): string {
  const head = `${keys.get(item.ticketId) ?? item.ticketId} #${item.number} ${ATTEMPT_LABELS[item.state]}`
  const detail = attemptDetail(item, now)
  return detail === '' ? head : `${head} · ${detail}`
}

function byRecency(items: AttemptView[]): AttemptView[] {
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function toItem(item: AttemptView, keys: ReadonlyMap<string, string>, now: number): StripItem {
  return { attemptId: item.id, ticketId: item.ticketId, text: attemptText(item, keys, now), tone: ATTEMPT_TONES[item.state] }
}

/** Open attempts first (newest first), then failures that need attention. */
export function stripItems(run: RunView, keys: ReadonlyMap<string, string>, now: number): StripItem[] {
  const current = run.attempts.filter((item) => !item.superseded)
  const open = byRecency(current.filter((item) => isOpenAttemptState(item.state)))
  const notable = byRecency(current.filter((item) => NOTABLE.has(item.state)))
  return [...open, ...notable].slice(0, STRIP_LIMIT).map((item) => toItem(item, keys, now))
}

/** Every non-superseded attempt of the run, newest first (expanded strip). */
export function recentAttempts(run: RunView, keys: ReadonlyMap<string, string>, now: number): StripItem[] {
  return byRecency(run.attempts.filter((item) => !item.superseded))
    .slice(0, RECENT_LIMIT)
    .map((item) => toItem(item, keys, now))
}

export function syncedLabel(loadedAt: number | null, now: number): string {
  return loadedAt === null ? 'not synced yet' : `synced ${formatElapsed(now - loadedAt)}`
}
