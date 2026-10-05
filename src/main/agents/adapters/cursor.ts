/**
 * The Cursor chat adapter: runs `agent acp` (Agent Client Protocol over stdio) in the chat's folder.
 *
 * Session. `initialize`, `authenticate` (Cursor's stored login), then `session/new` with the folder
 * and the chat's Dark Mechanicus server in `mcpServers`, or `session/load` with the stored session
 * id to resume. A session that cannot be loaded becomes a `context_reset` item and a new session.
 * A process that dies between turns is started again and resumes the same way on the next message.
 *
 * Models. The list comes from `agent models` (`agent --list-models` when that lists nothing).
 * `setModel` only records the choice; the next turn restarts the process as `agent --model <id> acp`
 * and loads the same session. In-process switching (`session/set_config_option`) is not used:
 * Cursor staff said in July 2026 that switching models at runtime through ACP "isn't something we
 * support today" and recommended `--model`, and forum reports show it changing what the session
 * says it runs without changing the model that answers.
 *
 * Sign-in. A login Cursor rejects is reported as one `auth_required` item and the turn ends
 * cleanly, with the process killed so none runs on the old login: an error answer for `authenticate`,
 * `session/new`, `session/load` or `session/prompt`, or a turn whose whole answer is the sign-in
 * sentence a stale process gives instead of an error (see `cursorAuth.ts`; the shapes are from Cursor's
 * forum and the ACP specification, not from a real CLI). A refusal while the chat is being started is
 * held until the first message, which starts a new process and tries again.
 *
 * Subagents. Everything stays in the chat's own thread. Cursor's ACP page (https://cursor.com/docs/cli/acp,
 * read 2026-10-05) tells the client only that a subagent task exists: the `cursor/task` extension carries
 * the task's `toolCallId`, description, prompt, subagent type and (once known) agent id and duration, and
 * nothing in it, in the stable Agent Client Protocol (https://agentclientprotocol.com/protocol) or on
 * Cursor's page names a session of the subagent or relates its messages and tool calls to the task that
 * started it. So the task shows as the tool call it is, the `cursor/task` message is answered (see
 * `CursorSession`) and no `thread` item is written: a thread would hold nothing. The ACP draft for
 * subagent sessions (`subagent_update`, agentclientprotocol/agent-client-protocol `docs/rfds/subagents.mdx`,
 * 2026-09-30) is sent only to a client that advertises the `subagents` capability, which this one does
 * not, and nothing read from Cursor says it sends them. Not verified against a real CLI (none is
 * installed here); `__mocks__/cursorSubagents.ts` is built from the documents, not recorded.
 *
 * Stop. `session/cancel`; if the agent has not ended the turn within a grace period the process is
 * killed (the next message resumes the session in a new one). `dispose` kills the whole tree and resolves
 * once it is gone.
 *
 * Dark Mechanicus MCP. The server is passed in `session/new`/`session/load` as `darkmechanicus`;
 * nothing is enabled and nothing is written to Cursor's config. `--approve-mcps` is not wired into
 * ACP (Cursor staff, March 2026), and `agent mcp enable <id>` approves servers from the user's own
 * `mcp.json` files by writing under `~/.cursor`, which could approve a same-named server the person
 * wrote themselves. The same forum thread (https://forum.cursor.com/t/153823) has a staff post
 * dated 2026-10-04 saying that since June 2026 servers passed in `session/new` are no longer
 * blocked by the file-based approval step, and an ACP client's notes (erebusdev/vscode-cursor-agent
 * PR 2) say such servers are not gated and replace same-name config entries. Not verified against a
 * real CLI (none is installed here): if an older Cursor still gates the server, the Dark Mechanicus
 * tools are simply missing from that chat; the adapter cannot see that and does not work around it.
 */
import { randomUUID } from 'node:crypto'
import type {
  ChatAdapter,
  ChatAdapterEmit,
  ChatAdapterEvent,
  ChatAdapterStartOptions,
  ChatItem,
  ModelOption
} from '../../../shared/agents/chat'
import type { AgentKind } from '../../../shared/desktop/api'
import type { AgentProbeDeps, ProcessOutcome, ProcessRunner } from '../../desktop/agentProbe'
import { inspectExecutable, runProcess } from '../../desktop/agentProbeNode'
import type { ChatAdapterDefinition } from '../adapterRegistry'
import type { TransportFactory } from './acpClient'
import { nodeTransport } from './acpProcess'
import { cursorLaunch } from './cursorLaunch'
import { isAuthRequired, isSignInPrompt } from './cursorAuth'
import { clip, isSafeModelId, parseModelList } from './cursorProtocol'
import { CursorSession } from './cursorSession'

