import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { DomainError } from '../../core/errors'
import type { AgentChatEvent, AgentChatSnapshot } from '../../shared/agents/agentChat'
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
import { maskAgentChatSecretsDeep as mask } from './secretMask'

export interface AgentChatSessionsDeps extends Pick<TerminalSessionsDeps,
  'agentFor' | 'folders' | 'checkAuth' | 'cliFor' | 'runs' | 'issueChatCli' | 'issueReachCli' |
  'reachFolders' | 'revokeChatGrant' | 'renewChatGrant' | 'keepAwake' | 'userData' |
  'ompExtension' | 'platform' | 'env' | 'newSessionId' | 'bindChatGrant' | 'onChatChanged'> {
  store: Pick<ChatStore, 'getChat' | 'updateChat' | 'appendItems' | 'readTranscript' | 'deleteChat'>
  terminalLive(ref: ChatRef): boolean
  push(event: AgentChatEvent): void
  timers?: { repeat(callback: () => void, ms: number): () => void }
  now?: () => string
  startProcess?: typeof startAgentProcess
}

type StartResult = AgentChatSnapshot | { code: 'busy_elsewhere' }
export interface AgentChatSessions {
  start(ref: ChatRef, options?: { firstMessage?: string }): Promise<StartResult>
  snapshot(ref: ChatRef): AgentChatSnapshot
  stop(ref: ChatRef): Promise<void>
  deleteChat(ref: ChatRef): Promise<void>
  isLive(ref: ChatRef): boolean
  busy(): boolean
  dispose(): Promise<void>
}
interface Entry {
  chat: ChatRecord
  status: AgentChatSnapshot['status']
  pending: AgentChatSnapshot['pending']
  todos: Map<string | null, AgentChatSnapshot['todos'][number]['phases']>
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
  stopping?: Promise<void>
  starting?: Promise<StartResult>
  ending?: Promise<void>
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
  return { chat, status: 'starting', pending: null, todos: previous?.todos ?? new Map(), protocol: 'claude',
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
    const safe = mask(event)
    if (safe.type === 'item') this.deps.store.appendItems(entry.chat, [safe.item])
    if (safe.type === 'status') entry.status = safe.status
    if (safe.type === 'pending') entry.pending = safe.prompt
    if (safe.type === 'todos') {
      if (safe.phases.length) entry.todos.set(safe.threadId, safe.phases)
      else entry.todos.delete(safe.threadId)
    }
    this.deps.push(mask({ ...safe, folder: entry.chat.folder, chatId: entry.chat.id }))
  }
  snapshot(ref: ChatRef): AgentChatSnapshot {
    const chat = this.chatFor(ref), entry = this.entries.get(chat.id)
    return mask({ items: this.deps.store.readTranscript(chat)?.items ?? [], status: entry?.status ?? 'exited',
      pending: entry?.pending ?? null, queued: 0, surface: chat.surface ?? 'terminal',
      todos: entry ? [...entry.todos].map(([threadId, phases]) => ({ threadId, phases })) : [] })
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
  private completeCleanup(entry: Entry): void {
    entry.completeClose()
    // Existing callers keep their rejected deadline promise; later operations use confirmed cleanup.
    entry.stopping = entry.closed
  }
  private ended(entry: Entry, exit: AgentProcessExit): Promise<void> {
    if (entry.ending) return entry.ending
    entry.release?.()
    entry.release = undefined
    entry.admit()
    entry.ending = (async () => {
      await this.revokeEntry(entry)
      entry.process = undefined
      this.emit(entry, { type: 'pending', prompt: null })
      const detail = Buffer.from(mask(exit.stderr)).subarray(-2048).toString('utf8')
      this.emit(entry, { type: 'status', status: exit.code === 0 || entry.cancelled ? 'exited' : 'failed', ...(detail ? { detail } : {}) })
    })()
    void entry.ending.then(() => this.completeCleanup(entry), entry.rejectClose)
    // Auth may require user/network time; it must never hold process shutdown open.
    void entry.ending.then(() => this.pauseIfSignedOut(entry)).catch(() => undefined)
    return entry.ending
  }
  private stopEntry(entry: Entry): Promise<void> {
    if (entry.stopping) return entry.stopping
    entry.cancelled = true
    entry.cancel()
    entry.release?.()
    entry.release = undefined
    const revoke = this.revokeEntry(entry)
    const work = entry.process
      ? Promise.all([entry.process.stop(), entry.closed, revoke]).then(() => undefined)
      : revoke.then(() => this.completeCleanup(entry))
    entry.stopping = boundedShutdown(work).catch(error => {
      this.emit(entry, { type: 'pending', prompt: null })
      this.emit(entry, { type: 'status', status: 'failed', detail: message(error) })
      throw error
    })
    return entry.stopping
  }
  private write(entry: Entry, lines: readonly string[]): void {
    for (const line of lines) if (!entry.process?.write(line)) throw new Error('The agent exited before accepting input.')
  }
  private ompLine(entry: Entry, raw: string): void {
    const result = translateOmpLine(raw, entry.omp, this.now())
    entry.omp = result.state
    for (const event of result.events) this.emit(entry, event)
    let frame: unknown
    try { frame = JSON.parse(raw) } catch { return }
    const init = initLines(frame, entry.omp, randomUUID)
    entry.omp = init.state
    this.write(entry, init.lines)
    if (entry.omp.initialized) entry.admit()
  }
  private claudeLine(entry: Entry, raw: string): void {
    const result = translateClaudeLine(raw, entry.claude, this.now())
    entry.claude = result.state
    for (const event of result.events) this.emit(entry, event)
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
    this.writeFirstTurn(entry, text)
    this.update(entry, { kickoffSent: true, ...(chat.firstPrompt === undefined ? {} : { firstPromptDelivery: 'submitted' }) })
  }
  private writeFirstTurn(entry: Entry, text: string): void {
    const encoded = entry.protocol === 'claude'
      ? encodeClaudeCommand({ type: 'send', text, uuid: randomUUID() }, entry.claude, this.now())
      : encodeOmpCommand({ type: 'send', text, id: randomUUID() }, entry.omp, this.now())
    if (!encoded.lines.length) throw new Error('The agent did not initialize its input protocol.')
    if (entry.protocol === 'claude') entry.claude = encoded.state as ClaudeProtocolState
    else entry.omp = encoded.state as OmpState
    this.write(entry, encoded.lines)
    for (const event of encoded.events) this.emit(entry, event)
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
      if (previous?.stopping) await this.step(entry, previous.stopping)
      else if (previous?.ending) await this.step(entry, previous.closed)
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
    return this.startingEntries.has(id) || this.entries.get(id)?.process !== undefined
  }
  busy(): boolean { return this.startingEntries.size > 0 || [...this.entries.values()].some(entry => entry.status === 'busy') }
}

/** Main owns the process and its authority; attaching/detaching has no lifetime effect. */
export function createAgentChatSessions(deps: AgentChatSessionsDeps): AgentChatSessions {
  const manager = new SessionManager(deps)
  return { start: (ref, options) => manager.start(ref, options), snapshot: ref => manager.snapshot(ref),
    stop: ref => manager.stop(ref), deleteChat: ref => manager.deleteChat(ref), isLive: ref => manager.isLive(ref),
    busy: () => manager.busy(), dispose: () => manager.dispose() }
}
