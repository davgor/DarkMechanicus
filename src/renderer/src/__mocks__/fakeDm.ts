import type { TerminalColors } from '../../../shared/agents/terminalColors'
import type { CommandName } from '../../../shared/domain/api'
import { deferred } from './deferred'
import { FakeChats } from './fakeChats'
import { knowledgeStatus } from './fixtures'
import { idleCrossRepoCorrections } from './idleCrossRepoCorrections'
import { idleSourceCheckout } from './idleSourceCheckout'
import { idleTerminals } from './idleTerminals'
import { idleCults } from './idleCults'
import { FakeAgentChat } from './fakeAgentChat'
import { FakeSettings } from './fakeSettings'
import { FakeNotifications } from './fakeNotifications'
import type { Deferred } from './deferred'
import type { DomainErrorShape } from '../../../shared/domain/errors'
import type { BoardRemovalResultView, BoardRemovalView } from '../../../shared/domain/views'
import type {
  AgentAuthStatus,
  AgentDownloadProgress,
  AgentDownloadResult,
  AgentFindResult,
  AgentId,
  AgentView,
  BuiltInAgentKind,
  CustomAgentRequest,
  CustomAgentUpdate,
  ApproveLearningCardRequest,
  ClaudeCodeConnectRequest,
  ClaudeCodeConnectResult,
  CommandInput,
  CommandOutput,
  CommandResult,
  DmApi,
  FolderPickResult,
  KnowledgeChooseResult,
  KnowledgeStatusView,
  McpConfigView,
  TrackedFolderView,
  YoloStatus
} from '../../../shared/desktop/api'
import type { KanbanCardView } from '../../../shared/domain/kanban'

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
  async setTelegramEnabled(_enabled: boolean) {}
  async telegramStatus() { return { enabled: false, configured: false, paired: false, issue: '' } }
  async pairTelegram() { return 'pair-code' }
  chats = new FakeChats()
  cults = idleCults()
  terminals = idleTerminals()
  agentChat = new FakeAgentChat()
  sourceCheckout = idleSourceCheckout()
  crossRepoCorrections = idleCrossRepoCorrections()
  settings = new FakeSettings()
  notifications = new FakeNotifications()
  folders: TrackedFolderView[] = []
  pickQueue: FolderPickResult[] = []
  responses: Partial<Record<CommandName, unknown>> = {
    getProject: {},
    listEpics: [],
    getEventHead: 0,
    getKanbanOpenCount: 0,
    searchHistory: [],
    listBranchEpics: [],
    listProfiles: [],
    previewBoardImport: { open: [], done: [], skipped: [] },
    listKanbanCards: { lanes: { backlog: [], in_progress: [], ready_for_review: [], done: [] }, doneTotal: 0, doneNextCursor: null }
  }
  handlers: Partial<Record<CommandName, (input: unknown, folder: string) => unknown>> = {}
  failures: Partial<Record<CommandName, DomainErrorShape>> = {}
  holds: Partial<Record<CommandName, Deferred[]>> = {}
  rejects: Partial<Record<PlainMethod, string>> = {}
  commandCalls: CommandCall[] = []
  calls: string[] = []
  copied: string[] = []
  openedFolders: Array<{ folder: string; expectedPath?: string }> = []
  openFolderFailure: string | null = null
  openTrackedFolder(folder: string, expectedPath?: string): Promise<CommandResult<null>> {
    this.openedFolders.push({ folder, expectedPath })
    return Promise.resolve(this.openFolderFailure === null ? { ok: true, data: null } : { ok: false, error: { code: 'invalid_input', message: this.openFolderFailure } })
  }

  /** URLs passed to openExternal, oldest first. */
  opened: string[] = []
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
  yoloState: YoloStatus = { live: false, expiresAt: null, audit: [] }
  yoloCalls: { folder: string; grantId: string; action: 'enable' | 'revoke' | 'inspect' }[] = []
  yolo(folder: string, grantId: string, action: 'enable' | 'revoke' | 'inspect'): Promise<YoloStatus> {
    this.yoloCalls.push({ folder, grantId, action })
    if (action === 'revoke') this.yoloState = { ...this.yoloState, expiresAt: null }
    return Promise.resolve(this.yoloState)
  }

  listFolders(): Promise<TrackedFolderView[]> {
    return this.answer('listFolders', () => [...this.folders])
  }

  pickModes: Array<'forge-world' | undefined> = []
  pickFolder(mode?: 'forge-world'): Promise<FolderPickResult> {
    this.pickModes.push(mode)
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

  openExternal(url: string): Promise<boolean> {
    this.opened.push(url)
    return Promise.resolve(true)
  }

  /** Connected agents, as listAgents answers them. */
  agents: AgentView[] = []
  /** Answers to findAgent, in order; once used up the file dialog is closed without a pick. */
  findOutcomes: AgentFindResult[] = []
  /** Answers to downloadAgent, in order; once used up the confirmation is declined. */
  downloadOutcomes: AgentDownloadResult[] = []
  /** What agentStatus answers per agent id; an agent with no entry is `unknown`. */
  agentStatuses: Partial<Record<AgentId, AgentAuthStatus>> = {}
  /** Default agent per folder path, as `setFolderDefaultAgent` leaves it. */
  folderDefaults: Partial<Record<string, AgentId>> = {}
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

  findAgent(kind: BuiltInAgentKind): Promise<AgentFindResult> {
    return this.agentCall('findAgent', [kind], () => this.findOutcomes.shift() ?? { outcome: 'cancelled' })
  }

  removeAgent(id: AgentId): Promise<AgentView[]> {
    return this.agentCall('removeAgent', [id], () => {
      this.agents = this.agents.filter((agent) => agent.id !== id)
      return [...this.agents]
    })
  }

  /** Answers to addCustomAgent and updateCustomAgent, in order; once used up the file dialog is closed without a pick. */
  customOutcomes: AgentFindResult[] = []

  addCustomAgent(request: CustomAgentRequest): Promise<AgentFindResult> {
    return this.agentCall('addCustomAgent', [request], () => this.customOutcomes.shift() ?? { outcome: 'cancelled' })
  }

  updateCustomAgent(request: CustomAgentUpdate): Promise<AgentFindResult> {
    return this.agentCall('updateCustomAgent', [request], () => this.customOutcomes.shift() ?? { outcome: 'cancelled' })
  }

  downloadAgent(kind: BuiltInAgentKind): Promise<AgentDownloadResult> {
    return this.agentCall('downloadAgent', [kind], () => this.downloadOutcomes.shift() ?? { outcome: 'cancelled' })
  }

  onAgentDownloadProgress(listener: (progress: AgentDownloadProgress) => void): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  agentStatus(kind: AgentId): Promise<AgentAuthStatus> {
    return this.agentCall(
      'agentStatus',
      [kind],
      () => this.agentStatuses[kind] ?? { state: 'unknown', reason: 'Not connected yet.' }
    )
  }

  ompTheme: TerminalColors | null = null

  ompTerminalTheme(): Promise<TerminalColors | null> {
    return this.agentCall('ompTerminalTheme', [], () => this.ompTheme)
  }

  folderDefaultAgent(folder: string): Promise<AgentId | null> {
    return this.agentCall('folderDefaultAgent', [folder], () => this.folderDefaults[folder] ?? null)
  }

  setFolderDefaultAgent(request: { folder: string; agentId: AgentId | null }): Promise<AgentId | null> {
    return this.agentCall('setFolderDefaultAgent', [request], () => {
      if (request.agentId === null) {
        delete this.folderDefaults[request.folder]
      } else {
        this.folderDefaults[request.folder] = request.agentId
      }
      return request.agentId
    })
  }

  /** What knowledgeStatus answers; choosing and clearing the overall repository change it as main would. */
  knowledge: KnowledgeStatusView = knowledgeStatus()
  /** Answers to chooseKnowledgeRepository, in order; once used up the picker is cancelled. */
  knowledgeChooseOutcomes: KnowledgeChooseResult[] = []
  /** Every knowledge API call with its arguments, oldest first. */
  knowledgeCalls: { method: string; args: unknown[] }[] = []

  knowledgeStatus(folder: string): Promise<KnowledgeStatusView> {
    this.knowledgeCalls.push({ method: 'knowledgeStatus', args: [folder] })
    return Promise.resolve(structuredClone(this.knowledge))
  }

  chooseKnowledgeRepository(): Promise<KnowledgeChooseResult> {
    this.knowledgeCalls.push({ method: 'chooseKnowledgeRepository', args: [] })
    const outcome = this.knowledgeChooseOutcomes.shift() ?? { outcome: 'cancelled' }
    if (outcome.outcome === 'set') {
      this.knowledge.layers.overall = { ...this.knowledge.layers.overall, configured: true, path: outcome.repository }
    }
    return Promise.resolve(outcome)
  }

  clearKnowledgeRepository(): Promise<void> {
    this.knowledgeCalls.push({ method: 'clearKnowledgeRepository', args: [] })
    this.knowledge.layers.overall = { configured: false, path: null, count: 0 }
    this.knowledge.git = null
    return Promise.resolve()
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

  /** DM-956: recorded like a command; answers through `failures`/`responses` under the `approveKanbanCard` name. */
  approveLearningCard(folder: string, input: ApproveLearningCardRequest): Promise<CommandResult<KanbanCardView>> {
    return this.command(folder, 'approveKanbanCard', { cardId: input.cardId }) as Promise<CommandResult<KanbanCardView>>
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
