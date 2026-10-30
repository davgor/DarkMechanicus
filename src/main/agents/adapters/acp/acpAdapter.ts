/**
 * The chat adapter for an agent that speaks the Agent Client Protocol over stdio, run in the chat's
 * folder. What differs between such agents is a flavor (`AcpFlavor`): how the executable is started,
 * its auth method, the client capabilities it is offered beyond the common ones, the request methods
 * it sends beyond `session/request_permission` (answered at once or when the person has answered),
 * how its models are listed and switched, and the sentence it answers with when its login went stale.
 * Everything else is here.
 *
 * Session. `initialize`, `authenticate` with the flavor's auth method (none when it has none), then
 * `session/new` with the folder, or `session/load` with the stored session id to resume. A session
 * that cannot be loaded becomes a `context_reset` item and a new session. A process that dies between
 * turns is started again and resumes the same way on the next message.
 *
 * Models. With `switchModel: 'relaunch'`, `setModel` only records the choice; the next turn restarts
 * the process with the flavor's launch arguments for that model and loads the same session. With
 * `'config_option'` the next turn switches the running session with `session/set_config_option`
 * (`configId: 'model'`), and a process started on a chat whose session reports another model (one
 * loaded with `session/load` reports the model it was created with) is switched the same way before
 * its first turn. With `'none'` the model cannot be changed in a running chat.
 *
 * Sign-in. A login the agent rejects is reported as one `auth_required` item and the turn ends cleanly,
 * with the process killed so none runs on the old login: an error answer for `authenticate`,
 * `session/new`, `session/load` or `session/prompt` (see `acpAuth.ts`), or a turn whose whole answer is
 * the flavor's sign-in sentence. A refusal while the chat is being started is held until the first
 * message, which starts a new process and tries again.
 *
 * Stop. `session/cancel`; if the agent has not ended the turn within a grace period the process is
 * killed (the next message resumes the session in a new one). `dispose` kills the whole tree and
 * resolves once it is gone.
 */
import { randomUUID } from 'node:crypto'
import type {
  ChatAdapter,
  ChatAdapterEmit,
  ChatAdapterEvent,
  ChatAdapterStartOptions,
  ChatItem,
  ModelOption
} from '../../../../shared/agents/chat'
import type { AgentView } from '../../../../shared/desktop/api'
import { planCliLaunch, type AgentProbeDeps, type ProcessRunner } from '../../../desktop/agentProbe'
import { inspectExecutable, runProcess } from '../../../desktop/agentProbeNode'
import type { ChatAdapterDefinition } from '../../adapterRegistry'
import { withFolder, type AgentLaunchSpec } from '../../launchSpec'
import type { TransportFactory } from '../acpClient'
import { nodeTransport } from '../acpProcess'
import { isAuthRequired } from './acpAuth'
import { AcpSession, type SessionFlavor } from './acpSession'

/** Everything the adapter needs from the outside, so tests can run it against recordings. */
export interface AcpDeps extends Pick<AgentProbeDeps, 'platform' | 'inspect' | 'comspec'> {
  transport: TransportFactory
  /** Runs the flavor's own commands, such as the one that lists its models. */
  run: ProcessRunner
  newId(): string
  now(): string
  timers: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
  /** How long the agent may take to end a cancelled turn before its process is killed. */
  cancelGraceMs: number
  clientVersion: string
}

/** What sets one ACP agent apart from another. */
export interface AcpFlavor extends SessionFlavor {
  readonly kind: AgentView['kind']
  /** The arguments that start the executable as an ACP server on `model` (null: the agent's own choice); throws for a model it cannot be started with. */
  launchArgs(model: string | null): readonly string[]
  /** The models the agent offers, without a chat. */
  listModels(executablePath: string, deps: AcpDeps): Promise<ModelOption[]>
  /**
   * `relaunch`: a new model takes effect by starting the process again on it and loading the session;
   * `config_option`: by `session/set_config_option` in the running session; `none`: it cannot be changed.
   */
  switchModel: 'relaunch' | 'config_option' | 'none'
  /** True when a turn's whole answer is the sentence the agent gives instead of an error once its login went stale. */
  isSignInPrompt?(text: string): boolean
}

type ResetReason = Extract<ChatItem, { kind: 'context_reset' }>['reason']

interface Turn {
  /** Stop was requested. */
  stopped: boolean
  /** The session the prompt went to; null until the process is ready. */
  session: AcpSession | null
  timer: unknown
}

class AcpAdapter implements ChatAdapter {
  readonly kind: AgentView['kind']
  private options: ChatAdapterStartOptions | null = null
  private emitter: ChatAdapterEmit | null = null
  private session: AcpSession | null = null
  /** The model the chat wants; the process runs `runningModel` until the next turn. */
  private model: string | null = null
  private runningModel: string | null = null
  private sessionId: string | null = null
  private turn: Turn | null = null
  /** What the running turn has put in the transcript so far. */
  private turnItems: ChatItem[] = []
  private disposed = false
  private readonly stopFailures: ReadonlyMap<string, string>

