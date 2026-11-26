/**
 * Reads an agent host's own session files into threads of usage samples, activity intervals and session links, for
 * the hosts whose usage Dark Mechanicus can read (`HOST_USAGE_SUPPORT`): OMP (Skitarii) and Claude Code.
 *
 * A thread is the host session's main conversation or one subagent's. Each thread keeps:
 * - its usage samples, one per provider request, normalized by `hostUsage.ts` (Claude Code writes one line per content
 *   block of a message, each repeating the message's usage, so a message counts once, by its id, and a message still
 *   being written, the last one of a thread that has not settled, is left for a later read);
 * - its activity intervals: OMP's request spans (request start to completion) and tool spans (start to result), or
 *   Claude Code's time between consecutive lines of a turn. Waiting tools (`wait`, `ask`) and the time a finished turn
 *   waits for the person are not activity. An interval still running has no end;
 * - its session links, as the chats' activity bindings drew them (`main/agents/activityBindings.ts`): a claim token
 *   the thread was handed in its spawn prompt, or presented in a Dark Mechanicus attempt call the server answered
 *   (heartbeat, submit, fail, record usage), binds the thread to that attempt from then on; a run id named by a
 *   completed `start_run`, `takeover_run` or `claim_ticket` links the session to that run. Only ids are read: the
 *   secret after a claim token's dot is never kept, and a text naming several attempts binds none.
 *
 * The readers are pure: they take the files' names and text, so recorded fixtures replay exactly.
 */
import type { UsageFormat } from '../../shared/domain/hostUsage'
import { breakdownOf, type UsageBreakdown } from './hostUsage'
import { claimedAttemptId as claimedAttempt } from './claimedAttempt'
export { claimedAttemptId } from './claimedAttempt'

/** The hosts whose session files are read. */
type HostKind = 'omp' | 'claude_code'

/** A span of activity in epoch milliseconds; `end` null while it is still running. */
interface HostInterval {
  start: number
  end: number | null
}

interface HostUsageSample {
  /** The host's id for the request (OMP entry id, Claude message id). */
  key: string
  /** When the request completed, in epoch milliseconds. */
  at: number
  breakdown: UsageBreakdown
  model: string | null
}

/** From `at` on, the thread works for this attempt. */
interface HostClaim {
  at: number
  attemptId: string
}

export interface HostThread {
  /** `main`, or the subagent's name in its session. */
  name: string
  /** The thread that started it; null for `main`. */
  parent: string | null
  startedAt: number
  usage: HostUsageSample[]
  activity: HostInterval[]
  claims: HostClaim[]
  /** When each run id was first named by a completed run call (`start_run` result, `takeover_run`, `claim_ticket`). */
  runLinks: { at: number; runId: string }[]
  /** A usage sample the host has not finished writing (Claude Code's last message) was left for a later read. */
  pendingUsage: boolean
}

export interface HostTranscript {
  host: HostKind
  sessionId: string
  threads: HostThread[]
}

export interface TranscriptFile {
  /** The file's name (its last path segment). */
  name: string
  text: string
}

interface TranscriptReadOptions {
  /** The read time, in epoch milliseconds. */
  asOf: number
  /** How long a thread must be quiet before its last, possibly unfinished, message counts. */
  settleMs: number
}

const ID_BODY = '[0-9a-hjkmnp-tv-z]{26}'
const RUN_ID = new RegExp(`(?<![A-Za-z0-9_])(rn_${ID_BODY})(?![A-Za-z0-9_])`, 'g')
/** Dark Mechanicus attempt calls that need a live claim, by MCP tool name or dm CLI command. */
const ATTEMPT_CALL = /(?<![A-Za-z0-9])(?:heartbeat_attempt|submit_attempt|fail_attempt|record_attempt_metrics)(?![A-Za-z0-9])/
const RUN_CALL = /(?<![A-Za-z0-9])(?:start_run|takeover_run|claim_ticket)(?![A-Za-z0-9])/
/** A dm CLI or MCP answer that refused the call. */
const REFUSED = /"ok"\s*:\s*false/
/** Tools that block on someone else (subagents, the person): their time is waiting, not activity. */
const WAITING_TOOLS: Readonly<Record<string, true>> = { wait: true, ask: true, AskUserQuestion: true, Task: true, Agent: true }


