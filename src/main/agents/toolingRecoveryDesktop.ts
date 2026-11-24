import { COMMAND_SCHEMAS } from '../../core/commandSchemas'
import type { ProjectWorkspace } from '../desktop/workspaceClient'
import { NamingControlError, type NamingOperation } from '../../shared/agents/chatNaming'
import type { ChatRecord } from '../../shared/agents/chat'
import type { AgentRegistry } from '../desktop/agentRegistry'
import type { SourceCheckouts } from '../desktop/sourceCheckout'
import type { NamingDispatcher, NamingOperationContext } from '../naming/controlPipe'
import type { TerminalSessions } from '../terminals/terminalSessions'
import type { AgentContextDelivery } from './agentContextDelivery'
import type { ConversationDeliveries, ConversationDelivery } from './conversationDeliveries'
import type { ChatStore } from './chatStore'
import { createToolingRecovery } from './toolingRecovery'
import { createRecoveryStore, type RecoveryIncident, type RecoveryStore } from './toolingRecoveryStore'

interface DesktopRecoveryDeps {
  userData: string
  version(): string
  source: Pick<SourceCheckouts, 'requireAvailable'>
  store: ChatStore
  agents: Pick<AgentRegistry, 'get'>
  workspace(folder: string): ProjectWorkspace
  resolveFolder(folder: string): string | null
  onNoticeError?(error: unknown): void
  terminals: Pick<TerminalSessions, 'start' | 'isRunning' | 'activeChats' | 'paste' | 'pasteIfRunning'>
  context: AgentContextDelivery
  deliveries: ConversationDeliveries
  resume(chat: ChatRecord): Promise<string | null>
}
export interface DesktopToolingRecovery { dispatch: NamingDispatcher; poll(folder: string): Promise<void>; assertLaunch(chat: ChatRecord): Promise<string | undefined> }
const REPAIR_NOTICE_PREFIX = 'repair_notice_'
const CALLER_REPLAY_REQUIRED = 'Repair restart needs a live caller handoff; replay the same incident, never create another repair.'
type RecoveryDelivery = ConversationDelivery & { chatId: string; text: string }

class DesktopRecovery implements DesktopToolingRecovery {
  readonly #launchGuards = new Map<string, () => Promise<string>>()
  #incidents?: RecoveryStore
  readonly dispatch: NamingDispatcher