/** Everything the adapter needs from the outside, so tests can run it against recordings. */
export interface CursorDeps extends Pick<AgentProbeDeps, 'platform' | 'inspect' | 'comspec'> {
  transport: TransportFactory
  /** Runs `agent models`. */
  run: ProcessRunner
  newId(): string
  now(): string
  timers: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
  /** How long the agent may take to end a cancelled turn before its process is killed. */
  cancelGraceMs: number
  clientVersion: string
}

/** Long enough for a cold start and a network round trip for the account's models. */
const LIST_MODELS_TIMEOUT_MS = 30_000

const STOP_FAILURES = new Map<string, string>([
  ['max_tokens', 'Cursor stopped because the answer reached its length limit.'],
  ['max_turn_requests', 'Cursor stopped because it took too many steps in one turn.'],
  ['refusal', 'Cursor declined to continue with this request.']
])

type ResetReason = Extract<ChatItem, { kind: 'context_reset' }>['reason']

interface Turn {
  /** Stop was requested. */
  stopped: boolean
  /** The session the prompt went to; null until the process is ready. */
  session: CursorSession | null
  timer: unknown
}

function describeListFailure(outcome: ProcessOutcome): string {
  if (outcome.kind === 'timed_out') {
    return 'Cursor did not answer when asked for its models.'
  }
  if (outcome.kind === 'spawn_failed') {
    return `Cursor could not be started to list its models${outcome.code === null ? '' : ` (${outcome.code})`}.`
  }
  const firstLine = outcome.output.split(/\r?\n/).find((line) => line.trim() !== '')
  if (outcome.exitCode !== 0) {
    return firstLine === undefined
      ? `Cursor exited with code ${outcome.exitCode} when asked for its models.`
      : clip(firstLine.trim(), 300)
  }
  return 'Cursor printed no models.'
}

/** The models the signed-in account can use, from `agent models` (or `agent --list-models`). */
export async function listCursorModels(executablePath: string, deps: CursorDeps): Promise<ModelOption[]> {
  const failures: string[] = []
  for (const command of ['models', '--list-models'] as const) {
    const outcome = await deps.run(cursorLaunch(executablePath, { command, model: null }, deps), LIST_MODELS_TIMEOUT_MS)
    const models = outcome.kind === 'exited' && outcome.exitCode === 0 ? parseModelList(outcome.output) : []
    if (models.length > 0) {
      return models
    }
    failures.push(describeListFailure(outcome))
  }
  throw new Error(failures[0])
}

class CursorAdapter implements ChatAdapter {
  readonly kind: AgentKind = 'cursor'
  private options: ChatAdapterStartOptions | null = null
  private emitter: ChatAdapterEmit | null = null
  private session: CursorSession | null = null
  /** The model the chat wants; the process runs `runningModel` until the next turn. */
  private model: string | null = null
  private runningModel: string | null = null
  private sessionId: string | null = null
  private turn: Turn | null = null
  /** What the running turn has put in the transcript so far. */
  private turnItems: ChatItem[] = []
  private disposed = false

  constructor(
    private readonly executablePath: string,
    private readonly deps: CursorDeps
  ) {}

  async start(options: ChatAdapterStartOptions, emit: ChatAdapterEmit): Promise<void> {
    this.options = options
    this.emitter = emit
    this.model = options.model
    this.sessionId = options.sessionId
    try {
      await this.connect(options, 'session_lost')
    } catch (error) {
      // A login Cursor refuses is reported by the first message, which tries again; the process is already gone.
      if (!isAuthRequired(error)) {
        throw error
      }
    }
  }

  async send(text: string): Promise<void> {
    const options = this.options
    if (options === null) {
      throw new Error('This Cursor chat has not started.')
    }
    if (this.disposed) {
      throw new Error('This Cursor chat has ended.')
    }
    const turn: Turn = { stopped: false, session: null, timer: null }
    this.turn = turn
    try {
      const session = await this.readySession(options)
      if (!turn.stopped) {
        turn.session = session
        this.turnItems = []
        this.checkStopReason(await session.prompt(text))
        this.checkSignInPrompt()
      }
    } catch (error) {
      // A turn that was stopped ends quietly, even if stopping it took the process down with it.
      if (!turn.stopped && !this.reportRefusal(error)) {
        throw error
      }
    } finally {
      this.turn = null
      this.clearTimer(turn)
    }
  }

  setModel(model: string): Promise<void> {
    if (!isSafeModelId(model)) {
      return Promise.reject(new Error(`${JSON.stringify(clip(model, 60))} is not a model id Cursor can be started with.`))
    }
    this.model = model
    return Promise.resolve()
  }

