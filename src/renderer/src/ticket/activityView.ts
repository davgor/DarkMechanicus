/**
 * Pure view model for the ticket panel's Activity tab: turns an attempt's timeline entries into rows a person
 * can read, says how a closed attempt ended, and decides when the log should follow its newest row. Text that
 * workers or people wrote (notes, comments, reasons) is passed through untouched; the tab renders it as plain text.
 */
import type { ActivityEntry, AttemptTimelineView } from '../../../shared/domain/activity'
import type { AttemptState } from '../../../shared/domain/status'
import type { AttemptView } from '../../../shared/domain/views'
import type { RowWindow } from '../agents/threadStream'
import { ATTEMPT_LABELS, ATTEMPT_TONES, type Tone } from '../graph/ticketStates'

export interface ActivityItem {
  id: string
  kind: ActivityEntry['kind']
  tone: Tone
  /** When it happened (ISO 8601), for the machine-readable time of the row. */
  at: string
  title: string
  /** Further lines (separated by "\n"); empty when the title says it all. */
  detail: string
  /** The clock time of the row; empty for the alive span, whose title carries its own times. */
  when: string
}

interface Described {
  tone: Tone
  title: string
  detail?: string
  /** The row's title already names its times: leave the time column empty. */
  timed?: boolean
}

type Of<K extends ActivityEntry['kind']> = Extract<ActivityEntry, { kind: K }>

/** Hours and minutes on a 24-hour clock ("14:02"), in `timeZone` or the person's own; unreadable input is kept as it is. */
export function clockTime(iso: string, timeZone?: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) {
    return iso
  }
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(at)
}

function lines(...parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => part !== null && part !== undefined && part.trim() !== '').join('\n')
}

function claimDetail(entry: Of<'claim'>): string {
  const { worker } = entry
  const head = [`Attempt #${entry.number}`, worker.modelId, worker.effort === null ? null : `${worker.effort} effort`]
  return lines(head.filter((part) => part !== null).join(' · '), worker.rationale)
}

function decisionDetail(entry: Of<'decision'>): string {
  return lines(...entry.reasons, entry.notes)
}

const CAUSES: Record<Of<'lease_expired'>['cause'], string> = {
  timeout: 'Lease expired',
  takeover: 'Run moved to another machine'
}

const CAUSE_DETAILS: Record<Of<'lease_expired'>['cause'], string> = {
  timeout: 'The worker stopped reporting. The attempt needs reconciling.',
  takeover: 'The attempt needs reconciling.'
}

function aliveSpan(entry: Of<'alive'>, zone: string | undefined): Described {
  const from = clockTime(entry.at, zone)
  const until = clockTime(entry.until, zone)
  const title = entry.active ? `Working since ${from}, last seen ${until}` : `Worked from ${from} to ${until}`
  return { tone: 'running', title, timed: true }
}

type Describers = { [K in ActivityEntry['kind']]: (entry: Of<K>, zone: string | undefined) => Described }

const DESCRIBERS: Describers = {
  claim: (entry) => ({ tone: 'neutral', title: `Claimed by ${entry.worker.label}`, detail: claimDetail(entry) }),
  carried_forward: (entry) => ({ tone: 'accepted', title: 'Carried forward from an earlier run', detail: entry.note }),
  alive: aliveSpan,
  note: (entry) => ({ tone: 'neutral', title: entry.text, detail: entry.step === null ? '' : `Step: ${entry.step}` }),
  comment: (entry) => ({ tone: 'neutral', title: `${entry.author.label} commented`, detail: entry.body }),
  submitted: (entry) => ({ tone: 'review', title: 'Submitted for review', detail: entry.summary }),
  decision: (entry) => ({
    tone: entry.outcome === 'accepted' ? 'accepted' : 'failed',
    title: `${entry.outcome === 'accepted' ? 'Accepted' : 'Rejected'} by ${entry.decidedBy}`,
    detail: decisionDetail(entry)
  }),
  failed: (entry) => ({ tone: 'failed', title: entry.retryable ? 'Failed, can retry' : 'Failed', detail: entry.reason }),
  lease_expired: (entry) => ({ tone: 'blocked', title: CAUSES[entry.cause], detail: CAUSE_DETAILS[entry.cause] }),
  reconciled: (entry) => ({ tone: 'neutral', title: `Reconciled: ${entry.resolution === 'abandon' ? 'abandoned' : 'resubmitted'}` }),
  canceled: (entry) => ({ tone: 'neutral', title: 'Canceled with the run', detail: entry.reason ?? '' }),
  run: (entry) => ({ tone: 'neutral', title: `Run ${entry.change.replaceAll('_', ' ')}`, detail: entry.reason ?? '' }),
  report: () => ({ tone: 'neutral', title: 'Sprint report filed' }),
  checkpoint: (entry) => ({
    tone: 'neutral',
    title: entry.step === 'approved' ? 'Checkpoint approved' : 'Run advanced to the next sprint'
  })
}