  constructor(
    private readonly flavor: AcpFlavor,
    private readonly executablePath: string,
    private readonly deps: AcpDeps,
    /** The launch spec's arguments, before `{folder}` is replaced; they go before the flavor's own. */
    private readonly specArgs: readonly string[]
  ) {
    this.kind = flavor.kind
    const name = flavor.displayName
    this.stopFailures = new Map([
      ['max_tokens', `${name} stopped because the answer reached its length limit.`],
      ['max_turn_requests', `${name} stopped because it took too many steps in one turn.`],
      ['refusal', `${name} declined to continue with this request.`]
    ])
  }

  async start(options: ChatAdapterStartOptions, emit: ChatAdapterEmit): Promise<void> {
    this.options = options
    this.emitter = emit
    this.model = options.model
    this.sessionId = options.sessionId
    try {
      await this.connect(options, 'session_lost')
    } catch (error) {
      // A login the agent refuses is reported by the first message, which tries again; the process is already gone.
      if (!isAuthRequired(error)) {
        throw error
      }
    }
  }

  async send(text: string): Promise<void> {
    const options = this.options
    if (options === null) {
      throw new Error(`This ${this.flavor.displayName} chat has not started.`)
    }
    if (this.disposed) {
      throw new Error(`This ${this.flavor.displayName} chat has ended.`)
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
    if (this.flavor.switchModel === 'none') {
      return Promise.reject(new Error(`${this.flavor.displayName} cannot switch models in a running chat.`))
    }
    try {
      // Refused now, not on the next turn: an id the process cannot be started with never becomes the chat's model.
      this.flavor.launchArgs(model)
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
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
    return this.flavor.listModels(this.executablePath, this.deps)
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

  /** The running turn: an ACP agent works only inside a prompt turn, and its subagents are calls of that turn. */
  hasLiveWork(): boolean {
    return !this.disposed && this.turn !== null
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
    if (only?.kind === 'assistant_text' && more.length === 0 && this.flavor.isSignInPrompt?.(only.text) === true) {
      this.reportSignedOut(only.text.trim())
    }
  }

  /** One `auth_required` item, and the process is killed so the next message starts one that reads the new login. */
  private reportSignedOut(message: string): void {
    this.emit({ type: 'item', item: { id: this.deps.newId(), at: this.deps.now(), kind: 'auth_required', agent: this.kind, message } })
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
    const failure = this.stopFailures.get(reason)
    if (failure !== undefined) {
      throw new Error(failure)
    }
  }

  /** The live process, restarted first when it ended or when the chat's model changed since it started. */
  private async readySession(options: ChatAdapterStartOptions): Promise<AcpSession> {
    const current = this.session
    if (current !== null && !current.isClosed()) {
      if (this.runningModel === this.model) {
        return current
      }
      if (this.flavor.switchModel === 'config_option' && this.model !== null) {
        await current.switchModel(this.model)
        this.runningModel = this.model
        return current
      }
    }
    const reason: ResetReason = current !== null && this.runningModel !== this.model ? 'model_change' : 'session_lost'
    void current?.kill()
    return this.connect(options, reason)
  }

  /** Starts the agent and opens the session: the stored one if it can be loaded, else a new one. */
  private async connect(options: ChatAdapterStartOptions, reason: ResetReason): Promise<AcpSession> {
    // Every process, one started again after a crash or for a model change included, starts only in a folder that is still the chat's.
    options.checkFolder()
    const args = [...withFolder(this.specArgs, options.folder), ...this.flavor.launchArgs(this.model)]
    const plan = planCliLaunch(this.executablePath, args, this.deps)
    if ('ok' in plan) {
      throw new Error(plan.reason)
    }
    const session = new AcpSession(this.flavor, this.deps, plan.launch, {
      folder: options.folder,
      server: options.darkMechanicus,
      instructions: options.instructions,
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
      const model = this.model
      if (this.flavor.switchModel === 'config_option' && model !== null && session.currentModel() !== model) {
        await session.switchModel(model)
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
      message: `${this.flavor.displayName} could not resume the earlier session (${why}), so this chat continues in a new one without its history.`
    }
  }
}

export function createAcpAdapter(flavor: AcpFlavor, executablePath: string, deps: AcpDeps, specArgs: readonly string[] = []): ChatAdapter {
  return new AcpAdapter(flavor, executablePath, deps, specArgs)
}

function nodeDeps(): AcpDeps {
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
        clearTimeout(handle as NodeJS.Timeout)
      }
    },
    cancelGraceMs: 10_000,
    clientVersion: process.env.npm_package_version ?? 'dev'
  }
}

/**
 * An ACP agent's chats start on the first message: an ACP agent has nothing to show before one is sent.
 * `flavorFor` picks the flavor for the agent the spec is for.
 */
export function acpAdapterDefinition(flavorFor: (spec: AgentLaunchSpec) => AcpFlavor): ChatAdapterDefinition {
  return {
    startOnOpen: false,
    create: (spec) => createAcpAdapter(flavorFor(spec), spec.executablePath, nodeDeps(), spec.args),
    listModels: (spec) => flavorFor(spec).listModels(spec.executablePath, nodeDeps())
  }
}