interface ToolCall {
  name: string
  text: string
}

interface ToolResult {
  at: number
  failed: boolean
  /** The answer's text, where `start_run` names the run it started. */
  text: string
}

/** Draws a thread's links from one tool call the server answered. */
function linkCall(thread: HostThread, call: ToolCall, result: ToolResult): void {
  if (result.failed) {
    return
  }
  const said = `${call.name} ${call.text}`
  if (ATTEMPT_CALL.test(said)) {
    const attemptId = claimedAttempt(call.text)
    if (attemptId !== null) {
      thread.claims.push({ at: result.at, attemptId })
    }
  }
  if (RUN_CALL.test(said)) {
    // start_run names its run only in its answer, whose run view opens with the run's own id (the tickets it carries can
    // cite any other run, so only that first id links); claim_ticket and takeover_run name theirs in their arguments,
    // and their answers (ticket text, packets) can cite any other run.
    const startRun = /(?<![A-Za-z0-9])start_run(?![A-Za-z0-9])/.test(said)
    const ids = [...(startRun ? result.text : call.text).matchAll(RUN_ID)].map((match) => match[1] ?? '')
    thread.runLinks.push(...(startRun ? ids.slice(0, 1) : ids).map((runId) => ({ at: result.at, runId })))
  }
}

/**
 * A claim token handed to the thread in a message (a retry's claim sent to the worker that did the first attempt):
 * from then on the thread works for that attempt. Only one distinct token in the message binds; several bind none.
 * Tool results never bind this way: a worker reading a fixture or a log can meet any token there.
 */
function bindIncoming(thread: HostThread, incoming: string, at: number): void {
  const attemptId = claimedAttempt(incoming)
  if (attemptId !== null && thread.claims.at(-1)?.attemptId !== attemptId) {
    thread.claims.push({ at, attemptId })
  }
}

function parseLines(text: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) lines.push(value as Record<string, unknown>)
    } catch {
      // A torn last line (the host is still writing it) or a foreign line is skipped, never guessed at.
    }
  }
  return lines
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function msOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isNaN(parsed) ? null : parsed
}

/** The text of a message's content: a string, or its text items joined. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((item) => text(record(item).text) || text(record(item).content)).join('\n') : ''
}

function emptyThread(name: string, parent: string | null, startedAt: number): HostThread {
  return { name, parent, startedAt, usage: [], activity: [], claims: [], runLinks: [], pendingUsage: false }
}

/** A usage sample from a record that holds `usage` and `model` (an OMP message or side request, a Claude message). */
function sample(key: string, at: number, format: UsageFormat, holder: Record<string, unknown>): HostUsageSample {
  return { key, at, breakdown: breakdownOf(format, holder.usage), model: text(holder.model) || null }
}

function finish(thread: HostThread): HostThread {
  thread.usage.sort((a, b) => a.at - b.at)
  thread.activity.sort((a, b) => a.start - b.start)
  thread.claims.sort((a, b) => a.at - b.at)
  thread.runLinks.sort((a, b) => a.at - b.at)
  thread.runLinks = thread.runLinks.filter((link, index, all) => all.findIndex((other) => other.runId === link.runId) === index)
  return thread
}

/** The last segment of a path written with either separator, without `.jsonl`. */
function stem(path: string): string {
  return (path.split(/[\\/]/).at(-1) ?? path).replace(/\.jsonl$/i, '')
}

/** What reading one OMP file keeps between lines: tool calls by id and the start of each tool still running. */
interface OmpReader {
  thread: HostThread
  calls: Map<string, ToolCall>
  toolStarts: Map<string, number>
}

