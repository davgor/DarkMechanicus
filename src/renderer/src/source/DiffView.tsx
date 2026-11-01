import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { changedLineIndices } from '../../../shared/git/diff'
import type { DiffHunk, DiffLine, FileDiff } from '../../../shared/git/diff'
import './source.css'

/** Lines rendered before the "Show more" button; keeps a huge diff from freezing the renderer. */
const DIFF_LINE_LIMIT = 2000

/** Which changed lines (`changedLineIndices` numbering) a commit takes, and how to change that. */
export interface LineSelection {
  selected: ReadonlySet<number>
  onToggle(indices: number[], include: boolean): void
}

interface DiffViewProps {
  diff: FileDiff | null
  loading: boolean
  error: string | null
  onShowLarge?(): void
  /** Makes changed lines choosable from the gutter; without it the diff is read-only (History). */
  selection?: LineSelection
}

/** Clicks, drags and keys on the gutter, turned into toggles of a `LineSelection`. */
interface Picker {
  selected: ReadonlySet<number>
  /** A left button press on a line's gutter: toggles it and starts a drag from it. */
  press(index: number): void
  /**
   * The pointer entering a line's gutter: during a drag, sets the range from its first line to this one. A button
   * released outside the window sends no mouseup, so entering with no button pressed ends the drag instead.
   */
  enter(index: number, pressed: boolean): void
  toggle(indices: number[], include: boolean): void
}

/** Where one row stands in a selectable diff: its changed-line index (null for context) and the picker. */
interface Pick {
  index: number | null
  picker: Picker
}

const COLUMNS = 4

const MARKERS: Record<DiffLine['kind'], string> = { context: ' ', add: '+', delete: '-' }

function srText(line: DiffLine): string | null {
  if (line.kind === 'add') return `added line ${line.newNumber ?? ''}`.trim()
  if (line.kind === 'delete') return `removed line ${line.oldNumber ?? ''}`.trim()
  return null
}

function rangeOf(from: number, to: number): number[] {
  const low = Math.min(from, to)
  return Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => low + i)
}

function usePicker(selection: LineSelection | undefined): Picker | null {
  const drag = useRef<{ anchor: number; last: number; include: boolean } | null>(null)
  useEffect(() => {
    const end = (): void => {
      drag.current = null
    }
    window.addEventListener('mouseup', end)
    return () => window.removeEventListener('mouseup', end)
  }, [])
  return useMemo(() => {
    if (selection === undefined) return null
    return {
      selected: selection.selected,
      toggle: (indices, include) => selection.onToggle(indices, include),
      press: (index) => {
        const include = !selection.selected.has(index)
        drag.current = { anchor: index, last: index, include }
        selection.onToggle([index], include)
      },
      enter: (index, pressed) => {
        const current = drag.current
        if (!pressed) drag.current = null
        if (current === null || !pressed || current.last === index) return
        current.last = index
        selection.onToggle(rangeOf(current.anchor, index), current.include)
      }
    }
  }, [selection])
}

/** Mouse handlers for every gutter cell of a changed line. */
function gutterHandlers(pick: Pick | null): React.HTMLAttributes<HTMLTableCellElement> {
  if (pick === null || pick.index === null) return {}
  const { index, picker } = pick
  return {
    onMouseDown: (event: MouseEvent) => {
      if (event.button !== 0) return
      event.preventDefault()
      picker.press(index)
    },
    onMouseEnter: (event: MouseEvent) => picker.enter(index, (event.buttons & 1) === 1)
  }
}

interface CheckProps {
  label: string
  checked: boolean | 'mixed'
  onSpace(): void
}

/** A gutter checkbox: focusable, and Space toggles it. Pointer input is handled by its cell. */
function Check({ label, checked, onSpace }: CheckProps): React.JSX.Element {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== ' ') return
    event.preventDefault()
    onSpace()
  }
  return <span role="checkbox" className="diff-box" aria-checked={checked} aria-label={label} tabIndex={0} onKeyDown={onKeyDown} />
}

function LineCheck({ line, pick }: { line: DiffLine; pick: Pick }): React.JSX.Element {
  const { index, picker } = pick
  if (index === null) return <td className="diff-check" />
  const included = picker.selected.has(index)
  return (
    <td className="diff-check" {...gutterHandlers(pick)}>
      <Check label={`Include ${srText(line) ?? ''}`} checked={included} onSpace={() => picker.toggle([index], !included)} />
    </td>
  )
}

/** The line-number columns and the +/- marker of one row, after its checkbox when lines can be chosen. */
function DiffGutter({ line, pick }: { line: DiffLine; pick: Pick | null }): React.JSX.Element {
  const sr = srText(line)
  const handlers = gutterHandlers(pick)
  return (
    <>
      {pick === null ? null : <LineCheck line={line} pick={pick} />}
      <td className="diff-num" {...handlers}>
        {line.oldNumber ?? ''}
      </td>
      <td className="diff-num" {...handlers}>
        {line.newNumber ?? ''}
      </td>
      <td className="diff-marker" {...handlers}>
        <span aria-hidden="true">{MARKERS[line.kind]}</span>
        {sr && <span className="diff-sr">{sr}</span>}
      </td>
    </>
  )
}

