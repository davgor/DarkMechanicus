/**
 * The Claude adapter: drives the user's own `claude` executable through the Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`), in the chat's folder.
 *
 * Turns. One SDK `query` with streaming input carries the whole chat: `send` queues a user message
 * and settles when the turn's `result` message arrives. The process starts on the first message
 * (the SDK is loaded then, not at app start) and runs until `dispose`, the idle timeout in the
 * session manager, or its own death; the next message starts it again, resuming the stored session.
 * The CLI also starts turns of its own (it answers when a background subagent it ran has ended): what the
 * main agent says with no `send` waiting is such a turn, and its result ends it. `hasLiveWork` counts it,
 * with the work the transcript mapper knows to be going on (see `claudeTranscript`), so the idle timeout
 * never ends a process in the middle of it.
 *
 * Approvals. The CLI runs in its `default` permission mode and asks the host through `canUseTool`.
 * Reads and searches inside the folder are allowed at once; edits, commands and everything else
 * become approval requests the adapter holds until the person answers (see `claudeApprovals`).
 * Allow, Allow for this chat and Deny all answer the CLI at once; "for this chat" is remembered by
 * the session manager, which answers matching requests itself so each one is recorded in the
 * transcript, and no permission rule is written to any settings file.
 *
 * Memory. The CLI's own auto-memory writes notes under `~/.claude/projects/<project>/memory/` and
 * allows those writes without asking, so `canUseTool` never sees them. Every process the adapter
 * starts is given `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, so Claude Code saves no note of its own
 * unasked. The switch travels in the process environment, per session: none of the person's Claude
 * Code settings is read for it, written or changed. The CLI allows a write the agent is asked to make
 * into that folder just as quietly, a shell redirect included, so each process also gets two things in
 * the query options (see `claudeMemoryFolder`): its `autoMemoryDirectory` is set to a folder of the
 * app's that nothing reads, so the CLI's own rules ask about every other memory folder, and a
 * `PreToolUse` hook answers `ask` for a Write, Edit, MultiEdit or NotebookEdit whose target resolves
 * into a memory folder, so `canUseTool` raises an ordinary file-edit request. No settings file is written.
 *
 * Subagents. What a subagent does is a nested thread of the chat (see `claudeTranscript`), and the
 * CLI is asked to forward its text as well as its tool calls. A request raised inside a subagent goes
 * through the same flow and carries its thread's id and label. When the process ends, the threads
 * still running are marked failed and the calls still running cancelled: they died with it.
 *
 * Context. The SDK session id is reported as a `session` event and passed back as `resume` when a
 * chat is reopened. A process that dies before saying anything while resuming means the session is
 * gone (deleted, or the CLI was reinstalled): the adapter records a `context_reset` item and
 * carries on in a new session with the same message.
 *
 * Models. `listModels` asks the SDK (`supportedModels`), through the running process when there is
 * one, otherwise through a short-lived helper process; a curated list stands in when that fails.
 * Any model name is accepted. `setModel` takes effect from the next turn.
 *
 * Sign-in. A turn the CLI ends because its login was rejected is reported as an `auth_required`
 * item (see `claudeTranscript`) and ends cleanly. The process is then closed and its tree killed,
 * so none is left running for the turn and the next message starts a new one that reads the
 * person's new login, resuming the same session.
 *
 * Process tree. The SDK starts the CLI through `claudeProcess`, which kills the whole tree on
 * `dispose` (before the query is closed) and resolves once it is gone, so quitting waits for it.
 */
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { CanUseTool, ModelInfo, Options, PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  ApprovalDecision,
  ApprovalRequestItem,
  ChatAdapter,
  ChatAdapterEmit,
  ChatAdapterEvent,
  ChatAdapterStartOptions,
  McpServerSpec,
  ModelOption
} from '../../../shared/agents/chat'
import type { ChatAdapterDefinition } from '../adapterRegistry'
import { maskClaimTokens } from '../claimTokenMask'
import { classifyTool } from './claudeApprovals'
import { memoryWriteMatcher, pinnedMemoryFolder } from './claudeMemoryFolder'
import {
  createClaudeProcesses,
  createInputQueue,
  readShimFile,
  resolveClaudeExecutable,
  type ClaudeProcesses,
  type InputQueue
} from './claudeProcess'
import { plainInput, TranscriptMapper, type TurnResult } from './claudeTranscript'

/** What the adapter uses of an SDK `Query`; the real one satisfies it, and tests replay messages through it. */
export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>
  setModel(model?: string): Promise<void>
  supportedModels(): Promise<ModelInfo[]>
  close(): void
}

