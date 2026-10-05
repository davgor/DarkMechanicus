/**
 * Pure view model for the orchestrator entry in the run bar: the chip's label and the rows of the live
 * run feed. The run timeline arrives grouped by session; the feed merges the groups into one list,
 * newest first. Everything shown is text from the timeline and is rendered as plain text.
 */
import type { ActivityEntry, RunTimelineView } from '../../../shared/domain/activity'
import type { Tone } from '../graph/ticketStates'
import { formatAgo } from './time'

/** The chip's label until an orchestrator session has acted in the run. */
export const ORCHESTRATOR_FALLBACK = 'Orchestrator'

/** The label of the session whose role is orchestrator, else the fallback. */
export function orchestratorLabel(view: RunTimelineView | null): string {
  const group = view?.groups.find((item) => item.session.role === 'orchestrator')
  const label = group?.session.label.trim() ?? ''
  return label === '' ? ORCHESTRATOR_FALLBACK : label
}

interface FeedDetail {
  name: string
  value: string
}

export interface FeedRow {
  id: string
  /** When it happened (ISO 8601): where the row sits among the rows of the orchestrator's chat. */
  at: string
  /** Who did it: the label of the session the entry came under. */
  who: string
  when: string
  tone: Tone
  /** What happened, in a few words ("Claimed", "Run paused"). */
  label: string
  /** The ticket the entry is about, with its key when the plan knows it. */
  ticket: { id: string; key: string } | null
  text: string
  details: FeedDetail[]
}

interface Body {
  tone: Tone
  label: string
  text: string
  details?: FeedDetail[]
}

type Kind = ActivityEntry['kind']
type EntryOf<K extends Kind> = Extract<ActivityEntry, { kind: K }>
type Bodies = { [K in Kind]: (entry: EntryOf<K>) => Body }

const RUN_CHANGES: Record<EntryOf<'run'>['change'], { label: string; tone: Tone }> = {
  queued: { label: 'Run queued', tone: 'waiting' },
  started: { label: 'Run started', tone: 'running' },
  paused: { label: 'Run paused', tone: 'attention' },
  resumed: { label: 'Run resumed', tone: 'running' },
  leases_extended: { label: 'Leases extended', tone: 'neutral' },
  completed: { label: 'Run completed', tone: 'accepted' },
  canceled: { label: 'Run canceled', tone: 'failed' },
  failed: { label: 'Run failed', tone: 'failed' },
  taken_over: { label: 'Run taken over', tone: 'attention' }
}

function claimDetails(worker: EntryOf<'claim'>['worker']): FeedDetail[] {
  const details: FeedDetail[] = []
  if (worker.modelId !== null) {
    details.push({ name: 'Model', value: worker.modelId })
  }
  if (worker.effort !== null) {
    details.push({ name: 'Effort', value: worker.effort })
  }
  if (worker.rationale !== null && worker.rationale !== '') {
    details.push({ name: 'Why', value: worker.rationale })
  }
  return details
}

function withRetry(text: string, entry: { retryable: boolean }): string {
  return entry.retryable ? `${text} (can retry)` : text
}

const BODIES: Bodies = {
  run: (entry) => ({ ...RUN_CHANGES[entry.change], text: entry.reason ?? '' }),
  claim: (entry) => ({
    tone: 'running',
    label: 'Claimed',
    text: `attempt #${entry.number} by ${entry.worker.label}`,
    details: claimDetails(entry.worker)
  }),
  carried_forward: (entry) => ({ tone: 'accepted', label: 'Carried forward', text: entry.note }),
  alive: (entry) => ({ tone: 'running', label: 'Alive', text: entry.active ? 'holding its lease' : 'lease released' }),
  note: (entry) => ({ tone: 'neutral', label: 'Progress', text: entry.text }),
  comment: (entry) => ({ tone: 'neutral', label: 'Comment', text: `${entry.author.label}: ${entry.body}` }),
  submitted: (entry) => ({ tone: 'review', label: 'Submitted', text: entry.summary }),
  decision: (entry) => ({
    tone: entry.outcome === 'accepted' ? 'accepted' : 'failed',
    label: entry.outcome === 'accepted' ? 'Accepted' : 'Rejected',
    text: entry.reasons.length > 0 ? entry.reasons.join('; ') : entry.notes
  }),
  failed: (entry) => ({ tone: 'failed', label: 'Failed', text: withRetry(entry.reason, entry) }),
  lease_expired: (entry) => ({
    tone: 'blocked',
    label: 'Lease expired',
    text: entry.cause === 'timeout' ? 'the lease ran out' : 'the run moved to another machine'
  }),
  reconciled: (entry) => ({
    tone: 'attention',
    label: 'Reconciled',
    text: entry.resolution === 'abandon' ? 'abandoned' : 'resubmitted'
  }),
  canceled: (entry) => ({ tone: 'failed', label: 'Canceled', text: entry.reason ?? 'the run ended' }),
  report: (entry) => ({ tone: 'review', label: 'Sprint report', text: `revision ${entry.reportRevision}` }),
  checkpoint: (entry) => ({
    tone: 'attention',
    label: entry.step === 'approved' ? 'Checkpoint approved' : 'Sprint advanced',
    text: entry.policy === 'auto' ? 'automatically' : entry.policy === 'human' ? 'by a person' : ''
  })
}

function bodyOf(entry: ActivityEntry): Body {
  const body = BODIES[entry.kind] as (entry: ActivityEntry) => Body
  return body(entry)
}

function ticketOf(entry: ActivityEntry, keys: ReadonlyMap<string, string>): FeedRow['ticket'] {
  const id = 'ticketId' in entry ? entry.ticketId : null
  return id === null ? null : { id, key: keys.get(id) ?? id }
}

const newestFirst = (a: { at: string; id: string }, b: { at: string; id: string }): number =>
  b.at.localeCompare(a.at) || b.id.localeCompare(a.id, undefined, { numeric: true })

/** What a row of the orchestrator's chat says under its text: that it is chat, and how long ago (a text still being written is happening now). */
export function streamMeta(at: string | null, now: number): string {
  return at === null ? 'Chat · just now' : `Chat · ${formatAgo(at, now)}`
}

/** The run's entries from every session as one list, newest first; ticket ids are shown as their keys when known. */
export function feedRows(view: RunTimelineView | null, keys: ReadonlyMap<string, string>, now: number): FeedRow[] {
  const entries = (view?.groups ?? []).flatMap((group) => group.entries.map((entry) => ({ entry, who: group.session.label })))
  return entries
    .sort((a, b) => newestFirst(a.entry, b.entry))
    .map(({ entry, who }) => {
      const body = bodyOf(entry)
      return {
        id: entry.id,
        at: entry.at,
        who,
        when: formatAgo(entry.at, now),
        tone: body.tone,
        label: body.label,
        ticket: ticketOf(entry, keys),
        text: body.text,
        details: body.details ?? []
      }
    })
}
