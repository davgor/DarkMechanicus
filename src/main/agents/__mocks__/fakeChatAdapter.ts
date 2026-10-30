/**
 * Test doubles for the chat session manager: a scriptable fake adapter, adapter definitions that
 * record every adapter they create, and an in-memory chat store. Not shipped.
 */
import { resolve } from 'node:path'
import type {
  ApprovalCategory,
  ApprovalDecision,
  ChatAdapter,
  ChatAdapterEmit,
  ChatAdapterEvent,
  ChatAdapterStartOptions,
  ModelOption
} from '../../../shared/agents/chat'
import { AGENT_DEFINITIONS } from '../../../shared/desktop/agentKinds'
import type { AgentId, AgentProtocol, AgentView, BuiltInAgentKind } from '../../../shared/desktop/api'
import type { ChatAdapterDefinition, ChatAdapterDefinitions } from '../adapterRegistry'
import { createChatStore, type ChatStore, type ChatStoreFs } from '../chatStore'
import type { LaunchFolderDeps } from '../launchFolder'

export const REPO = resolve('/work/repo')
export const AT = '2026-01-01T00:00:00.000Z'
export const MODELS: ModelOption[] = [
  { id: 'big', label: 'Big' },
  { id: 'small', label: 'Small' }
]

/** A turn script: what the agent does with one message; the turn ends when it settles. */
type Turn = (adapter: FakeChatAdapter, text: string) => Promise<void>

/** The built-in kind each protocol's adapter stands for. */
const KIND_BY_PROTOCOL: Readonly<Record<AgentProtocol, BuiltInAgentKind>> = { claude: 'claude', codex: 'codex', acp: 'cursor' }
const PROTOCOL_BY_KIND: Readonly<Record<BuiltInAgentKind, AgentProtocol>> = { claude: 'claude', codex: 'codex', cursor: 'acp', autonomous: 'acp' }

/** A connected built-in agent as the registry lists it, at `/bin/<kind>`. */
export function builtInAgent(kind: BuiltInAgentKind, overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: kind,
    kind,
    protocol: PROTOCOL_BY_KIND[kind],
    displayName: AGENT_DEFINITIONS[kind].displayName,
    executablePath: `/bin/${kind}`,
    args: [],
    version: '1.0.0',
    connectedVia: 'found',
    connectedAt: AT,
    lastProbed: AT,
    ...overrides
  }
}

/** The session manager's `agentFor`: the listed agents are connected, anything else is not. */
export function connectedAgents(agents: readonly AgentView[] = [builtInAgent('claude'), builtInAgent('codex'), builtInAgent('cursor')]): (id: AgentId) => AgentView | null {
  return (id) => agents.find((agent) => agent.id === id) ?? null
}

/** The session manager's `folders`: the listed folders exist, are directories and are tracked at their own path; nothing touches the disk. */
export function trackedFolders(folders: readonly string[] = [REPO]): LaunchFolderDeps {
  const present = new Set(folders)
  return {
    trackedFolder: (path) => (present.has(path) ? path : null),
    fs: {
      realpath: (path) => {
        if (!present.has(path)) {
          throw new Error(`ENOENT: ${path}`)
        }
        return path
      },
      isDirectory: (path) => present.has(path)
    }
  }
}

export class FakeChatAdapter implements ChatAdapter {
  readonly started: ChatAdapterStartOptions[] = []
  readonly sent: string[] = []
  readonly modelChanges: string[] = []
  stops = 0
  disposals = 0
  /** What the next turns do; by default a turn ends at once. */
  turn: Turn = () => Promise.resolve()
  /** Makes start() fail with this error. */
  startError: Error | null = null
  /** What `hasLiveWork` reports: a tool call or a background subagent of the fake agent is still going. */
  liveWork = false
  private emitter: ChatAdapterEmit | null = null
  private interrupt: (() => void) | null = null

  readonly kind: BuiltInAgentKind

  constructor(
    readonly protocol: AgentProtocol,
    readonly executablePath: string
  ) {
    this.kind = KIND_BY_PROTOCOL[protocol]
  }

  start(options: ChatAdapterStartOptions, emit: ChatAdapterEmit): Promise<void> {
    this.started.push(options)
    this.emitter = emit
    return this.startError === null ? Promise.resolve() : Promise.reject(this.startError)
  }

