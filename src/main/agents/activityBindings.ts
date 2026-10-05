/**
 * Links chat threads to the Dark Mechanicus runs and attempts they act on, app-wide, so main-process
 * code can find the chat and thread behind a run (`byRun`) or an attempt (`byAttempt`).
 *
 * A binding names a chat, a thread in it (a `thread` item's id, or null for the chat's main thread),
 * the chat's folder, a run or an attempt, and what the thread is to it: its `orchestrator` or a
 * `worker`. What binds:
 *
 * - A chat Start run launched (it records `runId`): its main thread, to that run, as orchestrator.
 * - `start_run` (by the one run id its result names), `takeover_run` and `claim_ticket` (by the `runId`
 *   of their input), called by the main thread: the main thread, to the run, as orchestrator. A
 *   `claim_ticket` also binds it to the attempt its result names, as orchestrator.
 * - `heartbeat_attempt`, `submit_attempt` and `fail_attempt` with an `attemptId`: the thread that called
 *   them, to that attempt; as orchestrator when it is the main thread of an orchestrating chat, else as worker.
 * - An `Agent` (or `Task`) call by the main thread of an orchestrating chat whose prompt carries an
 *   attempt id (the execution packet): the thread it spawned (whose `parentItemId` is the call), to that
 *   attempt, as worker. Subagents that subagents start are not bound this way.
 *
 * A Dark Mechanicus call binds only once the server answered it (`completed`): a call that is still
 * running, failed (refused, stale, unauthorized) or was denied binds nothing. The calls are known by the
 * names the adapters give them: `mcp__darkmechanicus__<tool>` (Claude) and `darkmechanicus.<tool>`
 * (Codex). A chat orchestrates when its role is orchestrator or Start run launched it; only that role
 * may call the run tools at all.
 *
 * Ids, never tokens. A claim token is `<attempt id>.<secret>`. Ids are taken only whole (`at_` or
 * `rn_` and 26 Crockford base32 characters, not part of a longer word), so the secret after a token's
 * dot is never read, and an input field must be exactly an id. A wrong binding is worse than none, so a
 * text (a prompt, a result) yields an attempt id only when it is unambiguous: the one id labelled as the
 * attempt id (`attemptId`, `attempt_id` or `attempt id`, then `:` or `=`), else the one distinct id it
 * carries. Several different labelled ids, or several different ids and no label, bind nothing.
 *
 * `byChat` serves the renderer's view of one chat (`chats:threadBindings`).
 *
 * Storage. One JSON line per binding in `file` (`userData/agents/activity-bindings.jsonl`, next to the
 * chat store), appended once per chat, thread and run or attempt: replaying the same items adds nothing,
 * and the role first bound stays. A binding is masked for claim tokens and validated before it is
 * written, and lines that are not valid bindings, or that carry a token, are skipped when read.
 * Forgetting a deleted chat rewrites the file without its lines. Which spawn call carried which attempt
 * id is kept in memory only, per chat.
 */
import { dirname } from 'node:path'
import { z } from 'zod'
import { chatIdSchema, type ChatItem, type ChatRecord } from '../../shared/agents/chat'
import { nodeChatStoreFs, type ChatRef, type ChatStoreFs } from './chatStore'
import { maskClaimTokens, maskClaimTokensDeep } from './claimTokenMask'

const ID_BODY = '[0-9a-hjkmnp-tv-z]{26}'
/** Not part of a longer word on either side; a claim token's dot and secret may follow, and are never read. */
const BEFORE = '(?<![A-Za-z0-9_])'
const AFTER = '(?![A-Za-z0-9_])'

