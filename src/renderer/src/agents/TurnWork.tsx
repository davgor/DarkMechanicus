/**
 * The live chat's transcript grouped by turn (`turnGroups`): each ended turn's work behind one `Worked for 28m 51s ›`
 * disclosure, opened in place. Which turns are open is kept here, in memory only; every turn starts folded, and a
 * request to reveal a thread (`RevealThreadContext`) opens the turn that holds it once per request.
 */
import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AgentChatSnapshot } from '../../../shared/agents/agentChat'
import { turnGroups, workLabel, type TurnEntry } from '../agentChat/turnGroups'
import type { TranscriptEntry } from './chatViewModel'
import { RevealThreadContext } from './revealThread'
import type { TreeRow } from './threadModel'
import './turnWork.css'

interface Placed {
  entry: TurnEntry
  rows: TreeRow[]
}

/** Each top-level tree row under the entry holding its item; a lost thread's made-up block goes where its first item is. */
function placeRows(entries: readonly TurnEntry[], rows: readonly TreeRow[]): Placed[] {
  const place = new Map<string, number>()
  entries.forEach((entry, index) => {
    for (const item of entry.kind === 'collapsed-work' ? entry.items : [entry.item]) place.set(item.id, index)
  })
  const placed = entries.map((entry): Placed => ({ entry, rows: [] }))
  let at = 0
  for (const row of rows) {
    at = place.get(row.entry.id) ?? place.get(row.threads[0]?.rows[0]?.entry.id ?? '') ?? at
    placed[at]?.rows.push(row)
  }
  return placed
}

interface WorkProps {
  work: Extract<TurnEntry, { kind: 'collapsed-work' }>
  rows: readonly TreeRow[]
  open: boolean
  toggle(): void
  renderRow(row: TreeRow): JSX.Element
}

function WorkDisclosure({ work, rows, open, toggle, renderRow }: WorkProps): JSX.Element {
  const id = useId()
  return (
    <li className="chat-work">
      <button type="button" className="chat-work-toggle" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
        {workLabel(work)}
        <span className="chat-work-chevron" aria-hidden="true">›</span>
      </button>
      {open ? <ol id={id} className="chat-work-rows" aria-label="Work">{rows.map(renderRow)}</ol> : null}
    </li>
  )
}

interface TurnRowsProps {
  entries: readonly TranscriptEntry[]
  /** `transcriptTree(entries)`: the rows to place. */
  rows: readonly TreeRow[]
  status: AgentChatSnapshot['status'] | null
  renderRow(row: TreeRow): JSX.Element
  /** What shows before a row and stays outside any fold (the mail cards placed before it); a folded turn shows its rows' ahead of its disclosure. */
  before?(row: TreeRow): JSX.Element[]
}

const NOTHING_BEFORE = (): JSX.Element[] => []

export function TurnRows({ entries, rows, status, renderRow, before = NOTHING_BEFORE }: TurnRowsProps): JSX.Element {
  const placed = useMemo(() => placeRows(turnGroups(entries, status), rows), [entries, rows, status])
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const reveal = useContext(RevealThreadContext)
  const revealed = useRef(0)
  useEffect(() => {
    if (revealed.current === reveal.nonce) return
    revealed.current = reveal.nonce
    const holding = placed.flatMap(({ entry }) =>
      entry.kind === 'collapsed-work' && entry.items.some((item) => reveal.path.has(item.id)) ? [entry.id] : [])
    if (holding.length > 0) setOpen((current) => new Set([...current, ...holding]))
  }, [reveal, placed])
  function toggle(id: string): void {
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }
  return (
    <>
      {placed.flatMap(({ entry, rows: own }) => entry.kind === 'collapsed-work'
        ? [...own.flatMap(before), <WorkDisclosure key={`work:${entry.id}`} work={entry} rows={own} open={open.has(entry.id)} toggle={() => toggle(entry.id)}
          renderRow={renderRow} />]
        : own.flatMap((row) => [...before(row), renderRow(row)]))}
    </>
  )
}