  stop(): Promise<void> {
    const turn = this.turn
    if (turn === null || turn.stopped) {
      return Promise.resolve()
    }
    turn.stopped = true
    const session = turn.session
    if (session !== null) {
      session.cancel()
      turn.timer = this.deps.timers.set(() => {
        void session.kill()
      }, this.deps.cancelGraceMs)
    }
    return Promise.resolve()
  }

  listModels(): Promise<ModelOption[]> {
    return listCursorModels(this.executablePath, this.deps)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.turn !== null) {
      this.clearTimer(this.turn)
    }
    const treeGone = this.session?.kill()
    this.session = null
    await treeGone
  }

  private emit(event: ChatAdapterEvent): void {
    if (!this.disposed) {
      if (event.type === 'item') {
        this.turnItems.push(event.item)
      }
      this.emitter?.(event)
    }
  }

  /** Reports an error answer that says the login is gone as the turn's end; false for any other error. */
  private reportRefusal(error: unknown): boolean {
    if (!isAuthRequired(error)) {
      return false
    }
    this.reportSignedOut(error.message)
    return true
  }

  /** A turn whose whole answer is the sentence a stale process gives instead of an error ended on a rejected login. */
  private checkSignInPrompt(): void {
    const [only, ...more] = this.turnItems
    if (only?.kind === 'assistant_text' && more.length === 0 && isSignInPrompt(only.text)) {
      this.reportSignedOut(only.text.trim())
    }
  }

  /** One `auth_required` item, and the process is killed so the next message starts one that reads the new login. */
  private reportSignedOut(message: string): void {
    this.emit({ type: 'item', item: { id: this.deps.newId(), at: this.deps.now(), kind: 'auth_required', agent: 'cursor', message } })
    void this.session?.kill()
    this.session = null
  }

  private clearTimer(turn: Turn): void {
    if (turn.timer !== null) {
      this.deps.timers.clear(turn.timer)
      turn.timer = null
    }
  }

  private checkStopReason(reason: string): void {
    const failure = STOP_FAILURES.get(reason)
    if (failure !== undefined) {
      throw new Error(failure)
    }
  }

  /** The live process, restarted first when it ended or when the chat's model changed since it started. */
  private async readySession(options: ChatAdapterStartOptions): Promise<CursorSession> {
    const current = this.session
    if (current !== null && !current.isClosed() && this.runningModel === this.model) {
      return current
    }
    const reason: ResetReason = current !== null && this.runningModel !== this.model ? 'model_change' : 'session_lost'
    void current?.kill()
    return this.connect(options, reason)
  }

  /** Starts `agent acp` and opens the session: the stored one if it can be loaded, else a new one. */
  private async connect(options: ChatAdapterStartOptions, reason: ResetReason): Promise<CursorSession> {
    const launch = cursorLaunch(this.executablePath, { command: 'acp', model: this.model }, this.deps)
    const session = new CursorSession(this.deps, launch, {
      folder: options.folder,
      server: options.darkMechanicus,
      emit: (event) => {
        this.emit(event)
      }
    })
    this.session = session
    this.runningModel = this.model
    try {
      const begun = await session.begin(this.sessionId)
      if (begun.lost !== null) {
        this.emit({ type: 'item', item: this.contextReset(reason, begun.lost) })
      }
      if (begun.sessionId !== this.sessionId) {
        this.sessionId = begun.sessionId
        this.emit({ type: 'session', sessionId: begun.sessionId })
      }
    } catch (error) {
      void session.kill()
      if (this.session === session) {
        this.session = null
      }
      throw error
    }
    return session
  }

  private contextReset(reason: ResetReason, why: string): ChatItem {
    return {
      id: this.deps.newId(),
      at: this.deps.now(),
      kind: 'context_reset',
      reason,
      message: `Cursor could not resume the earlier session (${why}), so this chat continues in a new one without its history.`
    }
  }
}

export function createCursorAdapter(executablePath: string, deps: CursorDeps): ChatAdapter {
  return new CursorAdapter(executablePath, deps)
}

function nodeDeps(): CursorDeps {
  return {
    platform: process.platform,
    inspect: inspectExecutable,
    transport: nodeTransport,
    run: runProcess,
    newId: () => `item_${randomUUID()}`,
    now: () => new Date().toISOString(),
    timers: {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
      }
    },
    cancelGraceMs: 10_000,
    clientVersion: process.env.npm_package_version ?? 'dev'
  }
}

/** Cursor chats start on the first message: `agent acp` has nothing to show before one is sent. */
export const cursorAdapterDefinition: ChatAdapterDefinition = {
  startOnOpen: false,
  create: (executablePath) => createCursorAdapter(executablePath, nodeDeps()),
  listModels: (executablePath) => listCursorModels(executablePath, nodeDeps())
}
