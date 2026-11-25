import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { DomainError } from '../../core/errors'
import { GUI_PROTOCOL_KINDS, type AgentChatEvent, type AgentChatSnapshot, type PendingPrompt } from '../../shared/agents/agentChat'
import type { ChatRecord, DarkMechanicusCli } from '../../shared/agents/chat'
import type { AgentView } from '../../shared/desktop/api'
import { SIGNED_OUT_PAUSE_REASON } from '../../shared/domain/status'
import { reachTargets, type ReachTarget } from '../agents/chatReach'
import type { ChatRef, ChatStore } from '../agents/chatStore'
import { resolveLaunchFolder } from '../agents/launchFolder'
import { ensureScratchFolder } from '../agents/scratchFolder'
import { claudeSessionExists } from '../terminals/claudeSession'
import { writeClaudeSettings } from '../terminals/claudeSettingsFile'
import { ompSessionId, writeOmpFiles } from '../terminals/ompSession'
import { writeTerminalFiles, type TerminalFiles } from '../terminals/terminalFiles'
import type { TerminalSessionsDeps } from '../terminals/terminalSessions'
import { agentChatLaunch, type AgentChatLaunchSpec } from './agentChatLaunch'
import { startAgentProcess, type AgentProcess, type AgentProcessExit } from './agentProcess'
import { claudeInitLines, createClaudeProtocolState, encodeClaudeCommand, translateClaudeLine, type ClaudeProtocolState } from './claudeProtocol'
import { createOmpState, encodeOmpCommand, initLines, translateOmpLine, type OmpEvent, type OmpState } from './ompProtocol'
import { PendingPrompts, type ArbiterOutcome } from './pendingPrompts'
import { maskAgentChatSecretsDeep as mask } from './secretMask'

export interface AgentChatSessionsDeps extends Pick<TerminalSessionsDeps,
  'agentFor' | 'folders' | 'checkAuth' | 'cliFor' | 'runs' | 'issueChatCli' | 'issueReachCli' |
  'reachFolders' | 'revokeChatGrant' | 'renewChatGrant' | 'keepAwake' | 'userData' |
  'ompExtension' | 'platform' | 'env' | 'newSessionId' | 'bindChatGrant' | 'onChatChanged'> {
  store: Pick<ChatStore, 'getChat' | 'updateChat' | 'appendItems' | 'readTranscript' | 'deleteChat'>
  terminalLive(ref: ChatRef): boolean
  /** The live terminal owner's generation; null when no PTY runs. */
  terminalOwner(ref: ChatRef): string | null
  /** Stops only that owner generation and waits for process close, tree cleanup and grant revocation. */
  stopTerminal(ref: ChatRef, generation: string): Promise<void>
  push(event: AgentChatEvent): void
  timers?: { repeat(callback: () => void, ms: number): () => void }
  now?: () => string
  startProcess?: typeof startAgentProcess
  arbitrate?: (input: { ref: ChatRef; chat: ChatRecord; agent: AgentView; prompt: PendingPrompt }) => { result: Promise<ArbiterOutcome>; cancel(): void }
}

type ConfirmTerminalStop = (chat: ChatRecord) => Promise<boolean>
type StartResult = AgentChatSnapshot | { code: 'busy_elsewhere' }
export interface AgentChatSessions {
  start(ref: ChatRef, options?: { firstMessage?: string }): Promise<StartResult>
  send(ref: ChatRef, input: { text: string }): Promise<void>
  interrupt(ref: ChatRef): Promise<void>
  answer(ref: ChatRef, input: { promptId: string; optionId: string; text?: string }): Promise<void>
  snapshot(ref: ChatRef): AgentChatSnapshot
  /**
   * A live terminal switches to the GUI only after `confirmTerminalStop` (Main-only, per call) resolves true for the
   * same owner generation; omitted, it refuses `busy`. Nothing renderer-supplied can stand in for it.
   */
  setSurface(ref: ChatRef, surface: 'gui' | 'terminal', confirmTerminalStop?: ConfirmTerminalStop): Promise<AgentChatSnapshot>
  stop(ref: ChatRef): Promise<void>
  deleteChat(ref: ChatRef): Promise<void>
  isLive(ref: ChatRef): boolean
  busy(): boolean
  dispose(): Promise<void>
}
interface Entry {
  chat: ChatRecord
  status: AgentChatSnapshot['status']
  prompts?: PendingPrompts
  todos: Map<string | null, AgentChatSnapshot['todos'][number]['phases']>
  queued: number
  turnActive: boolean
  interruptTimer?: NodeJS.Timeout
  interruptFailure?: string
  process?: AgentProcess
  protocol: 'claude' | 'omp'
  claude: ClaudeProtocolState
  omp: OmpState
  grantIds: string[]
  release?: () => void
  cancelled: boolean
  cancel(): void
  cancellation: Promise<never>
  ready: Promise<void>
  admit(): void
  rejectReady(error: unknown): void
  closed: Promise<void>
  completeClose(): void
  rejectClose(error: unknown): void
  revoking?: Promise<void>
  transportStopped?: Promise<void>
  cleanup?: Promise<void>
  cleanupComplete?: boolean
  stopResult?: Promise<void>
  starting?: Promise<StartResult>
  ending?: Promise<void>
}

