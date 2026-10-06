import { useState } from 'react'
import type { DiffHunk, DiffLine, FileDiff } from '../../../shared/git/diff'
import './source.css'

/** Lines rendered before the "Show more" button; keeps a huge diff from freezing the renderer. */
const DIFF_LINE_LIMIT = 2000

interface DiffViewProps {
  diff: FileDiff | null
  loading: boolean
  error: string | null
  onShowLarge?(): void
}

const MARKERS: Record<DiffLine['kind'], string> = { context: ' ', add: '+', delete: '-' }

function srText(line: DiffLine): string | null {
  if (line.kind === 'add') return `added line ${line.newNumber ?? ''}`.trim()
  if (line.kind === 'delete') return `removed line ${line.oldNumber ?? ''}`.trim()
  return null
}

/** The line-number columns and the +/- marker of one row. Its own component so line checkboxes can join it later. */
function DiffGutter({ line }: { line: DiffLine }): React.JSX.Element {
  const sr = srText(line)
  return (
    <>
      <td className="diff-num">{line.oldNumber ?? ''}</td>
      <td className="diff-num">{line.newNumber ?? ''}</td>
      <td className="diff-marker">
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

function HunkRows({ hunk, h }: { hunk: DiffHunk; h: number }): React.JSX.Element {
  return (
    <>
      <tr className="diff-hunk">
        <td colSpan={4}>{hunk.header}</td>
      </tr>
      {hunk.lines.map((line, i) => (
        <LineRows key={`${h}:${i}`} line={line} />
      ))}
    </>
  )
}

/** A line's text without the carriage return git keeps from CRLF files. */
function trimCr(text: string): string {
  return text.charCodeAt(text.length - 1) === 13 ? text.slice(0, -1) : text
}

function LineRows({ line }: { line: DiffLine }): React.JSX.Element {
  return (
    <>
      <tr className={`diff-line diff-${line.kind}`}>
        <DiffGutter line={line} />
        <td className="diff-text">{trimCr(line.text)}</td>
      </tr>
      {line.noNewlineAtEnd && (
        <tr className="diff-eof">
          <td colSpan={4}>No newline at end of file</td>
        </tr>
      )}
    </>
  )
}
function TextDiff({ diff }: { diff: Extract<FileDiff, { kind: 'text' }> }): React.JSX.Element {
  const [expandedHash, setExpandedHash] = useState<string | null>(null)
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
              <HunkRows key={h} hunk={hunk} h={h} />
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

export function DiffView({ diff, loading, error, onShowLarge }: DiffViewProps): React.JSX.Element {
  if (loading) return <Message role="status">Loading diff…</Message>
  if (error !== null) return <Message role="alert">{error}</Message>
  if (diff === null) return <Message>Select a file to see its changes</Message>
  if (diff.kind === 'text') return <TextDiff diff={diff} />
  return <NonTextDiff diff={diff} onShowLarge={onShowLarge} />
}