  constructor(private readonly deps: DesktopRecoveryDeps) {
    try { this.dispatch = this.#createDispatch() } catch {
      // Optional recovery corruption must not prevent boot or silently become an empty journal.
      this.dispatch = () => { throw new NamingControlError('operation_unavailable') }
    }
  }
  async assertLaunch(chat: ChatRecord): Promise<string | undefined> {
    if (chat.repairIncidentId === undefined) return
    const guard = this.#launchGuards.get(chat.id)
    if (guard === undefined) throw new Error(CALLER_REPLAY_REQUIRED)
    return guard()
  }
  async poll(folder: string): Promise<void> {
    const failures = await this.#reconcile(folder)
    const projectless = folder === 'projectless' ? undefined : await this.#reconcile('projectless')
    if (failures !== undefined && projectless !== undefined) failures.push(...projectless)
    this.#throwFailures(failures ?? projectless)
  }
  async #reconcile(folder: string, chatId?: string): Promise<unknown[] | undefined> {
    if (folder !== 'projectless' && this.deps.resolveFolder(folder) !== folder) return
    let failures: unknown[] | undefined
    for (const entry of this.#recoveryEntries(folder, chatId)) {
      try { await this.#reconcileEntry(entry) } catch (error) { (failures ??= []).push(error) }
    }
    return failures
  }
  #throwFailures(failures: unknown[] | undefined): void {
    if (failures === undefined) return
    if (failures.length === 1) throw failures[0]
    throw new AggregateError(failures, 'Tooling recovery delivery reconciliation failed.')
  }
  #recoveryEntries(folder: string, chatId?: string): RecoveryDelivery[] {
    return this.deps.deliveries.pending().filter((entry): entry is RecoveryDelivery =>
      entry.source === 'recovery' && entry.folder === folder && entry.chatId !== null &&
      (chatId === undefined || entry.chatId === chatId) && entry.text !== undefined)
  }
  async #reconcileEntry(entry: RecoveryDelivery): Promise<void> {
    const chat = this.deps.store.getChat({ folder: entry.folder === 'projectless' ? null : entry.folder, id: entry.chatId })
    if (chat === null) return
    // Observing an exact receipt needs no authority to restart its stopped recipient.
    const message = { id: entry.messageId, text: entry.text }
    if (this.deps.context.hasRecoveryMessage(chat, message)) { await this.deps.context.queueRecovery(chat, message); return }
    if (entry.messageId.startsWith(REPAIR_NOTICE_PREFIX)) return this.#deliverNotice(chat, entry)
    const problem = this.#restartProblem(chat)
    if (problem !== null) { this.#recordRestartPending(entry, problem); return }
    await this.assertLaunch(chat)
    await this.#resumePending(chat, entry, message.text)
  }
  async #deliverNotice(chat: ChatRecord, entry: RecoveryDelivery): Promise<void> {
    if (this.#liveNotice(entry) && this.deps.terminals.isRunning(chat.id) && this.deps.agents.get(chat.agent)?.kind === 'claude') {
      await this.#pasteRecovery(chat, entry, entry.text, true)
    }
  }
  #liveNotice(entry: RecoveryDelivery): boolean {
    const incident = this.#incidents?.get(entry.messageId.slice(REPAIR_NOTICE_PREFIX.length))
    if (incident?.available !== null || incident.repairChatId === null) return false
    return this.deps.terminals.isRunning(incident.repairChatId)
  }
  async #resumePending(chat: ChatRecord, entry: ConversationDelivery, text: string): Promise<void> {
    const kind = this.deps.agents.get(chat.agent)?.kind
    if (kind === 'omp') await this.deps.resume(chat)
    else if (kind === 'claude') await this.#pasteRecovery(chat, entry, text)
  }
  async #pasteRecovery(chat: ChatRecord, entry: ConversationDelivery, text: string, liveOnly = false): Promise<void> {
    if (entry.inputUncertain) return
    // Persist ambiguity before input; only an exact host receipt permits replay.
    this.deps.deliveries.record({ ...entry, inputUncertain: true, at: new Date().toISOString() })
    if (liveOnly) this.deps.terminals.pasteIfRunning(chat, text)
    else await this.deps.terminals.paste(chat, text)
  }
  #restartProblem(chat: ChatRecord): string | null {
    return chat.repairIncidentId !== undefined && !this.#launchGuards.has(chat.id) ? CALLER_REPLAY_REQUIRED : null
  }
  #recordRestartPending(entry: ConversationDelivery, problem: string): void {
    if (entry.problem !== problem) this.deps.deliveries.record({ ...entry, problem, at: new Date().toISOString() })
  }
  #transportProblem(chat: ChatRecord): string | null {
    const kind = this.deps.agents.get(chat.agent)?.kind
    return kind === 'omp' || kind === 'claude' ? null :
      'This selected host has no verified tooling-recovery context transport. OMP and Claude are supported. The diagnostic is retained; no repair card or chat was created. Choose a supported host explicitly before replaying this incident; no provider/model was substituted.'
  }
  async #createCard(folder: string, input: { title: string; body: string; idempotencyKey: string }): Promise<string> {
    return (await this.deps.workspace(folder).createKanbanCard({ ...input,
      acceptanceCriteria: [
        { text: 'Behavioral regression proves the diagnosed tooling failure is repaired.' },
        { text: 'Required verification and independent review pass; repair is integrated under existing protections.' },
        { text: 'Report deployed runtime availability or the remaining caller blocker without human-only outcome approval.' }
      ], expectedArtifacts: ['Regression tests, implementation, verification and independent review evidence'] })).id
  }
  async #notifyPeers(caller: ChatRecord, repair: ChatRecord, incident: RecoveryIncident): Promise<void> {
    const command = incident.diagnostic.command.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase())
    const symptom = Object.hasOwn(COMMAND_SCHEMAS, command) ? ' in ' + incident.diagnostic.command : ''
    const message = { id: REPAIR_NOTICE_PREFIX + incident.id,
      text: 'Tooling repair status (peer data): a repair agent is already working on a Dark Mechanicus failure' + symptom +
        ' (incident ' + incident.id + '). If you see a similar failure, continue with unaffected work and avoid filing a duplicate.' }
    const results = await Promise.allSettled(this.deps.terminals.activeChats().filter(chat =>
      chat.id !== caller.id && chat.id !== repair.id && !chat.archived &&
      this.#transportProblem(chat) === null).map(async chat => {
        await this.deps.context.queueRecovery(chat, message)
        const entry = this.deps.deliveries.proof(chat.folder ?? 'projectless', chat.id, 'recovery', message.id)
        if (entry?.state === 'pending') await this.#deliverNotice(chat, { ...entry, chatId: chat.id, text: message.text })
      }))
    for (const result of results) if (result.status === 'rejected') this.deps.onNoticeError?.(result.reason)
  }
  async #wake(chat: ChatRecord): Promise<string | null> {
    this.#throwFailures(await this.#reconcile(chat.folder ?? 'projectless', chat.id))
    return this.#restartProblem(chat) ?? this.deps.resume(chat)
  }
  #readContext(operation: Extract<NamingOperation, { op: 'recovery_context' }>, context: NamingOperationContext): { messages: { id: string; text: string }[] } {
    context.assertActive()
    if (operation.args.chatId !== context.binding.chatId || operation.args.generation !== context.binding.generation) throw new NamingControlError('unauthorized')
    const chat = this.deps.store.getChat({ folder: context.binding.folder, id: context.binding.chatId })
    if (chat === null) throw new NamingControlError('not_found')
    return { messages: this.#nextMessage(chat) }
  }
  #nextMessage(chat: ChatRecord): { id: string; text: string }[] {
    const messages = this.#recoveryEntries(chat.folder ?? 'projectless', chat.id)
    // Incident communication takes precedence over advisories.
    const ordered = [...messages.filter(entry => !entry.messageId.startsWith(REPAIR_NOTICE_PREFIX)),
      ...messages.filter(entry => entry.messageId.startsWith(REPAIR_NOTICE_PREFIX))]
    for (const entry of ordered) {
      const message = { id: entry.messageId, text: entry.text }
      if (this.deps.context.hasRecoveryMessage(chat, message)) {
        this.deps.deliveries.record({ ...entry, state: 'delivered', problem: null, at: new Date().toISOString() })
        continue
      }
      if (!entry.messageId.startsWith(REPAIR_NOTICE_PREFIX) || this.#liveNotice(entry)) return [message]
    }
    return []
  }
  #createDispatch(): NamingDispatcher {
    const incidents = createRecoveryStore({ userData: this.deps.userData })
    this.#incidents = incidents
    const recovery = createToolingRecovery({
      source: this.deps.source, store: this.deps.store, incidents, version: this.deps.version,
      transportProblem: chat => this.#transportProblem(chat),
      createCard: (folder, input) => this.#createCard(folder, input),
      play: async (folder, cardId) => { await this.deps.workspace(folder).playKanbanCard({ cardId }) },
      notifyPeers: (caller, repair, incident) => this.#notifyPeers(caller, repair, incident),
      authorizeLaunch: (chat, guard) => { this.#launchGuards.set(chat.id, guard) },
      start: (chat, prompt, guard) => {
        this.#launchGuards.set(chat.id, guard)
        return this.deps.terminals.start(chat, { kickoff: prompt })
      },
      running: chat => this.deps.terminals.isRunning(chat.id),
      delivery: {
        hasInput: (chat, text) => this.deps.context.hasInput(chat, text),
        queue: (chat, message) => this.deps.context.queueRecovery(chat, message),
        received: (chat, message) => this.deps.context.hasRecoveryMessage(chat, message),
        wake: chat => this.#wake(chat)
      }
    })
    return (operation, context) => {
      if (operation.op === 'recovery_context') return this.#readContext(operation, context)
      if (operation.op !== 'recover_tooling') throw new NamingControlError('invalid_request')
      return recovery(operation.args, context)
    }
  }
}

/** Normal terminal startup owns the repair lifecycle; no ad-hoc process or transferable grant. */
export function createDesktopToolingRecovery(deps: DesktopRecoveryDeps): DesktopToolingRecovery {
  return new DesktopRecovery(deps)
}
