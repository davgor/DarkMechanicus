/**
 * The run's pipeline (the comms pane's Pipeline tab, and read-only in the Past runs drawer): every message between the
 * run's members and every run event, oldest first, each headed by its sender's display name, role and roster colour,
 * sender → recipients, time and kind. An `order_all` reads `<Magos> → all (N)` and expands to its recipients. A filter
 * keeps one member's entries. A live run's timeline follows the newest entry unless the person has scrolled up.
 *
 * Bodies and summaries are other agents' text: React renders them as text, never parsed as HTML or Markdown.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { CultMemberDetail, CultPipelineEntry, CultRunDetail, PipelineMember } from '../../../shared/cults/cultApi'
import type { Scheduler } from '../app/scheduler'
import { Button } from '../components/Button'
import { memberColor } from './memberColors'
import { useCultPipeline } from './useCultPipeline'
import './pipeline.css'

interface PipelinePanelProps {
  run: CultRunDetail
  /** Follows the run live on this scheduler; null shows a past run once, read-only. */
  live: Scheduler | null
}

/** How close to the bottom still counts as following the newest entry, in pixels. */
const FOLLOW_SLACK_PX = 24

/** Each member's colour as the roster draws it: the Magos's red, an acolyte's hue by its place among the run's acolytes. */
function colours(members: readonly CultMemberDetail[]): Map<string, string> {
  const acolytes = [...members].filter((member) => member.role === 'acolyte').sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
  return new Map(members.map((member) => [member.chatId, member.role === 'magos' ? 'var(--primary)' : memberColor(acolytes.indexOf(member))]))
}

const involves = (entry: CultPipelineEntry, chatId: string): boolean =>
  entry.sender?.chatId === chatId || entry.recipients.some((member) => member.chatId === chatId)

export function PipelinePanel({ run, live }: PipelinePanelProps): JSX.Element {
  const members = run.members
  const memberChatIds = useMemo(() => members.map((member) => member.chatId), [members])
  const { state, fullText } = useCultPipeline(run.run.id, { live, memberChatIds })
  const [filter, setFilter] = useState('')
  const colourOf = useMemo(() => colours(members), [members])
  const left = useMemo(() => new Set(members.filter((member) => member.leftAt !== null).map((member) => member.chatId)), [members])
  const shown = filter === '' ? state.entries : state.entries.filter((entry) => involves(entry, filter))
  const name = { colourOf, left }
  return (
    <section className="cult-pipeline" aria-label="Pipeline" data-live={live !== null}>
      <header className="cult-pipeline-head">
        <label className="cult-pipeline-filter">
          <span>Member</span>
          <select aria-label="Filter by member" value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="">Everyone</option>
            {members.map((member) => <option key={member.chatId} value={member.chatId}>{member.displayName}</option>)}
          </select>
        </label>
        {state.status === 'error' ? <span className="cult-refusal" role="alert">{state.message}</span> : null}
      </header>
      {state.status === 'loading' ? <p className="cult-empty-note" role="status">Loading the pipeline…</p>
        : shown.length === 0 ? <p className="cult-empty-note">{filter === '' ? 'Nothing has happened in this run yet.' : 'No entries for this member.'}</p>
          : <Timeline entries={shown} follow={live !== null} name={name} fullText={fullText} />}
    </section>
  )
}

interface Naming {
  colourOf: ReadonlyMap<string, string>
  left: ReadonlySet<string>
}

interface TimelineProps {
  entries: readonly CultPipelineEntry[]
  follow: boolean
  name: Naming
  fullText(seq: number): Promise<string | null>
}

