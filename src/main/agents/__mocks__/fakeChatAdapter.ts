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
import type { AgentKind } from '../../../shared/desktop/api'
import type { ChatAdapterDefinition, ChatAdapterDefinitions } from '../adapterRegistry'
import { createChatStore, type ChatStore, type ChatStoreFs } from '../chatStore'

export const REPO = resolve('/work/repo')
export const AT = '2026-01-01T00:00:00.000Z'
export const MODELS: ModelOption[] = [
  { id: 'big', label: 'Big' },
  { id: 'small', label: 'Small' }
]

/** A turn script: what the agent does with one message; the turn ends when it settles. */
type Turn = (adapter: FakeChatAdapter, text: string) => Promise<void>

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
  private emitter: ChatAdapterEmit | null = null
  private interrupt: (() => void) | null = null

  constructor(
    readonly kind: AgentKind,
    readonly executablePath: string
  ) {}

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
  /** The adapters created for one kind. */
  of(kind: AgentKind): FakeChatAdapter[]
  /** Applied to each new adapter before it is handed out. */
  prepare: (adapter: FakeChatAdapter) => void
}

/** Claude and Codex definitions (Codex starts on open); Cursor has no adapter. */
export function fakeAdapters(): FakeAdapters {
  const fakes: FakeAdapters = {
    definitions: {},
    created: [],
    of: (kind) => fakes.created.filter((adapter) => adapter.kind === kind),
    prepare: () => {}
  }
  const define = (kind: AgentKind, startOnOpen: boolean): ChatAdapterDefinition => ({
    startOnOpen,
    create: (executablePath) => {
      const adapter = new FakeChatAdapter(kind, executablePath)
      fakes.prepare(adapter)
      fakes.created.push(adapter)
      return adapter
    },
    listModels: (executablePath) => Promise.resolve([...MODELS, { id: executablePath, label: kind }])
  })
  fakes.definitions = { claude: define('claude', false), codex: define('codex', true) }
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