function startsMainTurn(event: OmpEvent): boolean {
  if (event.type !== 'item' || event.item.threadId) return false
  return event.item.kind === 'assistant_text' || event.item.kind === 'tool_call' && event.item.status === 'running'
}

const repeat = (callback: () => void, ms: number): (() => void) => {
  const timer = setInterval(callback, ms)
  timer.unref()
  return () => clearInterval(timer)
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

function newEntry(chat: ChatRecord, previous?: Entry): Entry {
  // The repository's ES library predates Promise.withResolvers.
  let cancel!: () => void, admit!: () => void, rejectReady!: (error: unknown) => void
  let completeClose!: () => void, rejectClose!: (error: unknown) => void
  const cancellation = new Promise<never>((_, reject) => { cancel = () => reject(new Error('The chat start was cancelled.')) })
  const ready = new Promise<void>((resolve, reject) => { admit = resolve; rejectReady = reject })
  const closed = new Promise<void>((resolve, reject) => { completeClose = resolve; rejectClose = reject })
  for (const pending of [cancellation, ready, closed]) void pending.catch(() => undefined)
  return { chat, status: 'starting', queued: 0, turnActive: false, todos: previous?.todos ?? new Map(), protocol: 'claude',
    claude: createClaudeProtocolState(), omp: createOmpState(`${randomUUID()}:`), grantIds: [], cancelled: false,
    cancellation, cancel, ready, admit, rejectReady, closed, completeClose, rejectClose }
}

/** A missing close is a failure, not proof that the process or its authority was cleaned up. */
async function boundedShutdown(work: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Agent shutdown did not complete within 5 seconds.')), 5000)
  })
  try { await Promise.race([work, deadline]) } finally { clearTimeout(timer) }
}

class SessionManager {
  private readonly entries = new Map<string, Entry>()
  private readonly startingEntries = new Map<string, Entry>()
  private readonly cleanup = new Set<Promise<unknown>>()
  private readonly deleting = new Set<string>()
  private readonly switching = new Set<string>()
  /** Surface requests awaiting confirmation: refuses duplicates without reserving either owner. */
  private readonly confirming = new Set<string>()
  private closing = false
  private disposing?: Promise<void>

  constructor(private readonly deps: AgentChatSessionsDeps) {}

  private now(): string { return this.deps.now?.() ?? new Date().toISOString() }
  private step<T>(entry: Entry, work: Promise<T>): Promise<T> { return Promise.race([work, entry.cancellation]) }