export type ClaudeQueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
}) => ClaudeQuery | Promise<ClaudeQuery>

export interface ClaudeAdapterDeps {
  /** Starts an SDK query. The default loads the SDK on first use. */
  query: ClaudeQueryFactory
  now: () => string
  newId: () => string
  /** Milliseconds, for how long a model list is remembered. */
  clock: () => number
  platform: string
  /** The person's home folder, which a `~` path and the default memory folder start from. */
  homeDir: () => string
  /** The temp folder, where the folder the CLI is told to keep its memory in lies. */
  tempDir: () => string
  /** The environment the CLI inherits; the adapter adds its own switches on top. */
  env: () => NodeJS.ProcessEnv
  readFile: (path: string) => string
  /** A fresh process tracker: one per chat, and one per helper process that lists models. */
  createProcesses: () => ClaudeProcesses
  /** How long listing models may take before the curated list is used instead. */
  modelTimeoutMs: number
}

/** Shown when the SDK cannot be asked; "default" is the CLI's own choice, the rest are its aliases. */
export const CURATED_CLAUDE_MODELS: ModelOption[] = [
  { id: 'default', label: 'Default (recommended)' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' }
]

const SERVER_NAME = 'darkmechanicus'
/**
 * Claude Code's documented switch for auto-memory (https://code.claude.com/docs/en/memory#enable-or-disable-auto-memory).
 * Unlike the `autoMemoryEnabled` setting it wins over every settings layer and over a value the person has
 * in their own environment.
 */
const AUTO_MEMORY_OFF = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }
const SHUT_DOWN = 'The Claude Code session was shut down.'
const MODEL_LIST_TTL_MS = 10 * 60_000
const MAX_DETAIL_CHARS = 600
const LAUNCH_FAILURE = /executable|native binary|failed to launch|ENOENT|EACCES/i

const loadSdkQuery: ClaudeQueryFactory = async (params) => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return sdk.query(params)
}

function withDefaults(overrides: Partial<ClaudeAdapterDeps>): ClaudeAdapterDeps {
  return {
    query: loadSdkQuery,
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
    clock: () => Date.now(),
    platform: process.platform,
    homeDir: homedir,
    tempDir: tmpdir,
    env: () => process.env,
    readFile: readShimFile,
    createProcesses: () => createClaudeProcesses(),
    modelTimeoutMs: 20_000,
    ...overrides
  }
}

function closeQuietly(query: ClaudeQuery | null): void {
  try {
    query?.close()
  } catch {
    // Already closed; there is nothing left to release.
  }
}

/** `default` is the CLI's own choice: the SDK takes no model for it. */
function sdkModel(model: string | null): string | undefined {
  return model === null || model === 'default' ? undefined : model
}

function stdioServer(spec: McpServerSpec): Record<string, { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }> {
  const env = spec.env === undefined ? {} : { env: spec.env }
  return { [SERVER_NAME]: { type: 'stdio', command: spec.command, args: spec.args, ...env } }
}

// ---- Models ----