function ompAssistant(reader: OmpReader, line: Record<string, unknown>, at: number): void {
  const message = record(line.message)
  const completed = msOf(message.completedAt) ?? at
  reader.thread.usage.push(sample(text(line.id), completed, 'omp', message))
  const start = msOf(message.timestamp)
  if (start !== null && start <= completed) reader.thread.activity.push({ start, end: completed })
  for (const item of Array.isArray(message.content) ? message.content : []) {
    const call = record(item)
    if (call.type === 'toolCall') reader.calls.set(text(call.id), { name: text(call.name), text: JSON.stringify(call.arguments ?? {}) })
  }
}

function ompToolResult(reader: OmpReader, message: Record<string, unknown>, at: number): void {
  const id = text(message.toolCallId)
  const start = reader.toolStarts.get(id)
  if (start !== undefined) {
    reader.thread.activity.push({ start, end: Math.max(start, at) })
    reader.toolStarts.delete(id)
  }
  const call = reader.calls.get(id)
  const failed = message.isError === true || REFUSED.test(contentText(message.content))
  if (call !== undefined) linkCall(reader.thread, call, { at, failed, text: failed ? '' : contentText(message.content) })
}

type OmpHandler = (reader: OmpReader, line: Record<string, unknown>, at: number) => void

/** What each OMP line kind adds to its thread: a spawn prompt's claim, a request's usage and span, a tool's span and links. */
const OMP_LINES: Readonly<Record<string, OmpHandler>> = {
  session_init: (reader, line) => {
    const attemptId = claimedAttempt(text(line.task))
    if (attemptId !== null) reader.thread.claims.push({ at: reader.thread.startedAt, attemptId })
  },
  model_usage: (reader, line, at) => {
    reader.thread.usage.push(sample(text(line.id), at, 'omp', line))
  },
  'custom:tool_execution_start': (reader, line, at) => {
    const data = record(line.data)
    if (WAITING_TOOLS[text(data.toolName)] !== true) reader.toolStarts.set(text(data.toolCallId), msOf(data.startedAt) ?? at)
  },
  'message:assistant': ompAssistant,
  'message:toolResult': (reader, line, at) => ompToolResult(reader, record(line.message), at),
  'message:user': (reader, line, at) => bindIncoming(reader.thread, contentText(record(line.message).content), at),
  custom_message: (reader, line, at) => bindIncoming(reader.thread, contentText(line.content), at)
}

function ompLine(reader: OmpReader, line: Record<string, unknown>): void {
  const at = msOf(line.timestamp)
  const kind = line.type === 'message' ? `message:${text(record(line.message).role)}` : line.type === 'custom' ? `custom:${text(line.customType)}` : text(line.type)
  const handler = OMP_LINES[kind]
  if (handler !== undefined && at !== null) handler(reader, line, at)
}

/** One OMP session file (main or subagent) into its thread. */
function ompThread(file: TranscriptFile, mainStem: string): { thread: HostThread; sessionId: string } {
  const lines = parseLines(file.text)
  const header = lines.find((line) => line.type === 'session') ?? {}
  const own = stem(file.name)
  const parentStem = stem(text(header.parentSession))
  const isMain = own === mainStem
  const parent = isMain ? null : parentStem === '' || parentStem === mainStem ? 'main' : parentStem
  const reader: OmpReader = { thread: emptyThread(isMain ? 'main' : own, parent, msOf(header.timestamp) ?? 0), calls: new Map(), toolStarts: new Map() }
  for (const line of lines) ompLine(reader, line)
  for (const start of reader.toolStarts.values()) reader.thread.activity.push({ start, end: null })
  return { thread: finish(reader.thread), sessionId: text(header.id) }
}

/**
 * An OMP session: the main file (`<time>_<uuid>.jsonl`) and its subagents' files (`<name>.jsonl` in the folder of the
 * same name), each naming the file of the session that started it (`parentSession`).
 */
export function readOmpTranscript(main: TranscriptFile, subagents: readonly TranscriptFile[]): HostTranscript {
  const mainStem = stem(main.name)
  const root = ompThread(main, mainStem)
  const threads = [root.thread, ...subagents.map((file) => ompThread(file, mainStem).thread)]
  return { host: 'omp', sessionId: root.sessionId, threads }
}

