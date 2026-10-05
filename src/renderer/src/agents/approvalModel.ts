/**
 * What an approval card shows, free of React. The request item carries the vendor's own detail
 * (`input`), whose shape differs per agent: Claude sends the tool input (`command`, `file_path`,
 * `old_string`/`new_string`, `content`, `edits`), Codex sends `command` and `cwd` or a list of
 * `files`, Cursor sends whatever its tool call had. Everything here is read defensively: a field
 * that is missing or is not text is left out, and a request with no detail at all still has its
 * summary. Nothing the agent wrote is treated as markup.
 */
import type { ApprovalRequestItem, ChatItem } from '../../../shared/agents/chat'
import { plural } from '../app/plural'
import type { PillState } from '../components/StatePill'
import type { TranscriptEntry } from './chatViewModel'

type Input = NonNullable<ApprovalRequestItem['input']>
type DecisionItem = Extract<ChatItem, { kind: 'approval_decision' }>

interface DiffLine {
  sign: '-' | '+'
  text: string
}

/** A short account of an edit: one sentence, and the first changed lines. */
export interface DiffPreview {
  text: string
  lines: DiffLine[]
  /** Changed lines left out of `lines`. */
  hidden: number
}

export interface ApprovalDetail {
  /** What the agent wants to do, as a heading. */
  heading: string
  /** The vendor's own one-line description; the fallback when nothing more specific is known. */
  summary: string
  /** The exact command (commands only). */
  command: string | null
  /** Where the command runs: what the vendor named, else the chat's folder (commands only). */
  workingDirectory: string | null
  /** The files an edit touches (edits only). */
  files: string[]
  diff: DiffPreview | null
  /** The reason or description the vendor gave. */
  note: string | null
}

const MAX_PREVIEW_LINES = 12
const MAX_LINE_CHARS = 160
const CWD_KEYS = ['cwd', 'workdir', 'working_directory'] as const
const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function commandOf(input: Input): string | null {
  const { command } = input
  if (Array.isArray(command)) {
    const parts = command.filter((part): part is string => typeof part === 'string' && part !== '')
    return parts.length === 0 ? null : parts.join(' ')
  }
  return text(command)
}

function firstText(input: Input, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = text(input[key])
    if (value !== null) {
      return value
    }
  }
  return null
}

function filesOf(input: Input): string[] {
  const named = PATH_KEYS.flatMap((key) => text(input[key]) ?? [])
  const listed = Array.isArray(input.files) ? input.files.flatMap((file) => text(file) ?? []) : []
  return [...new Set([...named, ...listed])]
}

// ---- Edits ----

interface Change {
  removed: string[]
  added: string[]
}

interface Changes {
  changes: Change[]
  /** The whole file is written, so nothing is replaced. */
  whole: boolean
}

const linesOf = (value: unknown): string[] => (typeof value === 'string' && value !== '' ? value.split('\n') : [])

function changeOf(source: Record<string, unknown>): Change | null {
  if (typeof source.old_string !== 'string' && typeof source.new_string !== 'string') {
    return null
  }
  return { removed: linesOf(source.old_string), added: linesOf(source.new_string) }
}

function changesOf(input: Input): Changes {
  if (Array.isArray(input.edits)) {
    return { changes: input.edits.flatMap((edit) => (isRecord(edit) ? (changeOf(edit) ?? []) : [])), whole: false }
  }
  const single = changeOf(input)
  if (single !== null) {
    return { changes: [single], whole: false }
  }
  const content = input.content ?? input.new_source
  return typeof content === 'string' ? { changes: [{ removed: [], added: linesOf(content) }], whole: true } : { changes: [], whole: false }
}

function diffText(removed: number, added: number, shape: { whole: boolean; edits: number }): string {
  if (shape.whole) {
    return `Writes ${plural(added, 'line')}`
  }
  let base = `Removes ${plural(removed, 'line')}`
  if (added > 0) {
    base = removed > 0 ? `Replaces ${plural(removed, 'line')} with ${plural(added, 'line')}` : `Adds ${plural(added, 'line')}`
  }
  return shape.edits > 1 ? `${base} in ${shape.edits} edits` : base
}

function clipLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line
}

function diffOf(input: Input): DiffPreview | null {
  const { changes, whole } = changesOf(input)
  const lines: DiffLine[] = changes.flatMap((change) => [
    ...change.removed.map((line): DiffLine => ({ sign: '-', text: clipLine(line) })),
    ...change.added.map((line): DiffLine => ({ sign: '+', text: clipLine(line) }))
  ])
  if (lines.length === 0) {
    return null
  }
  const removed = changes.reduce((sum, change) => sum + change.removed.length, 0)
  const summary = diffText(removed, lines.length - removed, { whole, edits: changes.length })
  return { text: summary, lines: lines.slice(0, MAX_PREVIEW_LINES), hidden: Math.max(0, lines.length - MAX_PREVIEW_LINES) }
}

function headingOf(item: ApprovalRequestItem, fileCount: number): string {
  switch (item.category) {
    case 'command':
      return 'Run a command'
    case 'file_edit':
      return fileCount > 1 ? 'Edit files' : 'Edit a file'
    default:
      return `Use ${item.tool}`
  }
}

/** What to show for a request. `folder` is the chat's folder: where a command runs unless the vendor says otherwise. */
export function approvalDetail(item: ApprovalRequestItem, folder: string): ApprovalDetail {
  const input: Input = item.input ?? {}
  const isCommand = item.category === 'command'
  const isEdit = item.category === 'file_edit'
  const files = isEdit ? filesOf(input) : []
  return {
    heading: headingOf(item, files.length),
    summary: item.summary,
    command: isCommand ? commandOf(input) : null,
    workingDirectory: isCommand ? (firstText(input, CWD_KEYS) ?? folder) : null,
    files,
    diff: isEdit ? diffOf(input) : null,
    note: firstText(input, ['reason', 'description'])
  }
}

// ---- Answers ----

interface AnswerView {
  state: PillState
  label: string
  /** A second line for decisions that need one; null otherwise. */
  detail: string | null
}

const ANSWERS: Readonly<Record<DecisionItem['decision'], { state: PillState; label: string }>> = {
  allow_once: { state: 'accepted', label: 'Allowed once' },
  allow_chat: { state: 'accepted', label: 'Allowed for this chat' },
  deny: { state: 'blocked', label: 'Denied' },
  cancelled: { state: 'canceled', label: 'Cancelled' }
}

function answerDetail(item: DecisionItem): string | null {
  if (item.decision === 'cancelled') {
    return 'No answer reached the agent.'
  }
  return item.automatic === true ? 'Answered automatically by an earlier Allow for this chat.' : null
}

/** A stored decision in words, with the state color it shares with the rest of the app. */
export function answerView(item: DecisionItem): AnswerView {
  return { ...ANSWERS[item.decision], detail: answerDetail(item) }
}

// ---- Transcript rows ----

export interface TranscriptRowModel {
  entry: TranscriptEntry
  /** The decision that answers this request; null for anything else and for a request still waiting. */
  answer: DecisionItem | null
}

/**
 * The entries as rows: a request carries its decision, so the card shows the answer where the
 * question was, and the decision's own row is dropped. A decision whose request is not in the
 * transcript keeps its own row.
 */
export function transcriptRows(entries: readonly TranscriptEntry[]): TranscriptRowModel[] {
  const answers = new Map<string, DecisionItem>()
  const asked = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === 'approval_decision') {
      answers.set(entry.requestId, entry)
    } else if (entry.kind === 'approval_request') {
      asked.add(entry.requestId)
    }
  }
  return entries.flatMap((entry): TranscriptRowModel[] => {
    if (entry.kind === 'approval_decision') {
      return asked.has(entry.requestId) ? [] : [{ entry, answer: null }]
    }
    return [{ entry, answer: entry.kind === 'approval_request' ? (answers.get(entry.requestId) ?? null) : null }]
  })
}