function toModelOptions(infos: ModelInfo[]): ModelOption[] | null {
  const options = infos.filter((info) => info.value !== '').map((info) => ({ id: info.value, label: info.displayName || info.value }))
  return options.length === 0 ? null : options
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Listing models timed out.'))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

/** The models a short-lived helper process reports, or null when it cannot be asked. */
async function probeModels(executablePath: string, deps: ClaudeAdapterDeps): Promise<ModelOption[] | null> {
  const processes = deps.createProcesses()
  const input = createInputQueue<SDKUserMessage>()
  let query: ClaudeQuery | null = null
  try {
    query = await deps.query({
      prompt: input.iterable,
      options: {
        cwd: homedir(),
        pathToClaudeCodeExecutable: resolveClaudeExecutable(executablePath, deps.platform, deps.readFile),
        spawnClaudeCodeProcess: processes.spawn,
        // Nothing of the user's setup is loaded or started just to ask which models exist.
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        permissionMode: 'default'
      }
    })
    return toModelOptions(await withTimeout(query.supportedModels(), deps.modelTimeoutMs))
  } catch {
    return null
  } finally {
    input.close()
    void processes.killAll()
    closeQuietly(query)
  }
}

// ---- The adapter ----

interface Live {
  query: ClaudeQuery
  input: InputQueue<SDKUserMessage>
  /** Started with `resume`, so a failure before the first message may mean the session is gone. */
  resumed: boolean
  /** The CLI has said something besides a result, so it started and a later failure is not about resuming. */
  started: boolean
}

interface Turn {
  text: string
  /** `stop` was called: an error result then is the interruption, not a failure. */
  interrupted: boolean
  resolve: () => void
  reject: (error: Error) => void
  done: Promise<void>
}

/** An approval waiting for the person (or for the CLI to give up on it). */
interface Pending {
  settle: (outcome: ApprovalDecision | 'cancelled') => void
}

function newTurn(text: string): Turn {
  const turn = { text, interrupted: false } as Turn
  turn.done = new Promise<void>((resolve, reject) => {
    turn.resolve = resolve
    turn.reject = reject
  })
  // The caller of send() sees a rejection; one nobody is awaiting (a disposed chat) must not escape.
  turn.done.catch(() => undefined)
  return turn
}

/**
 * A resumed session that fails before the CLI has said anything but this error result is a session
 * the CLI could not find. A result that names a startup failure (sign-in, policy, folder) is not.
 */
function isLostSession(live: Live, result: TurnResult | null): result is TurnResult & { error: string } {
  return result !== null && result.error !== null && live.resumed && !live.started && !result.startupFailure && !LAUNCH_FAILURE.test(result.error)
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

class ClaudeChatAdapter implements ChatAdapter {
  readonly kind = 'claude'
  private options: ChatAdapterStartOptions | null = null
  private emit!: ChatAdapterEmit
  private launchPath: string
  private model: string | null = null
  /** The model the running process was told to use. */
  private appliedModel: string | null = null
  private sessionId: string | null = null
  private live: Live | null = null
  private turn: Turn | null = null
  /** The CLI is answering in a turn it started on its own, with no `send` waiting; its result ends it. */
  private ownTurn = false
  private disposed = false
  private readonly processes: ClaudeProcesses
  private readonly mapper: TranscriptMapper
  private readonly pending = new Set<Pending>()

  constructor(
    private readonly executablePath: string,
    private readonly deps: ClaudeAdapterDeps
  ) {
    this.launchPath = executablePath
    this.processes = deps.createProcesses()
    this.mapper = new TranscriptMapper({ now: deps.now, newId: deps.newId })
  }

  start(options: ChatAdapterStartOptions, emit: ChatAdapterEmit): Promise<void> {
    this.options = options
    this.emit = emit
    this.model = options.model
    this.sessionId = options.sessionId
    try {
      this.launchPath = resolveClaudeExecutable(this.executablePath, this.deps.platform, this.deps.readFile)
    } catch (error) {
      return Promise.reject(toError(error))
    }
    return Promise.resolve()
  }

  async send(text: string): Promise<void> {
    if (this.options === null) {
      throw new Error('The Claude Code session has not been started.')
    }
    if (this.disposed) {
      throw new Error(SHUT_DOWN)
    }
    if (this.turn !== null) {
      throw new Error('Claude is already answering. Stop it or wait for it to finish.')
    }
    const turn = newTurn(text)
    this.turn = turn
    try {
      const live = await this.ensureLive()
      await this.applyModel(live)
      if (turn.interrupted) {
        this.turn = null
        return
      }
      this.deliver(live, text)
    } catch (error) {
      if (this.turn === turn) {
        this.turn = null
      }
      throw error
    }
    return turn.done
  }

  setModel(model: string): Promise<void> {
    this.model = model
    return Promise.resolve()
  }

  async stop(): Promise<void> {
    const turn = this.turn
    if (turn === null) {
      return
    }
    turn.interrupted = true
    this.denyPending()
    await this.live?.query.interrupt()
  }

  async listModels(): Promise<ModelOption[]> {
    if (this.live !== null) {
      try {
        return toModelOptions(await this.live.query.supportedModels()) ?? CURATED_CLAUDE_MODELS
      } catch {
        return CURATED_CLAUDE_MODELS
      }
    }
    return (await probeModels(this.executablePath, this.deps)) ?? CURATED_CLAUDE_MODELS
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.denyPending()
    const { live, turn } = this
    this.live = null
    this.turn = null
    // The tree first: once the program has exited, what it started can no longer be found through it.
    const treeGone = this.processes.killAll()
    live?.input.close()
    closeQuietly(live?.query ?? null)
    turn?.reject(new Error(SHUT_DOWN))
    await treeGone
  }

  hasLiveWork(): boolean {
    return !this.disposed && (this.turn !== null || this.ownTurn || this.mapper.hasLiveWork())
  }

  // ---- Starting the process ----

  private async ensureLive(): Promise<Live> {
    return this.live ?? (await this.launch(this.sessionId))
  }

  private async launch(resume: string | null): Promise<Live> {
    const input = createInputQueue<SDKUserMessage>()
    const query = await this.deps.query({ prompt: input.iterable, options: this.queryOptions(resume) })
    if (this.disposed) {
      // Disposed while the SDK was loading: whatever it started is not left running.
      const treeGone = this.processes.killAll()
      closeQuietly(query)
      await treeGone
      throw new Error(SHUT_DOWN)
    }
    const live: Live = { query, input, resumed: resume !== null, started: false }
    this.live = live
    this.appliedModel = this.model
    void this.pump(live)
    return live
  }

  private queryOptions(resume: string | null): Options {
    const options = this.options as ChatAdapterStartOptions
    const model = sdkModel(this.model)
    // A copy: the inherited environment is the process's own and stays as it was.
    const env = { ...this.deps.env(), ...AUTO_MEMORY_OFF }
    const memory = { env, home: this.deps.homeDir(), tmp: this.deps.tempDir(), platform: this.deps.platform }
    return {
      cwd: options.folder,
      pathToClaudeCodeExecutable: this.launchPath,
      spawnClaudeCodeProcess: this.processes.spawn,
      permissionMode: 'default',
      env,
      // Inline, for this process only: the CLI's memory-folder carve-out moves to a folder nothing reads.
      settings: { autoMemoryDirectory: pinnedMemoryFolder(memory) },
      canUseTool: this.canUseTool,
      // Runs before the CLI's own permission check, which lets a memory-folder write through unasked.
      hooks: { PreToolUse: [memoryWriteMatcher(memory, options.folder)] },
      includePartialMessages: true,
      // Without this the CLI sends only a subagent's tool calls; with it, its text too, so a thread holds its whole conversation.
      forwardSubagentText: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      mcpServers: stdioServer(options.darkMechanicus),
      ...(model === undefined ? {} : { model }),
      ...(resume === null ? {} : { resume })
    }
  }

  private async applyModel(live: Live): Promise<void> {
    if (this.appliedModel === this.model) {
      return
    }
    await live.query.setModel(sdkModel(this.model))
    this.appliedModel = this.model
  }

  private deliver(live: Live, text: string): void {
    live.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
  }

  // ---- Reading the stream ----

  private async pump(live: Live): Promise<void> {
    let failure: unknown = null
    try {
      for await (const message of live.query) {
        if (this.live !== live) {
          return
        }
        this.handle(live, message)
      }
    } catch (error) {
      failure = error
    }
    this.onEnded(live, failure)
  }

  private handle(live: Live, message: SDKMessage): void {
    const { events, result } = this.mapper.map(message)
    const turn = this.turn
    if (turn !== null && isLostSession(live, result)) {
      // The CLI answers a session it cannot find with an error result and nothing else.
      this.discard(live)
      void this.continueInNewSession(turn, result.error)
      return
    }
    if (message.type !== 'result') {
      live.started = true
    }
    this.noteOwnTurn(message)
    for (const event of events) {
      this.publish(event)
    }
    if (result !== null) {
      this.finishTurn(result)
      if (result.authRequired) {
        this.endProcess(live)
      }
    }
  }

  /** What the main agent says while no `send` waits belongs to a turn the CLI started on its own; a result ends it. */
  private noteOwnTurn(message: SDKMessage): void {
    if (message.type === 'result') {
      this.ownTurn = false
    } else if (this.turn === null && (message.type === 'assistant' || message.type === 'stream_event') && message.parent_tool_use_id === null) {
      this.ownTurn = true
    }
  }

  private publish(event: ChatAdapterEvent): void {
    if (event.type === 'session') {
      this.sessionId = event.sessionId
    }
    this.emit(event)
  }

  private finishTurn(result: TurnResult): void {
    const turn = this.turn
    if (turn === null) {
      return
    }
    this.turn = null
    if (result.error !== null && !turn.interrupted) {
      turn.reject(new Error(result.error))
    } else {
      turn.resolve()
    }
  }

  /** The stream ended: the process exited, died, or was closed by `dispose`. */
  private onEnded(live: Live, failure: unknown): void {
    if (this.live !== live) {
      return
    }
    this.discard(live)
    const turn = this.turn
    if (turn === null) {
      return
    }
    const detail = this.describeFailure(failure)
    if (live.resumed && !live.started && !LAUNCH_FAILURE.test(detail)) {
      void this.continueInNewSession(turn, detail)
      return
    }
    this.turn = null
    turn.reject(new Error(detail))
  }

  /** Closes the process and kills its tree, so nothing runs on a login that was rejected. */
  private endProcess(live: Live): void {
    this.discard(live)
    void this.processes.killAll()
  }

  /** Lets go of a process that is done or no longer wanted; the calls and subagents it was running are gone with it. */
  private discard(live: Live): void {
    this.live = null
    this.ownTurn = false
    live.input.close()
    closeQuietly(live.query)
    for (const event of this.mapper.processEnded()) {
      this.publish(event)
    }
  }

  /** What went wrong, with the end of the process's stderr when it has something to add. */
  private describeFailure(failure: unknown): string {
    const base = failure === null ? 'Claude Code stopped before the turn finished.' : toError(failure).message
    const tail = maskClaimTokens(this.processes.stderrTail().trim()).slice(-MAX_DETAIL_CHARS)
    return tail === '' || base.includes(tail) ? base : `${base}\n${tail}`
  }

  private async continueInNewSession(turn: Turn, detail: string): Promise<void> {
    this.publish(
      this.mapper.reset('session_lost', `The earlier Claude Code session could not be resumed (${detail}), so this chat continues in a new one.`)
    )
    this.sessionId = null
    try {
      this.deliver(await this.launch(null), turn.text)
    } catch (error) {
      if (this.turn === turn) {
        this.turn = null
        turn.reject(toError(error))
      }
    }
  }

  // ---- Approvals ----

  private readonly canUseTool: CanUseTool = async (tool, input, options): Promise<PermissionResult> => {
    const verdict = classifyTool(tool, input, (this.options as ChatAdapterStartOptions).folder)
    const toolUseID = options.toolUseID
    if (verdict.kind === 'allow') {
      return { behavior: 'allow', updatedInput: input, toolUseID }
    }
    if (verdict.kind === 'deny') {
      this.mapper.deny(toolUseID)
      return { behavior: 'deny', message: verdict.message, toolUseID }
    }
    const summary = options.title !== undefined && options.title !== '' ? options.title : verdict.summary
    const thread = this.mapper.threadOfRequest(toolUseID, options.agentID)
    const request: ApprovalRequestItem = {
      id: `claude_approval_${toolUseID}`,
      at: this.deps.now(),
      kind: 'approval_request',
      requestId: toolUseID,
      category: verdict.category,
      tool,
      summary,
      input: plainInput(input),
      ...(thread === null ? {} : { threadId: thread.id, threadLabel: thread.label })
    }
    const outcome = await this.ask(request, options.signal)
    if (outcome === 'allow_once' || outcome === 'allow_chat') {
      return { behavior: 'allow', updatedInput: input, toolUseID }
    }
    this.mapper.deny(toolUseID)
    const message = outcome === 'deny' ? 'The person declined this request in Dark Mechanicus.' : 'The request was cancelled.'
    return { behavior: 'deny', message, toolUseID }
  }

  /** Raises the request and waits for the answer, or for the CLI to give up on it. */
  private ask(request: ApprovalRequestItem, signal: AbortSignal): Promise<ApprovalDecision | 'cancelled'> {
    return new Promise((resolve) => {
      if (signal.aborted || this.disposed) {
        resolve('cancelled')
        return
      }
      const onAbort = (): void => entry.settle('cancelled')
      const entry: Pending = {
        settle: (outcome) => {
          if (this.pending.delete(entry)) {
            signal.removeEventListener('abort', onAbort)
            resolve(outcome)
          }
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.add(entry)
      this.publish({ type: 'approval_request', request, respond: (decision) => entry.settle(decision) })
    })
  }

  private denyPending(): void {
    for (const entry of this.pending) {
      entry.settle('cancelled')
    }
  }
}

export function createClaudeAdapter(executablePath: string, overrides: Partial<ClaudeAdapterDeps> = {}): ChatAdapter {
  return new ClaudeChatAdapter(executablePath, withDefaults(overrides))
}

export function createClaudeAdapterDefinition(overrides: Partial<ClaudeAdapterDeps> = {}): ChatAdapterDefinition {
  const deps = withDefaults(overrides)
  const remembered = new Map<string, { until: number; models: ModelOption[] }>()
  return {
    // The process starts with the first message; nothing needs it running to show an opened chat.
    startOnOpen: false,
    create: (executablePath) => createClaudeAdapter(executablePath, overrides),
    listModels: async (executablePath) => {
      const known = remembered.get(executablePath)
      if (known !== undefined && known.until > deps.clock()) {
        return known.models
      }
      const models = await probeModels(executablePath, deps)
      if (models === null) {
        return CURATED_CLAUDE_MODELS
      }
      remembered.set(executablePath, { until: deps.clock() + MODEL_LIST_TTL_MS, models })
      return models
    }
  }
}

export const claudeAdapterDefinition: ChatAdapterDefinition = createClaudeAdapterDefinition()