function describe(entry: ActivityEntry, zone: string | undefined): Described {
  const describer = DESCRIBERS[entry.kind] as (entry: ActivityEntry, zone: string | undefined) => Described
  return describer(entry, zone)
}

/** One row per entry, in the order given (oldest first). `zone` is for tests; people see their own time zone. */
export function activityItems(entries: readonly ActivityEntry[], zone?: string): ActivityItem[] {
  return entries.map((entry) => {
    const described = describe(entry, zone)
    return {
      id: entry.id,
      kind: entry.kind,
      tone: described.tone,
      at: entry.at,
      title: described.title,
      detail: described.detail ?? '',
      when: described.timed === true ? '' : clockTime(entry.at, zone)
    }
  })
}

interface EndedSummary {
  /** The state the attempt ended in ("Rejected"). */
  label: string
  tone: Tone
  /** The record's own words on why or by whom; empty when it has none. */
  detail: string
}

function lastOf<K extends ActivityEntry['kind']>(entries: readonly ActivityEntry[], kind: K): Of<K> | undefined {
  const matching = entries.filter((entry): entry is Of<K> => entry.kind === kind)
  return matching[matching.length - 1]
}

function decided(entries: readonly ActivityEntry[], outcome: Of<'decision'>['outcome']): string {
  const entry = lastOf(entries, 'decision')
  if (entry === undefined || entry.outcome !== outcome) {
    return ''
  }
  const head = `${outcome === 'accepted' ? 'Accepted' : 'Rejected'} by ${entry.decidedBy}`
  const why = entry.reasons.join('; ')
  return why === '' ? head : `${head}: ${why}`
}

function expiredDetail(entries: readonly ActivityEntry[]): string {
  const reconciled = lastOf(entries, 'reconciled')
  if (reconciled !== undefined) {
    return `Reconciled: ${reconciled.resolution === 'abandon' ? 'abandoned' : 'resubmitted'}`
  }
  const expired = lastOf(entries, 'lease_expired')
  if (expired?.cause === 'takeover') {
    return 'The run moved to another machine. The attempt needs reconciling.'
  }
  return expired === undefined ? '' : CAUSE_DETAILS.timeout
}

const ENDINGS: Partial<Record<AttemptState, (entries: readonly ActivityEntry[]) => string>> = {
  accepted: (entries) => decided(entries, 'accepted'),
  rejected: (entries) => decided(entries, 'rejected'),
  failed: (entries) => lastOf(entries, 'failed')?.reason ?? '',
  canceled: (entries) => lastOf(entries, 'canceled')?.reason ?? 'The run ended while the attempt was open.',
  lease_expired: expiredDetail
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

/** How a closed attempt ended; null while the attempt is still open. */
export function endedSummary(view: Pick<AttemptTimelineView, 'state' | 'isLive' | 'entries'>): EndedSummary | null {
  if (view.isLive) {
    return null
  }
  const detail = ENDINGS[view.state]?.(view.entries) ?? ''
  return { label: capitalized(ATTEMPT_LABELS[view.state]), tone: ATTEMPT_TONES[view.state], detail }
}

/** When an entry stopped: a worker seen alive was working until its last heartbeat, anything else is a moment. */
function endOf(entry: ActivityEntry): string {
  return entry.kind === 'alive' ? entry.until : entry.at
}

/**
 * The attempt's own stretch of time, for telling its rows apart from the other attempts' in a chat thread
 * that served several: from its claim to its end (the last thing on record, once it is closed), and to now
 * while it is open. A bound without anything to give it is open.
 */
export function attemptWindow(view: Pick<AttemptTimelineView, 'isLive' | 'entries'>): RowWindow {
  const from = view.entries.find((entry) => entry.kind === 'claim')?.at ?? null
  if (view.isLive) {
    return { from, to: null }
  }
  const ends = view.entries.map(endOf).sort((a, b) => Date.parse(a) - Date.parse(b))
  return { from, to: ends[ends.length - 1] ?? null }
}

/** The attempt the tab shows when none was asked for: the ticket's latest that is still current, else its latest at all. */
export function latestAttemptId(attempts: readonly Pick<AttemptView, 'id' | 'number' | 'superseded'>[]): string | null {
  const current = attempts.filter((item) => !item.superseded)
  const pool = current.length === 0 ? attempts : current
  const latest = pool.reduce<(typeof pool)[number] | null>((best, item) => (best === null || item.number > best.number ? item : best), null)
  return latest === null ? null : latest.id
}

/** Pixels from the end of the log that still count as being at the end. */
const FOLLOW_SLACK = 24

interface ScrollBox {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** True while the log sits at (or within a few pixels of) its newest row: the tab keeps following it. */
export function isNearBottom(box: ScrollBox): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= FOLLOW_SLACK
}
