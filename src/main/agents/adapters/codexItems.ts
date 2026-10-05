/**
 * Turns what `codex app-server` reports about a thread item (`item/started`, `item/completed`)
 * into transcript items. Pure: no I/O, and tolerant of fields it does not know, since the protocol
 * grows (https://github.com/openai/codex, `codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts`).
 *
 * Item ids are namespaced by the turn (`<turnId>:<itemId>`), so two turns can never overwrite each
 * other's lines in the stored transcript. The same id is used for the streamed text deltas.
 */
import type { ChatItem } from '../../../shared/agents/chat'
import { RpcError } from './codexRpc'

type ToolCall = Extract<ChatItem, { kind: 'tool_call' }>
type ToolInput = ToolCall['input']
type ToolStatus = ToolCall['status']

export type Phase = 'started' | 'completed'

type Fields = Record<string, unknown>

/** The longest a command, an output or an argument is kept in the transcript. */
const CLIP = 300
/** The most files listed for one change. */
const MAX_FILES = 20

export function asRecord(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null
}

export function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

export function clip(text: string, limit = CLIP): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/** The id a Codex item has in the transcript. */
export function scopedId(turnId: string, itemId: string): string {
  return `${turnId}:${itemId}`
}

export type ChangedFile = { path: string; kind: string }

/** The files a `fileChange` item touches, with how. */
function changedFiles(item: Fields): ChangedFile[] {
  const changes = Array.isArray(item.changes) ? item.changes : []
  return changes.flatMap((change: unknown) => {
    const fields = asRecord(change)
    const path = asText(fields?.path)
    return path === null ? [] : [{ path, kind: asText(asRecord(fields?.kind)?.type) ?? 'update' }]
  })
}

const STATUSES: Record<string, ToolStatus> = {
  inProgress: 'running',
  completed: 'completed',
  failed: 'failed',
  interrupted: 'failed',
  declined: 'denied'
}

function statusOf(item: Fields, phase: Phase): ToolStatus {
  return STATUSES[asText(item.status) ?? ''] ?? (phase === 'started' ? 'running' : 'completed')
}

interface Mapped {
  name: string
  input: ToolInput
  /** Given the status, what to tell about the result; null while it still runs. */
  summary: (status: ToolStatus) => string | null
}

/** What a finished call says: nothing while it runs, "Declined" when refused, else the note for its outcome. */
function endNote(status: ToolStatus, ok: () => string, failed: () => string = () => 'Failed'): string | null {
  switch (status) {
    case 'running':
      return null
    case 'denied':
      return 'Declined'
    case 'failed':
      return failed()
    default:
      return ok()
  }
}

function commandCall(item: Fields): Mapped {
  const output = asText(item.aggregatedOutput)
  const code = typeof item.exitCode === 'number' ? item.exitCode : null
  const outcome = (fallback: string) => (): string => {
    const head = code === null ? fallback : `Exit code ${code}`
    return output === null ? head : `${head}\n${clip(output)}`
  }
  return {
    name: 'command',
    input: { command: clip(asText(item.command) ?? ''), ...(asText(item.cwd) === null ? {} : { cwd: asText(item.cwd) }) },
    summary: (status) => endNote(status, outcome('Finished'), outcome('Failed'))
  }
}

function fileChangeCall(item: Fields): Mapped {
  const files = changedFiles(item)
  return {
    name: 'file_change',
    input: { files: files.slice(0, MAX_FILES) },
    summary: (status) => endNote(status, () => `${files.length} ${files.length === 1 ? 'file' : 'files'} changed`)
  }
}

/** Arguments for the transcript: an object as it is (long values clipped), anything else under `value`. */
function summarizeArguments(args: unknown): ToolInput {
  const fields = asRecord(args)
  if (fields === null) {
    return args === null || args === undefined ? {} : { value: clip(typeof args === 'string' ? args : JSON.stringify(args)) }
  }
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      const json = JSON.stringify(value)
      return [key, json !== undefined && json.length > CLIP ? clip(json) : value]
    })
  ) as ToolInput
}

function resultText(result: unknown): string | null {
  const content = asRecord(result)?.content
  const texts = Array.isArray(content)
    ? content.flatMap((part: unknown) => {
        const text = asText(asRecord(part)?.text)
        return text === null ? [] : [text]
      })
    : []
  return texts.length === 0 ? null : clip(texts.join('\n'))
}

function mcpCall(item: Fields): Mapped {
  const server = asText(item.server) ?? 'mcp'
  return {
    name: `${server}.${asText(item.tool) ?? 'tool'}`,
    input: summarizeArguments(item.arguments),
    summary: (status) =>
      endNote(
        status,
        () => resultText(item.result) ?? 'Completed',
        () => asText(asRecord(item.error)?.message) ?? 'Failed'
      )
  }
}

function dynamicCall(item: Fields): Mapped {
  return {
    name: asText(item.tool) ?? 'tool',
    input: summarizeArguments(item.arguments),
    summary: (status) => endNote(status, () => 'Completed')
  }
}

function searchCall(item: Fields): Mapped {
  return { name: 'web_search', input: asText(item.query) === null ? {} : { query: asText(item.query) }, summary: () => null }
}

/** What the subagents a collab call is about said, one line each, or null when none said anything. */
function collabResult(item: Fields): string | null {
  const states = asRecord(item.agentsStates) ?? {}
  const lines = Object.values(states).flatMap((state) => asText(asRecord(state)?.message) ?? [])
  return lines.length === 0 ? null : clip(lines.join('\n'))
}