interface ClaudeMessage {
  key: string
  at: number
  /** The message, which holds its `usage` and `model`. */
  holder: Record<string, unknown>
}

/** The thread a Claude Code line belongs to: the main conversation, or the sidechain of one subagent. */
function claudeThreadName(line: Record<string, unknown>): string {
  return line.isSidechain === true ? `agent-${text(line.agentId) || 'sidechain'}` : 'main'
}

/** A user line that is the person's (or the spawn's) prompt, not a tool result. */
function isPrompt(line: Record<string, unknown>): boolean {
  const content = record(line.message).content
  return line.type === 'user' && !(Array.isArray(content) && content.some((item) => record(item).type === 'tool_result'))
}

/** What reading one Claude Code thread keeps between lines. */
interface ClaudeReader {
  thread: HostThread
  messages: Map<string, ClaudeMessage>
  calls: Map<string, ToolCall>
  promptSeen: boolean
  /** Tool calls not answered yet, by id, with the time they were made; a running one keeps its span open. */
  pending: Map<string, number>
}

function messageKey(line: Record<string, unknown>): string {
  return text(record(line.message).id) || text(line.uuid)
}

/** Reads an assistant line; true when it starts a blocking subagent or question. */
function claudeAssistant(reader: ClaudeReader, line: Record<string, unknown>, at: number): boolean {
  const message = record(line.message)
  const key = messageKey(line)
  // Every content block of one message repeats its usage; the latest line holds the final counts.
  reader.messages.set(key, { key, at, holder: message })
  let waits = false
  for (const item of Array.isArray(message.content) ? message.content : []) {
    const call = record(item)
    if (call.type !== 'tool_use') continue
    reader.calls.set(text(call.id), { name: text(call.name), text: JSON.stringify(call.input ?? {}) })
    const waiting = WAITING_TOOLS[text(call.name)] === true
    if (!waiting) reader.pending.set(text(call.id), at)
    waits ||= waiting
  }
  return waits
}

/** The claim a subagent was spawned with: the attempt of the one claim token in its first prompt. */
function claudeSpawnClaim(reader: ClaudeReader, line: Record<string, unknown>): void {
  const prompt = isPrompt(line)
  if (prompt && !reader.promptSeen && reader.thread.name !== 'main') {
    const attemptId = claimedAttempt(contentText(record(line.message).content))
    if (attemptId !== null) reader.thread.claims.push({ at: reader.thread.startedAt, attemptId })
  }
  reader.promptSeen ||= prompt
}

/** Reads a user line: a subagent's first prompt (its claim), claim tokens handed over later, and tool results (links). */
function claudeUser(reader: ClaudeReader, line: Record<string, unknown>, at: number): void {
  claudeSpawnClaim(reader, line)
  const content = record(line.message).content
  if (isPrompt(line) && reader.thread.name !== 'main') bindIncoming(reader.thread, contentText(content), at)
  for (const item of Array.isArray(content) ? content : []) {
    const result = record(item)
    reader.pending.delete(text(result.tool_use_id))
    const call = reader.calls.get(text(result.tool_use_id))
    if (result.type !== 'tool_result' || call === undefined) continue
    const failed = result.is_error === true || REFUSED.test(contentText(result.content))
    linkCall(reader.thread, call, { at, failed, text: failed ? '' : contentText(result.content) })
  }
}

/**
 * Whether the time from `line` to the next line is activity: not when the turn ended and the next line is the
 * person's new prompt, nor when the line started a blocking subagent or question (that time is the subagent's, or
 * waiting).
 */
function activeGap(line: Record<string, unknown>, next: Record<string, unknown>, waits: boolean): boolean {
  const turnOver = line.type === 'assistant' && ['end_turn', 'stop_sequence'].includes(text(record(line.message).stop_reason))
  return !turnOver && !waits && !isPrompt(next)
}