  private chatFor(ref: ChatRef): ChatRecord {
    const chat = this.deps.store.getChat(ref)
    if (!chat) throw new DomainError('not_found', 'The chat no longer exists.')
    return chat
  }
  private update(entry: Entry, patch: Parameters<ChatStore['updateChat']>[1]): void {
    entry.chat = this.deps.store.updateChat(entry.chat, mask(patch))
    this.deps.onChatChanged?.(entry.chat)
  }
  private emit(entry: Entry, event: OmpEvent): void {
    if (event.type === 'pending') return // The registry publishes only the FIFO head.
    const safe = mask(event)
    if (safe.type === 'item') this.deps.store.appendItems(entry.chat, [safe.item])
    if (safe.type === 'status') {
      entry.status = safe.status
      if (safe.status === 'busy' && entry.protocol === 'omp') entry.turnActive = true
      if (safe.status === 'idle') {
        entry.turnActive = false
        this.clearInterrupt(entry)
      }
    }
    if (safe.type === 'queued') entry.queued = safe.count
    if (safe.type === 'todos') {
      if (safe.phases.length) entry.todos.set(safe.threadId, safe.phases)
      else entry.todos.delete(safe.threadId)
    }
    this.deps.push(mask({ ...safe, folder: entry.chat.folder, chatId: entry.chat.id }))
  }
  snapshot(ref: ChatRef): AgentChatSnapshot {
    const chat = this.chatFor(ref), entry = this.entries.get(chat.id)
    return mask({ items: this.deps.store.readTranscript(chat)?.items ?? [], status: entry?.status ?? 'exited',
      pending: entry?.prompts ? entry.prompts.snapshot() : null, queued: entry ? entry.queued : 0, surface: chat.surface ?? 'terminal',
      todos: entry ? [...entry.todos].map(([threadId, phases]) => ({ threadId, phases })) : [] })
  }
  private heldPrompts(entry: Entry): PendingPrompt[] {
    return entry.protocol === 'claude' ? [...entry.claude.pending.values()].map(held => held.prompt) : entry.omp.pending.map(held => held.prompt)
  }
  private clearPrompts(entry: Entry): void {
    entry.claude.pending.clear()
    entry.omp.pending = []
    entry.prompts?.clear()
  }
  private tracked<T>(work: Promise<T>): Promise<T> {
    this.cleanup.add(work)
    void work.then(() => this.cleanup.delete(work), () => this.cleanup.delete(work))
    return work
  }
  private revoke(ids: readonly string[]): Promise<void> {
    return this.tracked(Promise.all(ids.map(id => this.deps.revokeChatGrant(id))).then(() => undefined))
  }
  private folder(chat: ChatRecord): string {
    return chat.folder === null ? ensureScratchFolder(this.deps.userData, chat.id) : resolveLaunchFolder({ folder: chat.folder }, this.deps.folders)
  }
  private assertOpen(chat: ChatRecord): void {
    if (this.closing || this.deleting.has(chat.id)) throw new Error('The chat is stopping.')
    if (this.switching.has(chat.id)) throw new DomainError('busy', 'The chat is switching surfaces.')
  }
  private assertCurrent(entry: Entry): void {
    this.assertOpen(entry.chat)
    if (entry.cancelled) throw new Error('The chat start was cancelled.')
    this.folder(entry.chat)
    if (this.deps.terminalLive(entry.chat)) throw new Error('The chat is running in a terminal.')
  }
  private async pauseRun(folder: string, runId: string): Promise<void> {
    const run = await this.deps.runs.getRun(folder, runId)
    if (run?.state === 'running' || run?.state === 'paused') {
      await this.deps.runs.pauseRun(folder, { runId, reason: SIGNED_OUT_PAUSE_REASON })
    }
  }
  private async pauseIfSignedOut(entry: Entry): Promise<void> {
    const chat = entry.chat
    if (this.closing || entry.cancelled || chat.runId === undefined || chat.folder === null) return
    const agent = this.deps.agentFor(chat.agent)
    if (!agent || agent.kind === 'custom') return
    const auth = await this.deps.checkAuth(agent.kind, agent.executablePath)
    if (!this.closing && auth.state === 'signed_out') await this.pauseRun(chat.folder, chat.runId)
  }
  private revokeEntry(entry: Entry): Promise<void> {
    entry.revoking ??= this.revoke(entry.grantIds.splice(0))
    return entry.revoking
  }
  private cleanupEntry(entry: Entry): Promise<void> {
    if (entry.cleanup) return entry.cleanup
    const child = entry.process
    const revoke = this.revokeEntry(entry)
    // Defer invocation so even a synchronous close callback sees the installed composite barrier.
    entry.transportStopped = Promise.resolve().then(() => child?.stop())
    if (!child) void revoke.then(entry.completeClose, entry.rejectClose)
    entry.cleanup = Promise.all([entry.transportStopped, entry.closed, revoke]).then(() => {
      entry.cleanupComplete = true
      entry.process = undefined
    })
    return entry.cleanup
  }
  private awaitCleanup(entry: Entry): Promise<void> {
    if (entry.cleanupComplete) return entry.cleanup!
    entry.stopResult ??= boundedShutdown(this.cleanupEntry(entry)).catch(error => {
      this.clearPrompts(entry)
      this.emit(entry, { type: 'status', status: 'failed', detail: message(error) })
      throw error
    })
    return entry.stopResult
  }
  private ended(entry: Entry, exit: AgentProcessExit): Promise<void> {
    if (entry.ending) return entry.ending
    this.clearInterrupt(entry)
    this.clearPrompts(entry)
    entry.release?.()
    entry.release = undefined
    entry.admit()
    entry.ending = (async () => {
      await this.revokeEntry(entry)
      const detail = Buffer.from(mask(exit.stderr)).subarray(-2048).toString('utf8')
      if (entry.queued) this.emit(entry, { type: 'queued', count: 0 })
      this.emit(entry, { type: 'status', status: entry.interruptFailure ? 'failed' : exit.code === 0 || entry.cancelled ? 'exited' : 'failed',
        ...(entry.interruptFailure ? { detail: entry.interruptFailure } : detail ? { detail } : {}) })
    })()
    void entry.ending.then(entry.completeClose, entry.rejectClose)
    // Natural close can precede the transport's retained process-tree cleanup.
    void this.awaitCleanup(entry).catch(() => undefined)
    // Auth may require user/network time; it must never hold process shutdown open.
    void entry.ending.then(() => this.pauseIfSignedOut(entry)).catch(() => undefined)
    return entry.ending
  }
  private stopEntry(entry: Entry): Promise<void> {
    this.clearInterrupt(entry)
    entry.cancelled = true
    entry.cancel()
    this.clearPrompts(entry)
    entry.release?.()
    entry.release = undefined
    return this.awaitCleanup(entry)
  }
  private write(entry: Entry, lines: readonly string[]): void {
    for (const line of lines) if (!entry.process?.write(line)) throw new Error('The agent exited before accepting input.')
  }
  private ompLine(entry: Entry, raw: string): void {
    const result = translateOmpLine(raw, entry.omp, this.now())
    entry.omp = result.state
    for (const event of result.events) this.emit(entry, event)
    entry.prompts?.update(this.heldPrompts(entry))
    let frame: unknown
    try { frame = JSON.parse(raw) } catch { return }
    const init = initLines(frame, entry.omp, randomUUID)
    entry.omp = init.state
    this.write(entry, init.lines)
    if (entry.omp.initialized) entry.admit()
  }
  private consumeClaudeQueue(entry: Entry, events: OmpEvent[], mainStarted: boolean): void {
    if (entry.turnActive || entry.queued === 0) return
    // A valid terminal result can be the only evidence of an output-free queued turn.
    const ended = events.some(event => event.type === 'status' && event.status === 'idle')
    if (!mainStarted && !ended) return
    entry.turnActive = true
    // The CLI's explicit result count already describes the queue after this turn.
    if (!events.some(event => event.type === 'queued')) this.emit(entry, { type: 'queued', count: entry.queued - 1 })
    if (!ended) this.emit(entry, { type: 'status', status: 'busy' })
  }
  private claudeLine(entry: Entry, raw: string): void {
    const result = translateClaudeLine(raw, entry.claude, this.now())
    const mainStarted = result.state.activeMessages.get(null) !== entry.claude.activeMessages.get(null)
      || result.events.some(startsMainTurn)
    entry.claude = result.state
    this.consumeClaudeQueue(entry, result.events, mainStarted)
    for (const event of result.events) this.emit(entry, event)
    entry.prompts?.update(this.heldPrompts(entry))
    if (entry.claude.initialized) entry.admit()
    else if (result.events.some(event => event.type === 'status' && event.status === 'failed')) {
      entry.rejectReady(new Error('The agent rejected protocol initialization.'))
    }
  }
  private line(entry: Entry, raw: string): void {
    if (entry.cancelled || entry.ending) return
    try {
      if (entry.protocol === 'omp') this.ompLine(entry, raw)
      else this.claudeLine(entry, raw)
      const state = entry.protocol === 'omp' ? entry.omp : entry.claude
      if (state.sessionId && state.sessionId !== entry.chat.sessionId) this.update(entry, { sessionId: state.sessionId, sessionStarted: true })
      // Internal translator events contain authority. They never enter emit/store/IPC.
    } catch (error) {
      this.emit(entry, { type: 'status', status: 'failed', detail: message(error) })
      void this.stopEntry(entry).catch(() => undefined) // stopEntry publishes a failed shutdown.
    }
  }
  private watch(entry: Entry): void {
    const every = this.deps.timers?.repeat ?? repeat
    const release = this.deps.keepAwake?.() ?? (() => undefined)
    const stopFolder = every(() => {
      try { this.folder(entry.chat) } catch (error) {
        this.emit(entry, { type: 'status', status: 'failed', detail: message(error) })
        void this.stopEntry(entry).catch(() => undefined) // stopEntry publishes a failed shutdown.
      }
    }, 60_000)
    const stopRenew = every(() => {
      void this.tracked(Promise.all(entry.grantIds.map(id => this.deps.renewChatGrant(id))))
    }, 3_600_000)
    entry.release = () => { stopFolder(); stopRenew(); release() }
  }
  private async startFiles(entry: Entry, cwd: string, reach: ReachTarget[] | undefined): Promise<TerminalFiles> {
    const { chat } = entry, { deps } = this
    const cli = deps.cliFor(chat.folder)
    const paths = await this.step(entry, writeTerminalFiles({ userData: deps.userData, chatId: chat.id, platform: deps.platform,
      folder: cwd, cli, role: chat.role, allowSave: chat.allowSave, orchestratesRun: chat.runId !== undefined,
      nameFirstPrompt: chat.titleStatus === 'pending', skitariiMail: false,
      transferEpicId: chat.transferEpicId, cardId: chat.cardId, conversation: chat.conversation, reach }))
    if (entry.protocol === 'claude') return { ...paths, claudeSettings: await this.step(entry, writeClaudeSettings({
      userData: deps.userData, chatId: chat.id, platform: deps.platform, folder: cwd, cli, home: homedir(), tmp: tmpdir(),
      ...(reach === undefined ? {} : { projectless: true as const }) })) }
    return { ...paths, omp: { ...await this.step(entry, writeOmpFiles(deps.userData, chat.id, false)), extension: deps.ompExtension } }
  }
  private async issue(entry: Entry, agent: AgentView, cwd: string, reach: ReachTarget[] | undefined) {
    const { chat } = entry, { deps } = this
    const grant = { role: chat.role, allowSave: chat.allowSave, label: `${agent.displayName} · ${chat.title}`.slice(0, 120) }
    const identity = { id: chat.id, agent: chat.agent, title: chat.title, kind: agent.kind }
    const issuing = reach === undefined
      ? deps.issueChatCli(cwd, grant, identity).then(value => ({ cli: value.cli, grantIds: [value.grantId] }))
      : reach.length ? deps.issueReachCli(reach, grant) : Promise.resolve({ cli: deps.cliFor(null), grantIds: [] })
    return this.step(entry, issuing.then(async value => {
      if (entry.cancelled || this.closing) { await this.revoke(value.grantIds); throw new Error('The chat start was cancelled.') }
      entry.grantIds = value.grantIds
      return value
    }))
  }
  private launch(entry: Entry, input: {
    agent: AgentView; cwd: string; reach: ReachTarget[] | undefined
    paths: TerminalFiles; grant: DarkMechanicusCli; firstMessage?: string
  }): AgentChatLaunchSpec {
    const { agent, cwd, reach, paths, grant, firstMessage } = input
    const { chat } = entry, { deps } = this
    const found = paths.omp ? ompSessionId(paths.omp.sessionDir) : null
    const sessionStarted = agent.kind === 'omp' ? found !== null : chat.sessionId !== null && claudeSessionExists({ env: deps.env, platform: deps.platform, folder: cwd, sessionId: chat.sessionId })
    return agentChatLaunch({ chat: { ...chat, sessionId: found ?? chat.sessionId, sessionStarted, kickoffSent: chat.kickoffSent === true },
      agent, folder: cwd, grant, paths, platform: deps.platform, env: deps.env,
      newSessionId: deps.newSessionId ?? randomUUID, kickoff: firstMessage ?? null, reach })
  }
  private spawn(entry: Entry, spec: AgentChatLaunchSpec): void {
    entry.todos.clear()
    const child = (this.deps.startProcess ?? startAgentProcess)(spec)
    entry.process = child
    child.onLine(raw => this.line(entry, raw))
    child.onExit(exit => { void this.ended(entry, exit) })
    this.watch(entry)
    if (entry.protocol === 'claude') {
      const init = claudeInitLines(entry.claude, randomUUID())
      entry.claude = init.state
      this.write(entry, init.lines)
    }
  }
  private firstTurn(entry: Entry, firstMessage?: string): void {
    const { chat } = entry
    if (chat.kickoffSent || chat.firstPromptDelivery === 'uncertain' || chat.firstPromptDelivery === 'submitted') return
    const text = firstMessage ?? chat.firstPrompt
    if (text === undefined) return
    if (chat.firstPrompt !== undefined) this.update(entry, { firstPromptDelivery: 'uncertain' })
    this.writeTurn(entry, text)
    this.update(entry, { kickoffSent: true, ...(chat.firstPrompt === undefined ? {} : { firstPromptDelivery: 'submitted' }) })
  }
  private writeTurn(entry: Entry, text: string): void {
    const queued = entry.turnActive || entry.queued > 0
    const encoded = entry.protocol === 'claude'
      ? encodeClaudeCommand({ type: 'send', text, uuid: randomUUID() }, entry.claude, this.now())
      : encodeOmpCommand({ type: 'send', text, id: randomUUID() }, entry.omp, this.now())
    if (!encoded.lines.length) throw new Error('The agent did not initialize its input protocol.')
    this.write(entry, encoded.lines)
    if (entry.protocol === 'claude') entry.claude = encoded.state as ClaudeProtocolState
    else entry.omp = encoded.state as OmpState
    if (!queued) entry.turnActive = true
    for (const event of encoded.events) this.emit(entry, event)
    if (entry.protocol === 'claude' && queued) this.emit(entry, { type: 'queued', count: entry.queued + 1 })
    if (entry.status !== 'busy') this.emit(entry, { type: 'status', status: 'busy' })
  }
  private async bind(entry: Entry): Promise<void> {
    const { chat } = entry, generation = randomUUID()
    for (const id of entry.grantIds) await this.step(entry, Promise.resolve(this.deps.bindChatGrant?.(id, {
      folder: chat.folder, chatId: chat.id, generation, runId: chat.runId, cardId: chat.cardId
    })))
  }
  private async runStart(entry: Entry, firstMessage?: string): Promise<StartResult> {
    const { chat } = entry, { deps } = this
    const agent = deps.agentFor(chat.agent)
    if (!agent || (agent.kind !== 'claude' && agent.kind !== 'omp')) throw new Error('This chat has no GUI-capable agent.')
    entry.protocol = agent.kind
    entry.prompts = new PendingPrompts({
      publish: prompt => deps.push(mask({ type: 'pending', folder: chat.folder, chatId: chat.id, prompt })),
      ...(deps.arbitrate ? { arbitrate: prompt => deps.arbitrate!({ ref: { folder: chat.folder, id: chat.id }, chat: entry.chat, agent, prompt }) } : {}),
      answer: (prompt, verdict) => this.answerEntry(entry, { promptId: prompt.id, optionId: verdict.decision }, { decidedBy: 'magos', reason: verdict.reason })
    })
    const auth = await this.step(entry, deps.checkAuth(agent.kind, agent.executablePath))
    if (auth.state === 'signed_out') {
      this.emit(entry, { type: 'status', status: 'signed_out', detail: auth.reason })
      return this.snapshot(chat)
    }
    this.assertCurrent(entry)
    const cwd = this.folder(chat)
    const reach = chat.folder === null ? reachTargets(cwd, deps.reachFolders()) : undefined
    const paths = await this.startFiles(entry, cwd, reach)
    this.assertCurrent(entry)
    const issued = await this.issue(entry, agent, cwd, reach)
    this.assertCurrent(entry)
    const spec = this.launch(entry, { agent, cwd, reach, paths, grant: issued.cli, firstMessage })
    this.update(entry, { grantIds: issued.grantIds, sessionId: spec.sessionId })
    this.assertCurrent(entry)
    this.spawn(entry, spec)
    await this.bind(entry)
    await this.step(entry, entry.ready)
    this.assertCurrent(entry)
    if (entry.ending) await entry.ending
    else this.firstTurn(entry, firstMessage)
    return this.snapshot(chat)
  }
  async start(ref: ChatRef, options: { firstMessage?: string } = {}): Promise<StartResult> {
    const chat = this.chatFor(ref)
    this.assertGuiCapable(chat)
    if (this.deps.terminalLive(chat)) return { code: 'busy_elsewhere' }
    this.assertOpen(chat)
    const reserved = this.startingEntries.get(chat.id)
    if (reserved?.starting) return reserved.starting
    const previous = this.entries.get(chat.id)
    if (previous?.process && !previous.ending && !previous.cancelled) return this.snapshot(chat)
    const entry = newEntry(chat, previous)
    this.startingEntries.set(chat.id, entry)
    // Reserve before yielding or publishing, but retain the old owner until its cleanup completes.
    entry.starting = this.beginStart(entry, previous, options.firstMessage).finally(() => {
      this.startingEntries.delete(chat.id)
      entry.starting = undefined
    })
    this.emit(entry, { type: 'status', status: 'starting' })
    return entry.starting
  }
  private async beginStart(entry: Entry, previous: Entry | undefined, firstMessage?: string): Promise<StartResult> {
    // Ensure start() installs the shared promise before auth, callbacks or notifications can re-enter.
    await Promise.resolve()
    try {
      if (previous?.cleanup) await this.step(entry, this.awaitCleanup(previous))
      this.assertCurrent(entry)
      entry.chat = this.chatFor(entry.chat)
      this.entries.set(entry.chat.id, entry)
      return await this.runStart(entry, firstMessage)
    } catch (error) {
      await this.stopEntry(entry)
      this.emit(entry, { type: 'status', status: 'failed', detail: message(error) })
      return { ...this.snapshot(entry.chat), status: 'failed' }
    }
  }
  async send(ref: ChatRef, input: { text: string }): Promise<void> {
    const result = await this.start(ref)
    if ('code' in result) throw new Error('The chat is running in a terminal.')
    const entry = this.entries.get(this.chatFor(ref).id)
    if (!entry?.process || entry.ending || entry.cancelled) throw new Error('The agent is not running.')
    this.assertCurrent(entry)
    this.writeTurn(entry, input.text)
  }
  async answer(ref: ChatRef, input: { promptId: string; optionId: string; text?: string }): Promise<void> {
    const entry = this.entries.get(this.chatFor(ref).id)
    if (!entry) throw new DomainError('stale_prompt', 'This prompt is no longer pending.')
    // Renderer callers cannot supply decision provenance.
    this.answerEntry(entry, input, { decidedBy: 'person' })
  }
  private answerEntry(entry: Entry, input: { promptId: string; optionId: string; text?: string },
    provenance: { decidedBy: 'person' } | { decidedBy: 'magos'; reason: string }): void {
    if (!entry.process || entry.cancelled || entry.ending || !entry.prompts || this.entries.get(entry.chat.id) !== entry)
      throw new DomainError('stale_prompt', 'This prompt is no longer pending.')
    this.assertCurrent(entry)
    entry.prompts.answer(input.promptId, () => {
      const encoded = entry.protocol === 'claude'
        ? encodeClaudeCommand({ type: 'answer', ...input }, entry.claude, this.now())
        : encodeOmpCommand({ type: 'answer', id: randomUUID(), ...input }, entry.omp, this.now())
      if (!encoded.events.some(event => event.type === 'item' && event.item.kind === 'approval_decision'))
        throw new DomainError('invalid_input', 'Choose an offered option and provide a valid answer.')
      this.write(entry, encoded.lines)
      if (entry.protocol === 'claude') entry.claude = encoded.state as ClaudeProtocolState
      else entry.omp = encoded.state as OmpState
      for (const event of encoded.events) {
        if (event.type === 'item' && event.item.kind === 'approval_decision') {
          this.emit(entry, { ...event, item: { ...event.item, ...provenance } })
        } else this.emit(entry, event)
      }
      return this.heldPrompts(entry)
    })
  }
  private clearInterrupt(entry: Entry): void {
    clearTimeout(entry.interruptTimer)
    entry.interruptTimer = undefined
  }
  async interrupt(ref: ChatRef): Promise<void> {
    const chat = this.chatFor(ref)
    this.assertOpen(chat)
    const entry = this.entries.get(chat.id)
    if (!entry?.process || entry.cancelled || entry.ending || !entry.turnActive || entry.interruptTimer) return
    this.assertCurrent(entry)
    const encoded = entry.protocol === 'claude'
      ? encodeClaudeCommand({ type: 'interrupt', requestId: randomUUID() }, entry.claude, this.now())
      : encodeOmpCommand({ type: 'interrupt', id: randomUUID() }, entry.omp, this.now())
    this.write(entry, encoded.lines)
    if (entry.protocol === 'claude') entry.claude = encoded.state as ClaudeProtocolState
    else entry.omp = encoded.state as OmpState
    entry.interruptTimer = setTimeout(() => {
      entry.interruptFailure = 'The agent did not end its turn within 5 seconds of interrupt.'
      this.emit(entry, { type: 'status', status: 'failed', detail: entry.interruptFailure })
      // Escalate this retained owner, then join the unchanged close/revocation/transport barrier.
      void entry.process?.stop({ force: true }).catch(() => undefined)
      void this.stopEntry(entry).catch(() => undefined)
    }, 5000)
    entry.interruptTimer.unref()
  }
  private guiBusy(chat: ChatRecord): boolean {
    if (this.startingEntries.has(chat.id)) return true
    const entry = this.entries.get(chat.id)
    if (!entry || entry.cleanupComplete) return false
    return entry.turnActive || entry.queued > 0 || Boolean(entry.prompts?.snapshot())
  }
  /**
   * Forge setup keeps the terminal's setup-action gate, no-new-session rule and checkout verification; tooling repair
   * keeps the terminal's live-caller handoff and repair-checkout verification.
   */
  private assertGuiCapable(chat: ChatRecord): void {
    if (chat.forgeSetup !== undefined) throw new DomainError('unsupported', 'Forge setup conversations run only in the terminal.')
    if (chat.repairIncidentId !== undefined) throw new DomainError('unsupported', 'Tooling repair conversations run only in the terminal.')
  }
  private assertSurfaceAllowed(chat: ChatRecord, surface: 'gui' | 'terminal'): void {
    this.assertOpen(chat)
    if (this.confirming.has(chat.id)) throw new DomainError('busy', 'A surface switch is already awaiting confirmation.')
    const agent = this.deps.agentFor(chat.agent)
    if (surface === 'gui') this.assertGuiCapable(chat)
    if (surface === 'gui' && !GUI_PROTOCOL_KINDS.some(kind => kind === agent?.kind)) {
      throw new DomainError('unsupported', 'This agent has no GUI protocol.')
    }
    if (this.guiBusy(chat)) throw new DomainError('busy', 'Wait for the current turn and pending prompts before switching surfaces.')
  }
  /** The terminal generation a switch to the GUI must retire; null when no terminal runs or the terminal is the target. Never inferred idle. */
  private terminalGeneration(chat: ChatRecord, surface: 'gui' | 'terminal'): string | null {
    if (surface === 'terminal') return null
    const generation = this.deps.terminalOwner(chat)
    // A starting or still-retiring terminal has no confirmable owner.
    if (generation === null && this.deps.terminalLive(chat)) throw new DomainError('busy', 'The terminal is starting or still stopping.')
    return generation
  }
  /** Holds only a duplicate-request lock while asking; a missing callback, refusal or failure changes nothing. */
  private async confirmStop(chat: ChatRecord, confirm?: ConfirmTerminalStop): Promise<void> {
    if (!confirm) throw new DomainError('busy', 'The terminal is running; stopping it needs explicit confirmation.')
    this.confirming.add(chat.id)
    let confirmed: boolean
    try { confirmed = await confirm(chat) } finally { this.confirming.delete(chat.id) }
    if (confirmed !== true) throw new DomainError('cancelled', 'The terminal was left running.')
  }
  /** An approval names one owner: a replaced, exited or stopping terminal invalidates it. */
  private assertConfirmedOwner(ref: ChatRef, generation: string): void {
    const current = this.chatFor(ref)
    this.assertSurfaceAllowed(current, 'gui')
    if (this.deps.terminalOwner(current) !== generation) {
      throw new DomainError('busy', 'The terminal changed while the switch awaited confirmation; nothing was stopped.')
    }
  }
  /** Retires only the owner being replaced: the GUI process for the terminal, or the confirmed terminal generation. */
  private retireOwner(chat: ChatRecord, surface: 'gui' | 'terminal', generation: string | null): Promise<void> {
    if (surface === 'terminal') return this.stop(chat)
    return generation === null ? Promise.resolve() : this.deps.stopTerminal(chat, generation)
  }
  async setSurface(ref: ChatRef, surface: 'gui' | 'terminal', confirm?: ConfirmTerminalStop): Promise<AgentChatSnapshot> {
    const chat = this.chatFor(ref)
    this.assertSurfaceAllowed(chat, surface)
    if ((chat.surface ?? 'terminal') === surface) return this.snapshot(chat)
    const generation = this.terminalGeneration(chat, surface)
    if (generation !== null) {
      await this.confirmStop(chat, confirm)
      this.assertConfirmedOwner(ref, generation)
    }
    // Reserved synchronously after the final ownership check, through cleanup and persistence.
    this.switching.add(chat.id)
    try {
      await this.retireOwner(chat, surface, generation)
      if (this.closing || this.deleting.has(chat.id)) throw new Error('The chat is stopping.')
      // An earlier owner still fenced by a failed cleanup keeps the terminal live: the GUI must not take over yet.
      if (surface === 'gui' && this.deps.terminalLive(chat)) throw new DomainError('busy', 'An earlier terminal for this chat is still stopping.')
      this.deps.store.updateChat(this.chatFor(ref), { surface })
      this.deps.onChatChanged?.(ref)
      return this.snapshot(ref)
    } finally {
      this.switching.delete(chat.id)
    }
  }
  async stop(ref: ChatRef): Promise<void> {
    const id = this.chatFor(ref).id
    const entries = new Set([this.entries.get(id), this.startingEntries.get(id)])
    const stopping = [...entries].filter((entry): entry is Entry => entry !== undefined)
    await Promise.all(stopping.map(entry => this.stopEntry(entry)))
    await Promise.all(stopping.map(entry => entry.starting))
  }
  async deleteChat(ref: ChatRef): Promise<void> {
    const chat = this.chatFor(ref)
    this.deleting.add(chat.id)
    try { await this.stop(chat); this.deps.store.deleteChat(chat); this.entries.delete(chat.id) }
    finally { this.deleting.delete(chat.id) }
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.closing = true
    const entries = [...new Set([...this.entries.values(), ...this.startingEntries.values()])]
    this.disposing = boundedShutdown((async () => {
      await Promise.all(entries.map(entry => this.stopEntry(entry)))
      await Promise.all(entries.map(entry => entry.starting))
      await Promise.all(this.cleanup)
    })()).catch(error => {
      // A later explicit dispose may observe late cleanup; the failed caller remains rejected.
      this.disposing = undefined
      throw error
    })
    return this.disposing
  }
  isLive(ref: ChatRef): boolean {
    const id = this.chatFor(ref).id
    return this.switching.has(id) || this.startingEntries.has(id) || this.entries.get(id)?.process !== undefined
  }
  busy(): boolean { return this.startingEntries.size > 0 || [...this.entries.values()].some(entry => entry.status === 'busy') }
}

/** Main owns the process and its authority; attaching/detaching has no lifetime effect. */
export function createAgentChatSessions(deps: AgentChatSessionsDeps): AgentChatSessions {
  const manager = new SessionManager(deps)
  return { start: (ref, options) => manager.start(ref, options), snapshot: ref => manager.snapshot(ref),
    send: (ref, input) => manager.send(ref, input), interrupt: ref => manager.interrupt(ref), answer: (ref, input) => manager.answer(ref, input),
    stop: ref => manager.stop(ref), deleteChat: ref => manager.deleteChat(ref), isLive: ref => manager.isLive(ref),
    setSurface: (ref, surface, confirm) => manager.setSurface(ref, surface, confirm),
    busy: () => manager.busy(), dispose: () => manager.dispose() }
}