const ATTEMPT_ID = new RegExp(`^at_${ID_BODY}$`)
const RUN_ID = new RegExp(`^rn_${ID_BODY}$`)
const ATTEMPT_IDS = new RegExp(`${BEFORE}at_${ID_BODY}${AFTER}`, 'g')
const RUN_IDS = new RegExp(`${BEFORE}rn_${ID_BODY}${AFTER}`, 'g')
const LABELLED_ATTEMPT_IDS = new RegExp(`${BEFORE}[Aa]ttempt[ _]?[Ii][Dd]["'\`]?\\s*[:=]\\s*["'\`]?(at_${ID_BODY})${AFTER}`, 'g')

/** A Dark Mechanicus tool call, as Claude (`mcp__darkmechanicus__<tool>`) or Codex (`darkmechanicus.<tool>`) names it. */
const DARK_MECHANICUS_TOOL = /^(?:mcp__darkmechanicus__|darkmechanicus\.)([a-z_]+)$/
const SPAWN_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])
const ATTEMPT_TOOLS: ReadonlySet<string> = new Set(['heartbeat_attempt', 'submit_attempt', 'fail_attempt'])

const bindingBase = {
  chatId: chatIdSchema,
  /** A `thread` item's id; null for the chat's main thread. */
  threadId: z.string().min(1).nullable(),
  /** The chat's canonical folder. */
  folder: z.string().min(1),
  /** What the thread is to the run or attempt. */
  role: z.enum(['orchestrator', 'worker'])
}

const bindingSchema = z.discriminatedUnion('kind', [
  z.object({ ...bindingBase, kind: z.literal('run'), runId: z.string().regex(RUN_ID) }),
  z.object({ ...bindingBase, kind: z.literal('attempt'), attemptId: z.string().regex(ATTEMPT_ID) })
])

export type ActivityBinding = z.infer<typeof bindingSchema>

type Role = ActivityBinding['role']
type Target = { kind: 'run'; runId: string } | { kind: 'attempt'; attemptId: string }
type ToolCall = Extract<ChatItem, { kind: 'tool_call' }>
type ThreadItem = Extract<ChatItem, { kind: 'thread' }>

/** A binding before it is tied to its chat. */
interface Found {
  threadId: string | null
  role: Role
  target: Target
}

export interface ActivityBindings {
  /** Binds what one item shows its thread acting on; returns the bindings it added (none when they were known). */
  observe(chat: ChatRecord, item: ChatItem): ActivityBinding[]
  /** Binds the chat's own run (Start run's), then what each item shows, in order; replaying adds nothing new. */
  observeChat(chat: ChatRecord, items: readonly ChatItem[]): ActivityBinding[]
  /** Every thread bound to the attempt, in the order bound. */
  byAttempt(attemptId: string): ActivityBinding[]
  /** Every thread bound to the run, in the order bound. */
  byRun(runId: string): ActivityBinding[]
  /** Every binding of one chat (its main thread and its subagent threads), in the order bound. */
  byChat(chat: ChatRef): ActivityBinding[]
  /** Removes every binding of a deleted chat, from memory and from the file. */
  forgetChat(chat: ChatRef): void
}

interface Context {
  file: string
  fs: ChatStoreFs
  /** Every binding in the order bound; null until the file is read. */
  all: ActivityBinding[] | null
  keys: Set<string>
  /** Chat id -> the spawn calls of its main thread by item id, with the attempt id each prompt carried (null for none). */
  spawns: Map<string, Map<string, string | null>>
  /** The file's tail was checked for a cut-off line by this process. */
  checked: boolean
}

// ---- Ids in text ----

function distinct(text: string, pattern: RegExp, group = 0): string[] {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[group] ?? ''))]
}

function single(ids: readonly string[]): string | null {
  return ids.length === 1 ? (ids[0] ?? null) : null
}

/** The one attempt id a text names unambiguously: the labelled one, else the only one; null otherwise. */
function attemptIdIn(text: string | null): string | null {
  if (text === null) {
    return null
  }
  const labelled = distinct(text, LABELLED_ATTEMPT_IDS, 1)
  return single(labelled.length > 0 ? labelled : distinct(text, ATTEMPT_IDS))
}