/**
 * A tool an agent uses to work with its subagents (`spawnAgent`, `wait`, `closeAgent`, ...), named in
 * snake case like the tool the model calls. The threads themselves are `codexThreads.ts`'s business.
 */
function collabCall(item: Fields): Mapped {
  const prompt = asText(item.prompt)
  const model = asText(item.model)
  return {
    name: (asText(item.tool) ?? 'collabAgent').replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
    input: { ...(prompt === null ? {} : { prompt: clip(prompt) }), ...(model === null ? {} : { model }) },
    summary: (status) =>
      endNote(
        status,
        () => collabResult(item) ?? 'Completed',
        () => collabResult(item) ?? 'Failed'
      )
  }
}

const CALLS: Record<string, (item: Fields) => Mapped> = {
  commandExecution: commandCall,
  fileChange: fileChangeCall,
  mcpToolCall: mcpCall,
  dynamicToolCall: dynamicCall,
  webSearch: searchCall,
  collabAgentToolCall: collabCall
}

/** Where in a turn an item is, and the id and time its transcript item gets. */
interface Stamp {
  phase: Phase
  id: string
  at: string
}

function messageItem(item: Fields, { phase, id, at }: Stamp): ChatItem | null {
  const text = asText(item.text)
  return phase === 'completed' && text !== null ? { id, at, kind: 'assistant_text', text } : null
}

function compactionItem(_item: Fields, { phase, id, at }: Stamp): ChatItem | null {
  return phase === 'completed' ? { id, at, kind: 'context_reset', reason: 'compact' } : null
}

/**
 * A v2 subagent has no collab call: its start is a `subAgentActivity` of kind `started`, which stands in
 * for the `spawn_agent` call that thread hangs from. The other kinds only change the thread's state.
 */
function activityItem(item: Fields, { phase, id, at }: Stamp): ChatItem | null {
  if (phase !== 'completed' || item.kind !== 'started') {
    return null
  }
  const agent = asText(item.agentPath)
  return { id, at, kind: 'tool_call', name: 'spawn_agent', input: agent === null ? {} : { agent }, status: 'completed', resultSummary: null }
}

function toolItem(type: string, item: Fields, { phase, id, at }: Stamp): ChatItem | null {
  const call = CALLS[type]?.(item)
  if (call === undefined) {
    return null
  }
  const status = statusOf(item, phase)
  return { id, at, kind: 'tool_call', name: call.name, input: call.input, status, resultSummary: call.summary(status) }
}

const OTHER_ITEMS: Record<string, (item: Fields, stamp: Stamp) => ChatItem | null> = {
  agentMessage: messageItem,
  contextCompaction: compactionItem,
  subAgentActivity: activityItem
}

/**
 * The transcript item for a thread item at the start or end of its life, or null when it has no
 * place in the transcript (the user's own message, reasoning, plans, items this version does not know).
 */
export function itemFor(raw: unknown, phase: Phase, turnId: string, at: string): ChatItem | null {
  const item = asRecord(raw)
  const type = asText(item?.type)
  const itemId = asText(item?.id)
  if (item === null || type === null || itemId === null) {
    return null
  }
  const stamp: Stamp = { phase, id: scopedId(turnId, itemId), at }
  return OTHER_ITEMS[type]?.(item, stamp) ?? toolItem(type, item, stamp)
}

/** The id and files of a file-change item (what its approval request will want to name), or null for any other item. */
export function fileChangeOf(raw: unknown): { id: string; files: ChangedFile[] } | null {
  const item = asRecord(raw)
  const id = asText(item?.id)
  return item === null || id === null || item.type !== 'fileChange' ? null : { id, files: changedFiles(item) }
}

/** The `codexErrorInfo` variants that carry the HTTP status of the request that failed. */
const HTTP_FAILURES = ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']

/**
 * True when Codex classified a failure as a rejected sign-in: its `unauthorized` code (the access
 * token could not be refreshed), or an HTTP failure whose status was 401 (a request sent with no login).
 */
function rejectsSignIn(codexErrorInfo: unknown): boolean {
  if (codexErrorInfo === 'unauthorized') {
    return true
  }
  const info = asRecord(codexErrorInfo)
  return info !== null && HTTP_FAILURES.some((kind) => asRecord(info[kind])?.httpStatusCode === 401)
}

/** How a turn ended, as far as the adapter needs to tell: the failure's words, and whether the sign-in was what failed. */
interface TurnEndKind {
  failure: string | null
  signedOut: boolean
}

/**
 * What the end of a turn means for the turn being waited on: null when it is another turn's end
 * (or not a turn at all), else the failure message, or null in `failure` when it ended without failing.
 */
export function turnEnd(completed: unknown, waitingFor: string | null): TurnEndKind | null {
  const turn = asRecord(completed)
  const id = asText(turn?.id)
  if (turn === null || (waitingFor !== null && id !== null && id !== waitingFor)) {
    return null
  }
  if (turn.status !== 'failed') {
    return { failure: null, signedOut: false }
  }
  const error = asRecord(turn.error)
  return { failure: asText(error?.message) ?? 'The Codex turn failed.', signedOut: rejectsSignIn(error?.codexErrorInfo) }
}

/**
 * The words to show when the app-server refused a request because the login cannot be refreshed, or
 * null for any other error. It marks such a refusal with `data.action: "relogin"` and puts the login's
 * own words in `data.detail` (`codex-rs/app-server/src/request_processors/config_errors.rs`).
 */
export function reloginMessage(error: unknown): string | null {
  if (!(error instanceof RpcError)) {
    return null
  }
  const data = asRecord(error.data)
  return data?.action === 'relogin' ? (asText(data.detail) ?? error.message) : null
}