/** The entries, kept scrolled to the newest while the person has not scrolled up. */
function Timeline({ entries, follow, name, fullText }: TimelineProps): JSX.Element {
  const list = useRef<HTMLOListElement>(null)
  const [following, setFollowing] = useState(true)
  const newest = entries.at(-1)?.seq
  useEffect(() => {
    const element = list.current
    if (follow && following && element !== null) element.scrollTop = element.scrollHeight
  }, [follow, following, newest])
  const onScroll = (): void => {
    const element = list.current
    if (element !== null) setFollowing(element.scrollTop + element.clientHeight >= element.scrollHeight - FOLLOW_SLACK_PX)
  }
  return (
    <div className="cult-pipeline-body">
      <ol ref={list} className="cult-pipeline-list" aria-label="Pipeline entries" onScroll={onScroll}>
        {entries.map((entry) => <EntryRow key={entry.seq} entry={entry} name={name} fullText={fullText} />)}
      </ol>
      {follow && !following ? (
        <Button size="sm" className="cult-pipeline-jump" onClick={() => setFollowing(true)}>Jump to newest</Button>
      ) : null}
    </div>
  )
}

const ROLE_TEXT = { magos: 'Magos', acolyte: 'Acolyte' } as const

/** A member's name in its colour, with its role, and marked when it has left the run. */
function MemberName({ member, name }: { member: PipelineMember; name: Naming }): JSX.Element {
  return (
    <span className="cult-pipe-member" style={{ '--member-color': name.colourOf.get(member.chatId) ?? 'var(--muted)' } as CSSProperties}>
      <span className="cult-pipe-swatch" aria-hidden="true" />
      <span className="cult-pipe-name">{member.displayName}</span>
      <span className="cult-pipe-role">{ROLE_TEXT[member.role]}</span>
      {name.left.has(member.chatId) ? <span className="cult-pipe-left">left</span> : null}
    </span>
  )
}

function kindText(entry: CultPipelineEntry): string {
  if (entry.kind === 'message') return entry.inReplyTo === null ? 'message' : 'reply'
  return (entry.eventKind ?? 'event').replace(/_/g, ' ')
}

interface EntryProps {
  entry: CultPipelineEntry
  name: Naming
  fullText(seq: number): Promise<string | null>
}

function EntryRow({ entry, name, fullText }: EntryProps): JSX.Element {
  return (
    <li className={`cult-pipe-entry is-${entry.kind}`} data-seq={entry.seq} data-kind={entry.kind}>
      <div className="cult-pipe-meta">
        {entry.sender === null ? <span className="cult-pipe-system">Run</span> : <MemberName member={entry.sender} name={name} />}
        <Recipients entry={entry} name={name} />
        <span className="cult-pipe-kind badge">{kindText(entry)}</span>
        <time className="cult-pipe-time mono" dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString()}</time>
      </div>
      <Body entry={entry} fullText={fullText} />
      {entry.kind === 'order_all' ? (
        <details className="cult-pipe-recipients">
          <summary>{`Recipients of order ${entry.orderId ?? ''}`}</summary>
          <ul>{entry.recipients.map((member) => <li key={member.displayName}><MemberName member={member} name={name} /></li>)}</ul>
        </details>
      ) : null}
    </li>
  )
}

function Recipients({ entry, name }: { entry: CultPipelineEntry; name: Naming }): JSX.Element | null {
  if (entry.kind === 'order_all') return <span className="cult-pipe-to">{`→ all (${entry.recipients.length})`}</span>
  if (entry.recipients.length === 0) return null
  return (
    <span className="cult-pipe-to">
      <span aria-hidden="true">→</span>
      {entry.recipients.map((member) => <MemberName key={member.chatId} member={member} name={name} />)}
    </span>
  )
}

/** The entry's text as text; a preview offers the whole message. */
function Body({ entry, fullText }: { entry: CultPipelineEntry; fullText(seq: number): Promise<string | null> }): JSX.Element {
  const [whole, setWhole] = useState<string | null>(null)
  return (
    <>
      <p className="cult-pipe-text">{whole ?? entry.text}</p>
      {entry.truncated && whole === null ? (
        <Button size="sm" variant="ghost" onClick={() => void fullText(entry.seq).then((text) => text !== null && setWhole(text))}>Show whole message</Button>
      ) : null}
    </>
  )
}
