/**
 * Human durations for cult time limits and shutdown timings: `90s`, `1m`, `45 min`, `90h`, `90hr`, `2d` and
 * combinations such as `1d 6h`. Whole units only; no zero, negative or unknown units. Pure, shared with the renderer.
 */

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const UNIT_MS: Readonly<Record<string, number>> = {
  s: SECOND,
  sec: SECOND,
  secs: SECOND,
  second: SECOND,
  seconds: SECOND,
  m: MINUTE,
  min: MINUTE,
  mins: MINUTE,
  minute: MINUTE,
  minutes: MINUTE,
  h: HOUR,
  hr: HOUR,
  hrs: HOUR,
  hour: HOUR,
  hours: HOUR,
  d: DAY,
  day: DAY,
  days: DAY
}

/** The shortest time limit a run may have; shorter limits are refused, longer ones have no upper bound. */
const MIN_TIME_LIMIT_MS = MINUTE

/** Words that mean "no time limit" in a time-limit field. */
const UNLIMITED_WORDS: Readonly<Record<string, true>> = { unlimited: true, none: true, 'no limit': true }

type DurationResult = { ok: true; ms: number } | { ok: false; error: string }
type TimeLimitResult = { ok: true; ms: number | null } | { ok: false; error: string }

const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error })

/** One `<count><unit>` term, optionally spaced, anchored at `lastIndex`. */
const TERM = /\s*(\d+)\s*([a-z]+)\s*/y

/** Parses a positive duration into milliseconds, or says why it is refused. */
export function parseDuration(text: string): DurationResult {
  const input = text.trim().toLowerCase()
  if (!input) return refuse('Enter a duration such as 90m, 2d or 1d 6h.')
  if (input.startsWith('-')) return refuse('A duration cannot be negative.')
  let ms = 0
  let index = 0
  while (index < input.length) {
    TERM.lastIndex = index
    const match = TERM.exec(input)
    if (!match) return refuse(`"${text.trim()}" is not a duration; use whole numbers with s, m, h or d.`)
    const unit = UNIT_MS[match[2]]
    if (unit === undefined) return refuse(`Unknown unit "${match[2]}"; use s, m, h or d.`)
    ms += Number(match[1]) * unit
    index = TERM.lastIndex
  }
  if (ms <= 0) return refuse('A duration must be greater than zero.')
  if (!Number.isSafeInteger(ms)) return refuse('That duration is too long.')
  return { ok: true, ms }
}

/** Parses a run time limit: `unlimited` (null), or a duration of at least one minute with no upper bound. */
export function parseTimeLimit(text: string): TimeLimitResult {
  if (UNLIMITED_WORDS[text.trim().toLowerCase()]) return { ok: true, ms: null }
  const parsed = parseDuration(text)
  if (!parsed.ok) return parsed
  if (parsed.ms < MIN_TIME_LIMIT_MS) return refuse('A time limit must be at least 1 minute, or unlimited.')
  return parsed
}

const FORMAT_UNITS: readonly (readonly [string, number])[] = [
  ['d', DAY],
  ['h', HOUR],
  ['m', MINUTE],
  ['s', SECOND]
]

/** Formats milliseconds (rounded to whole seconds) as `1d 6h`, `1h 30m` or `45s`; `parseDuration` reads it back. */
export function formatDuration(ms: number): string {
  let rest = Math.max(0, Math.round(ms / SECOND)) * SECOND
  const parts: string[] = []
  for (const [unit, size] of FORMAT_UNITS) {
    const count = Math.floor(rest / size)
    rest -= count * size
    if (count > 0) parts.push(`${count}${unit}`)
  }
  return parts.length > 0 ? parts.join(' ') : '0s'
}