function megabytes(bytes: number): string {
  return String(Number((bytes / (1024 * 1024)).toFixed(1)))
}

/** The hunks cut to at most `budget` lines in total. */
function takeLines(hunks: DiffHunk[], budget: number): DiffHunk[] {
  const out: DiffHunk[] = []
  let left = budget
  for (const hunk of hunks) {
    if (left <= 0) break
    out.push(hunk.lines.length <= left ? hunk : { ...hunk, lines: hunk.lines.slice(0, left) })
    left -= hunk.lines.length
  }
  return out
}

function Message({ children, role }: { children: React.ReactNode; role?: 'alert' | 'status' }): React.JSX.Element {
  return (
    <div className="diff-message" role={role}>
      {children}
    </div>
  )
}

function NonTextDiff({ diff, onShowLarge }: { diff: Exclude<FileDiff, { kind: 'text' }>; onShowLarge?(): void }): React.JSX.Element {
  if (diff.kind === 'binary') return <Message>Binary file changed</Message>
  if (diff.kind === 'empty') return <Message>No content changes: the file mode or name changed</Message>
  return (
    <Message>
      <p>This diff is large ({megabytes(diff.bytes)} MB)</p>
      {onShowLarge && (
        <button type="button" className="btn" onClick={onShowLarge}>
          Show anyway
        </button>
      )}
    </Message>
  )
}

function HunkCheck({ header, indices, picker }: { header: string; indices: number[]; picker: Picker }): React.JSX.Element {
  const count = indices.filter((index) => picker.selected.has(index)).length
  const all = count === indices.length
  const toggle = (): void => picker.toggle(indices, !all)
  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    toggle()
  }
  return (
    <td className="diff-check" onMouseDown={onMouseDown}>
      <Check label={`Include hunk ${header}`} checked={all ? true : count === 0 ? false : 'mixed'} onSpace={toggle} />
    </td>
  )
}

interface HunkRowsProps {
  hunk: DiffHunk
  h: number
  /** The changed-line index of each of the hunk's lines (all of them, even when the hunk is cut short). */
  indices: Array<number | null>
  picker: Picker | null
}

function HunkRows({ hunk, h, indices, picker }: HunkRowsProps): React.JSX.Element {
  const changed = indices.filter((index) => index !== null)
  return (
    <>
      <tr className="diff-hunk">
        {picker === null ? null : <HunkCheck header={hunk.header} indices={changed} picker={picker} />}
        <td colSpan={COLUMNS}>{hunk.header}</td>
      </tr>
      {hunk.lines.map((line, i) => (
        <LineRows key={`${h}:${i}`} line={line} pick={picker === null ? null : { index: indices[i] ?? null, picker }} />
      ))}
    </>
  )
}

/** A line's text without the carriage return git keeps from CRLF files. */
function trimCr(text: string): string {
  return text.charCodeAt(text.length - 1) === 13 ? text.slice(0, -1) : text
}

function LineRows({ line, pick }: { line: DiffLine; pick: Pick | null }): React.JSX.Element {
  const excluded = pick !== null && pick.index !== null && !pick.picker.selected.has(pick.index)
  return (
    <>
      <tr className={`diff-line diff-${line.kind}${excluded ? ' diff-excluded' : ''}`}>
        <DiffGutter line={line} pick={pick} />
        <td className="diff-text">{trimCr(line.text)}</td>
      </tr>
      {line.noNewlineAtEnd && (
        <tr className="diff-eof">
          <td colSpan={pick === null ? COLUMNS : COLUMNS + 1}>No newline at end of file</td>
        </tr>
      )}
    </>
  )
}

function TextDiff({ diff, selection }: { diff: Extract<FileDiff, { kind: 'text' }>; selection?: LineSelection }): React.JSX.Element {
  const [expandedHash, setExpandedHash] = useState<string | null>(null)
  const picker = usePicker(selection)
  const indices = useMemo(() => changedLineIndices(diff), [diff])
  const total = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  const expanded = expandedHash === diff.hash
  const hunks = expanded ? diff.hunks : takeLines(diff.hunks, DIFF_LINE_LIMIT)
  const hidden = expanded ? 0 : Math.max(0, total - DIFF_LINE_LIMIT)
  return (
    <div className="diff-view">
      <div className="diff-scroll">
        <table className="diff-table" aria-label={`Diff of ${diff.path}`}>
          <tbody>
            {hunks.map((hunk, h) => (
              <HunkRows key={h} hunk={hunk} h={h} indices={indices[h] ?? []} picker={picker} />
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <button type="button" className="btn diff-more" onClick={() => setExpandedHash(diff.hash)}>
          Show {hidden} more lines
        </button>
      )}
    </div>
  )
}

export function DiffView({ diff, loading, error, onShowLarge, selection }: DiffViewProps): React.JSX.Element {
  if (loading) return <Message role="status">Loading diff…</Message>
  if (error !== null) return <Message role="alert">{error}</Message>
  if (diff === null) return <Message>Select a file to see its changes</Message>
  if (diff.kind === 'text') return <TextDiff diff={diff} selection={selection} />
  return <NonTextDiff diff={diff} onShowLarge={onShowLarge} />
}