/** The thread's messages as usage samples; the last one, still streaming while the thread has not settled, waits. */
function claudeUsage(reader: ClaudeReader, last: { line: Record<string, unknown>; at: number } | undefined, options: TranscriptReadOptions): void {
  const settled = options.asOf - (last?.at ?? 0) >= options.settleMs
  const unfinished = last?.line.type === 'assistant' && !settled ? messageKey(last.line) : null
  for (const message of reader.messages.values()) {
    if (message.key === unfinished) reader.thread.pendingUsage = true
    else reader.thread.usage.push(sample(message.key, message.at, 'anthropic_messages', message.holder))
  }
}

/** One Claude Code thread's lines, in file order, into its thread. */
function claudeThread(name: string, lines: readonly Record<string, unknown>[], options: TranscriptReadOptions): HostThread {
  const timed = lines.flatMap((line) => {
    const at = msOf(line.timestamp)
    return at === null ? [] : [{ line, at }]
  })
  const reader: ClaudeReader = { thread: emptyThread(name, name === 'main' ? null : 'main', timed[0]?.at ?? 0), messages: new Map(), calls: new Map(), promptSeen: false, pending: new Map() }
  timed.forEach(({ line, at }, index) => {
    let waits = false
    if (line.type === 'assistant') waits = claudeAssistant(reader, line, at)
    else claudeUser(reader, line, at)
    const next = timed[index + 1]
    if (next !== undefined && activeGap(line, next.line, waits)) reader.thread.activity.push({ start: at, end: Math.max(at, next.at) })
  })
  // A tool still running (or waiting for the person's permission) keeps the thread's last span open: it may still grow.
  for (const start of reader.pending.values()) reader.thread.activity.push({ start, end: null })
  claudeUsage(reader, timed.at(-1), options)
  return finish(reader.thread)
}

/**
 * A Claude Code session: the main file (`<session id>.jsonl`) and its subagents' files (`subagents/agent-<id>.jsonl`).
 * Older versions wrote subagent (sidechain) lines into the main file; both layouts read the same.
 */
export function readClaudeTranscript(main: TranscriptFile, subagents: readonly TranscriptFile[], options: TranscriptReadOptions): HostTranscript {
  const grouped = new Map<string, Record<string, unknown>[]>()
  let sessionId = stem(main.name)
  for (const file of [main, ...subagents]) {
    for (const line of parseLines(file.text)) {
      if (line.type !== 'user' && line.type !== 'assistant') continue
      sessionId = text(line.sessionId) || sessionId
      const name = claudeThreadName(line)
      const held = grouped.get(name)
      if (held === undefined) grouped.set(name, [line])
      else held.push(line)
    }
  }
  const threads = [...grouped.entries()].map(([name, lines]) => claudeThread(name, lines, options))
  return { host: 'claude_code', sessionId, threads }
}

/**
 * A Codex CLI rollout's running token totals (`token_count` events' `total_token_usage`), in order; events without
 * usage (rate-limit updates) are skipped. Turn them into per-update deltas with `cumulativeDeltas` before adding them
 * up, so a repeated event counts nothing.
 */
export function readCodexTotals(textOfFile: string): { at: number; breakdown: UsageBreakdown }[] {
  return parseLines(textOfFile).flatMap((line) => {
    const payload = record(line.payload)
    const info = record(payload.info)
    const at = msOf(line.timestamp)
    return payload.type === 'token_count' && info.total_token_usage !== undefined && at !== null ? [{ at, breakdown: breakdownOf('codex', info.total_token_usage) }] : []
  })
}

/** Which host wrote a session file, from its lines: OMP opens with a versioned `session` header, Claude Code lines carry a uuid and session id. */
export function detectHost(textOfFile: string): HostKind | null {
  for (const line of parseLines(textOfFile).slice(0, 20)) {
    if (line.type === 'session' && typeof line.version === 'number') return 'omp'
    if (typeof line.uuid === 'string' && typeof line.sessionId === 'string') return 'claude_code'
  }
  return null
}
