import type { CommandName } from '../../../shared/domain/api'
import { deferred } from './deferred'
import { FakeChats } from './fakeChats'
import type { Deferred } from './deferred'
import type { DomainErrorShape } from '../../../shared/domain/errors'
import type { BoardRemovalResultView, BoardRemovalView } from '../../../shared/domain/views'
import type {
  AgentAuthStatus,
  AgentDownloadProgress,
  AgentDownloadResult,
  AgentFindResult,
  AgentKind,
  AgentSignInResult,
  AgentView,
  ClaudeCodeConnectRequest,
  ClaudeCodeConnectResult,
  CommandInput,
  CommandOutput,
  CommandResult,
  DmApi,
  FolderPickResult,
  McpConfigView,
  TrackedFolderView
} from '../../../shared/desktop/api'

interface CommandCall {
  folder: string
  name: CommandName
  input: unknown
}

type PlainMethod =
  | 'listFolders'
  | 'pickFolder'
  | 'untrackFolder'
  | 'getMcpConfig'
  | 'installSkills'
  | 'connectClaudeCode'
  | 'previewBoardRemoval'
  | 'removeBoardFiles'

export const MCP_JSON = '{\n  "mcpServers": {\n    "darkmechanicus": { "command": "dm-mcp" }\n  }\n}'

/**
 * Hand-written window.dm for renderer tests. It records every call and answers commands from
 * canned `responses` (or a `handlers` function), so tests assert on recorded state, not mocks.
 */
export class FakeDm implements DmApi {
  chats = new FakeChats()
  folders: TrackedFolderView[] = []
  pickQueue: FolderPickResult[] = []
  responses: Partial<Record<CommandName, unknown>> = {
    listEpics: [],
    searchHistory: [],
    listBranchEpics: [],
    listProfiles: [],
    previewBoardImport: { open: [], done: [], skipped: [] }
  }
  handlers: Partial<Record<CommandName, (input: unknown, folder: string) => unknown>> = {}
  failures: Partial<Record<CommandName, DomainErrorShape>> = {}
  holds: Partial<Record<CommandName, Deferred[]>> = {}
  rejects: Partial<Record<PlainMethod, string>> = {}
  commandCalls: CommandCall[] = []
  calls: string[] = []
  copied: string[] = []
  skillInstalls: string[] = []
  skillsWritten: string[] = ['.claude/skills/darkmechanicus-planner/SKILL.md']
  claudeConnects: { folder: string; request: ClaudeCodeConnectRequest }[] = []
  /** Answers to connectClaudeCode, in order; once used up, every write is `created`. */
  claudeOutcomes: ClaudeCodeConnectResult[] = []
  /** What previewBoardRemoval answers. */
  boardRemoval: BoardRemovalView = { remove: [], kept: [], editByHand: [] }
  /** What removeBoardFiles answers; by default every confirmed path was removed. */
  boardRemovalResult: BoardRemovalResultView | null = null
  boardRemovals: { folder: string; paths: string[] }[] = []
  /** Makes the next removeBoardFiles call wait until this is resolved. */
  removalHold: Deferred | null = null
  mcpConfig: McpConfigView = {
    command: 'dm-mcp',
    args: ['--repo', '~/code/alpha'],
    env: {},
    json: MCP_JSON,
    note: 'development build'
  }

  listFolders(): Promise<TrackedFolderView[]> {
    return this.answer('listFolders', () => [...this.folders])
  }

  pickFolder(): Promise<FolderPickResult> {
    return this.answer('pickFolder', () => this.pickQueue.shift() ?? { folder: null, added: false })
  }

  untrackFolder(path: string): Promise<TrackedFolderView[]> {
    return this.answer('untrackFolder', () => {
      this.folders = this.folders.filter((folder) => folder.path !== path)
      return [...this.folders]
    })
  }

  getMcpConfig(folder: string): Promise<McpConfigView> {
    this.calls.push(`getMcpConfig:${folder}`)
    return this.answer('getMcpConfig', () => this.mcpConfig)
  }

  installSkills(folder: string): Promise<{ written: string[] }> {
    this.skillInstalls.push(folder)
    return this.answer('installSkills', () => ({ written: this.skillsWritten }))
  }

  connectClaudeCode(folder: string, request: ClaudeCodeConnectRequest): Promise<ClaudeCodeConnectResult> {
    this.claudeConnects.push({ folder, request })
    return this.answer('connectClaudeCode', () => this.claudeOutcomes.shift() ?? { outcome: 'created' })
  }

  previewBoardRemoval(): Promise<BoardRemovalView> {
    return this.answer('previewBoardRemoval', () => this.boardRemoval)
  }