function runIdIn(text: string | null): string | null {
  return text === null ? null : single(distinct(text, RUN_IDS))
}

/** A field that is exactly an id of the pattern; anything else (a token, a longer word) is not one. */
function exactId(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null
}

// ---- Storage ----

/** What makes a binding new: its chat, thread and run or attempt. The role is what was first bound. */
function keyOf(binding: ActivityBinding): string {
  const id = binding.kind === 'run' ? binding.runId : binding.attemptId
  return JSON.stringify([binding.chatId, binding.folder, binding.threadId, binding.kind, id])
}

function readLines(fs: ChatStoreFs, path: string): string[] {
  try {
    return fs.readFile(path).split('\n')
  } catch {
    return []
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** A stored line as a binding; null for anything else, and for a line that carries a claim token. */
function bindingOf(line: string): ActivityBinding | null {
  if (line.trim() === '' || maskClaimTokens(line) !== line) {
    return null
  }
  const parsed = bindingSchema.safeParse(parseLine(line))
  return parsed.success ? parsed.data : null
}

function loaded(context: Context): ActivityBinding[] {
  if (context.all !== null) {
    return context.all
  }
  const all: ActivityBinding[] = []
  for (const binding of readLines(context.fs, context.file).map(bindingOf)) {
    if (binding !== null && !context.keys.has(keyOf(binding))) {
      context.keys.add(keyOf(binding))
      all.push(binding)
    }
  }
  context.all = all
  return all
}

/** Appends one line; the first append per process starts a fresh line after a cut-off tail. */
function appendLine(context: Context, binding: ActivityBinding): void {
  const { fs, file } = context
  let prefix = ''
  if (!context.checked) {
    fs.mkdirp(dirname(file))
    const text = readLines(fs, file).join('\n')
    prefix = text !== '' && !text.endsWith('\n') ? '\n' : ''
  }
  fs.appendFile(file, `${prefix}${JSON.stringify(binding)}\n`)
  context.checked = true
}

/** Masks, validates and stores a binding not seen before; null when it is known or not a valid binding. */
function add(context: Context, chat: ChatRecord, found: Found): ActivityBinding | null {
  const parsed = bindingSchema.safeParse(
    maskClaimTokensDeep({ chatId: chat.id, threadId: found.threadId, folder: chat.folder, role: found.role, ...found.target })
  )
  if (!parsed.success) {
    return null
  }
  const all = loaded(context)
  const key = keyOf(parsed.data)
  if (context.keys.has(key)) {
    return null
  }
  appendLine(context, parsed.data)
  context.keys.add(key)
  all.push(parsed.data)
  return parsed.data
}

function belongsTo(binding: ActivityBinding, chat: ChatRef): boolean {
  return binding.chatId === chat.id && binding.folder === maskClaimTokens(chat.folder)
}

function forgetChat(context: Context, chat: ChatRef): void {
  context.spawns.delete(chat.id)
  const all = loaded(context)
  const kept = all.filter((binding) => !belongsTo(binding, chat))
  if (kept.length === all.length) {
    return
  }
  context.fs.replaceFile(context.file, kept.map((binding) => `${JSON.stringify(binding)}\n`).join(''))
  context.all = kept
  context.keys = new Set(kept.map(keyOf))
  context.checked = true
}

// ---- What items show ----

/** Only the orchestrator role may start, take over or claim, so this does not depend on what was bound before. */
function orchestrates(chat: ChatRecord): boolean {
  return chat.role === 'orchestrator' || chat.runId !== undefined
}

function roleOf(chat: ChatRecord, threadId: string | null): Role {
  return threadId === null && orchestrates(chat) ? 'orchestrator' : 'worker'
}

function onRun(runId: string | null): Found[] {
  return runId === null ? [] : [{ threadId: null, role: 'orchestrator', target: { kind: 'run', runId } }]
}

function onAttempt(attemptId: string | null, threadId: string | null, role: Role): Found[] {
  return attemptId === null ? [] : [{ threadId, role, target: { kind: 'attempt', attemptId } }]
}

/** A run tool the main thread called and the server answered. */
function fromRunTool(tool: string, call: ToolCall): Found[] {
  const result = call.resultSummary
  switch (tool) {
    case 'start_run':
      return onRun(runIdIn(result))
    case 'takeover_run':
      return onRun(exactId(call.input.runId, RUN_ID))
    case 'claim_ticket':
      return [...onRun(exactId(call.input.runId, RUN_ID)), ...onAttempt(attemptIdIn(result), null, 'orchestrator')]
    default:
      return []
  }
}

/** Remembers a subagent the main thread of an orchestrating chat starts, with the attempt id its prompt carries. */
function rememberSpawn(context: Context, chat: ChatRecord, call: ToolCall): void {
  if (!SPAWN_TOOLS.has(call.name) || call.threadId !== undefined || !orchestrates(chat)) {
    return
  }
  let spawns = context.spawns.get(chat.id)
  if (spawns === undefined) {
    spawns = new Map()
    context.spawns.set(chat.id, spawns)
  }
  const prompt = call.input.prompt
  spawns.set(call.id, typeof prompt === 'string' ? attemptIdIn(prompt) : null)
}

function fromToolCall(context: Context, chat: ChatRecord, call: ToolCall): Found[] {
  const tool = DARK_MECHANICUS_TOOL.exec(call.name)?.[1]
  const threadId = call.threadId ?? null
  if (tool === undefined) {
    rememberSpawn(context, chat, call)
    return []
  }
  if (call.status !== 'completed') {
    return []
  }
  if (ATTEMPT_TOOLS.has(tool)) {
    return onAttempt(exactId(call.input.attemptId, ATTEMPT_ID), threadId, roleOf(chat, threadId))
  }
  return threadId === null ? fromRunTool(tool, call) : []
}

function fromThread(context: Context, chat: ChatRecord, item: ThreadItem): Found[] {
  return onAttempt(context.spawns.get(chat.id)?.get(item.parentItemId) ?? null, item.id, 'worker')
}

function observe(context: Context, chat: ChatRecord, item: ChatItem): ActivityBinding[] {
  const found = item.kind === 'tool_call' ? fromToolCall(context, chat, item) : item.kind === 'thread' ? fromThread(context, chat, item) : []
  return found.flatMap((each) => add(context, chat, each) ?? [])
}

function observeChat(context: Context, chat: ChatRecord, items: readonly ChatItem[]): ActivityBinding[] {
  const own = chat.runId === undefined ? [] : onRun(chat.runId).flatMap((each) => add(context, chat, each) ?? [])
  return [...own, ...items.flatMap((item) => observe(context, chat, item))]
}

function matching(context: Context, test: (binding: ActivityBinding) => boolean): ActivityBinding[] {
  return loaded(context)
    .filter(test)
    .map((binding) => ({ ...binding }))
}

export function createActivityBindings(options: {
  /** Absolute path of the bindings file (`userData/agents/activity-bindings.jsonl`). */
  file: string
  fs?: ChatStoreFs
}): ActivityBindings {
  const context: Context = { file: options.file, fs: options.fs ?? nodeChatStoreFs, all: null, keys: new Set(), spawns: new Map(), checked: false }
  return {
    observe: (chat, item) => observe(context, chat, item),
    observeChat: (chat, items) => observeChat(context, chat, items),
    byAttempt: (attemptId) => matching(context, (binding) => binding.kind === 'attempt' && binding.attemptId === attemptId),
    byRun: (runId) => matching(context, (binding) => binding.kind === 'run' && binding.runId === runId),
    byChat: (chat) => matching(context, (binding) => belongsTo(binding, chat)),
    forgetChat: (chat) => {
      forgetChat(context, chat)
    }
  }
}
