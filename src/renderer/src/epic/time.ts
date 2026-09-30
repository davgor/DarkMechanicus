/** Relative-time formatting for run, attempt and sync labels. `now` is always injected. */

const SECOND = 1_000
const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

function elapsedSince(timestamp: string | null, now: number): number | null {
  const at = timestamp === null ? Number.NaN : Date.parse(timestamp)
  return Number.isNaN(at) ? null : now - at
}

/** "just now", "12s ago", "12m ago", "2h 14m ago", "3d ago". */
export function formatElapsed(ms: number): string {
  if (ms < SECOND) {
    return 'just now'
  }
  if (ms < MINUTE) {
    return `${Math.floor(ms / SECOND)}s ago`
  }
  if (ms < HOUR) {
    return `${Math.floor(ms / MINUTE)}m ago`
  }
  if (ms < DAY) {
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    const hours = `${Math.floor(ms / HOUR)}h`
    return minutes === 0 ? `${hours} ago` : `${hours} ${minutes}m ago`
  }
  return `${Math.floor(ms / DAY)}d ago`
}

export function formatAgo(timestamp: string | null, now: number): string {
  const elapsed = elapsedSince(timestamp, now)
  return elapsed === null ? '' : formatElapsed(elapsed)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Time left until `timestamp` as mm:ss ("00:00" once it has passed). */
export function formatCountdown(timestamp: string | null, now: number): string {
  const elapsed = elapsedSince(timestamp, now)
  if (elapsed === null) {
    return ''
  }
  const seconds = Math.max(0, Math.ceil(-elapsed / SECOND))
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`
}