  send(text: string): Promise<void> {
    this.sent.push(text)
    return this.turn(this, text)
  }

  setModel(model: string): Promise<void> {
    this.modelChanges.push(model)
    return Promise.resolve()
  }

  stop(): Promise<void> {
    this.stops += 1
    this.release()
    return Promise.resolve()
  }

  listModels(): Promise<ModelOption[]> {
    return Promise.resolve(MODELS)
  }

  dispose(): Promise<void> {
    this.disposals += 1
    this.release()
    return Promise.resolve()
  }

  hasLiveWork(): boolean {
    return this.liveWork
  }

  emit(event: ChatAdapterEvent): void {
    if (this.emitter === null) {
      throw new Error('The fake adapter was not started.')
    }
    this.emitter(event)
  }

  /** Raises an approval request and waits for the decision, like a vendor blocked on permission. */
  ask(requestId: string, category: ApprovalCategory = 'command', tool = 'Bash'): Promise<ApprovalDecision> {
    return new Promise((respond) => {
      const request = { id: `item_${requestId}`, at: AT, kind: 'approval_request', requestId, category, tool, summary: `Use ${tool}` } as const
      this.emit({ type: 'approval_request', request, respond })
    })
  }

  /** Resolves when stop() or dispose() interrupts the turn. */
  untilStopped(): Promise<void> {
    return new Promise((resolve) => {
      this.interrupt = resolve
    })
  }

  private release(): void {
    this.interrupt?.()
    this.interrupt = null
  }
}

export interface FakeAdapters {
  definitions: ChatAdapterDefinitions
  /** Every adapter created, in order. */
  created: FakeChatAdapter[]
  /** The adapters created for one protocol. */
  of(protocol: AgentProtocol): FakeChatAdapter[]
  /** Applied to each new adapter before it is handed out. */
  prepare: (adapter: FakeChatAdapter) => void
}

/** A definition for every protocol (Codex starts on open); each records the adapters it creates. */
export function fakeAdapters(): FakeAdapters {
  const created: FakeChatAdapter[] = []
  const define = (protocol: AgentProtocol, startOnOpen: boolean): ChatAdapterDefinition => ({
    startOnOpen,
    create: (spec) => {
      const adapter = new FakeChatAdapter(protocol, spec.executablePath)
      fakes.prepare(adapter)
      created.push(adapter)
      return adapter
    },
    listModels: (spec) => Promise.resolve([...MODELS, { id: spec.executablePath, label: protocol }])
  })
  const fakes: FakeAdapters = {
    definitions: { claude: define('claude', false), codex: define('codex', true), acp: define('acp', false) },
    created,
    of: (protocol) => created.filter((adapter) => adapter.protocol === protocol),
    prepare: () => {}
  }
  return fakes
}

/** The in-memory filesystem, with its files open for tests to inspect. */
export interface MemoryChatFs extends ChatStoreFs {
  files: Map<string, string>
}

/** An in-memory filesystem holding `folders`, shared by stores to stand for an app restart. */
export function memoryChatFs(folders: readonly string[] = [REPO]): MemoryChatFs {
  const files = new Map<string, string>()
  const dirs = new Set(folders)
  return {
    files,
    removeFile(path) {
      files.delete(path)
    },
    replaceFile(path, data) {
      files.set(path, data)
    },
    readFile(path) {
      const data = files.get(path)
      if (data === undefined) {
        throw new Error(`ENOENT: ${path}`)
      }
      return data
    },
    appendFile(path, data) {
      files.set(path, (files.get(path) ?? '') + data)
    },
    mkdirp() {},
    realpath(path) {
      const resolved = resolve(path)
      if (!dirs.has(resolved)) {
        throw new Error(`ENOENT: ${path}`)
      }
      return resolved
    }
  }
}

let chatCount = 0

/** A chat store over `fs` with deterministic, increasing timestamps. */
export function memoryChatStore(fs: ChatStoreFs = memoryChatFs()): ChatStore {
  let tick = 0
  return createChatStore({
    root: resolve('/state/agents/chats'),
    fs,
    now: () => {
      tick += 1
      return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
    },
    newId: () => {
      chatCount += 1
      return `chat_${chatCount}`
    }
  })
}