  async removeBoardFiles(folder: string, paths: string[]): Promise<BoardRemovalResultView> {
    this.boardRemovals.push({ folder, paths: [...paths] })
    await this.removalHold?.promise
    return this.answer('removeBoardFiles', () => {
      const { kept, editByHand } = this.boardRemoval
      return this.boardRemovalResult ?? { removed: [...paths], removedFolders: [], kept, editByHand }
    })
  }

  copyText(text: string): Promise<void> {
    this.copied.push(text)
    return Promise.resolve()
  }

  openExternal(): Promise<boolean> {
    return Promise.resolve(true)
  }

  /** Connected agents, as listAgents answers them. */
  agents: AgentView[] = []
  /** Answers to findAgent, in order; once used up the file dialog is closed without a pick. */
  findOutcomes: AgentFindResult[] = []
  /** Answers to downloadAgent, in order; once used up the confirmation is declined. */
  downloadOutcomes: AgentDownloadResult[] = []
  /** What agentStatus answers per kind; an agent with no entry is `unknown`. */
  agentStatuses: Partial<Record<AgentKind, AgentAuthStatus>> = {}
  /** Answers to signInAgent, in order; once used up the sign-in starts. */
  signInOutcomes: AgentSignInResult[] = []
  /** Every agent API call with exactly the arguments it was given, oldest first. */
  agentCalls: { method: string; args: unknown[] }[] = []
  private agentHolds: Partial<Record<string, Deferred[]>> = {}
  private progressListeners = new Set<(progress: AgentDownloadProgress) => void>()

  /** Makes the next call of an agent method (e.g. `downloadAgent`) wait until the returned deferred is resolved. */
  holdAgent(method: string): Deferred {
    const hold = deferred()
    this.agentHolds[method] = [...(this.agentHolds[method] ?? []), hold]
    return hold
  }

  /** Pushes a download progress event to every subscriber, as the main process does mid-download. */
  emitProgress(progress: AgentDownloadProgress): void {
    for (const listener of this.progressListeners) {
      listener(progress)
    }
  }

  get progressSubscribers(): number {
    return this.progressListeners.size
  }

  listAgents(): Promise<AgentView[]> {
    return this.agentCall('listAgents', [], () => [...this.agents])
  }

  findAgent(kind: AgentKind): Promise<AgentFindResult> {
    return this.agentCall('findAgent', [kind], () => this.findOutcomes.shift() ?? { outcome: 'cancelled' })
  }

  removeAgent(kind: AgentKind): Promise<AgentView[]> {
    return this.agentCall('removeAgent', [kind], () => {
      this.agents = this.agents.filter((agent) => agent.kind !== kind)
      return [...this.agents]
    })
  }

  downloadAgent(kind: AgentKind): Promise<AgentDownloadResult> {
    return this.agentCall('downloadAgent', [kind], () => this.downloadOutcomes.shift() ?? { outcome: 'cancelled' })
  }

  onAgentDownloadProgress(listener: (progress: AgentDownloadProgress) => void): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  agentStatus(kind: AgentKind): Promise<AgentAuthStatus> {
    return this.agentCall(
      'agentStatus',
      [kind],
      () => this.agentStatuses[kind] ?? { state: 'unknown', reason: 'Not connected yet.' }
    )
  }

  signInAgent(kind: AgentKind): Promise<AgentSignInResult> {
    return this.agentCall('signInAgent', [kind], () => this.signInOutcomes.shift() ?? { outcome: 'started' })
  }

  /** Calls recorded for one agent method. */
  agentCallsOf(method: string): unknown[][] {
    return this.agentCalls.filter((call) => call.method === method).map((call) => call.args)
  }

  private async agentCall<T>(method: string, args: unknown[], produce: () => T): Promise<T> {
    this.agentCalls.push({ method, args })
    await this.agentHolds[method]?.shift()?.promise
    return produce()
  }

  async command<K extends CommandName>(
    folder: string,
    name: K,
    input: CommandInput<K>
  ): Promise<CommandResult<CommandOutput<K>>> {
    this.commandCalls.push({ folder, name, input })
    await this.holds[name]?.shift()?.promise
    const failure = this.failures[name]
    if (failure) {
      return { ok: false, error: failure }
    }
    const handler = this.handlers[name]
    const data = handler ? handler(input, folder) : this.responses[name]
    return { ok: true, data: data as CommandOutput<K> }
  }

  /** Makes the next call of `name` wait until the returned deferred is resolved. */
  holdNext(name: CommandName): Deferred {
    const hold = deferred()
    this.holds[name] = [...(this.holds[name] ?? []), hold]
    return hold
  }

  callsOf(name: CommandName): CommandCall[] {
    return this.commandCalls.filter((call) => call.name === name)
  }

  private answer<T>(method: PlainMethod, produce: () => T): Promise<T> {
    this.calls.push(method)
    const message = this.rejects[method]
    return message === undefined ? Promise.resolve(produce()) : Promise.reject(new Error(message))
  }
}
