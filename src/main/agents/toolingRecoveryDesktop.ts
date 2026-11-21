import type { Workspace } from '../../core/workspace'
import { holdToolingWorkflow, releaseToolingWorkflow } from '../../core/services/toolingHold'
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
  workspace(folder: string): Workspace
  resolveFolder(folder: string): string | null
  callerFolders(chat: ChatRecord): readonly string[]
  terminals: Pick<TerminalSessions, 'start' | 'isRunning' | 'paste'>
  context: AgentContextDelivery
  deliveries: ConversationDeliveries
  resume(chat: ChatRecord): Promise<string | null>
}
export interface DesktopToolingRecovery { dispatch: NamingDispatcher; poll(folder: string): Promise<void>; assertLaunch(chat: ChatRecord): void }
const CALLER_REPLAY_REQUIRED = 'Repair restart needs a live caller handoff; replay the same incident, never create another repair.'
class DesktopRecovery implements DesktopToolingRecovery {
  readonly #launchGuards = new Map<string, () => void>()
  readonly dispatch: NamingDispatcher

  constructor(private readonly deps: DesktopRecoveryDeps) {
    try { this.dispatch = this.#createDispatch() } catch {
      // Optional recovery corruption must not prevent boot or silently become an empty journal.
      this.dispatch = () => { throw new NamingControlError('operation_unavailable') }
    }
  }
  assertLaunch(chat: ChatRecord): void {
    if (chat.repairIncidentId === undefined) return
    const guard = this.#launchGuards.get(chat.id)
    if (guard === undefined) throw new Error(CALLER_REPLAY_REQUIRED)
    guard()
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
    for (const entry of this.deps.deliveries.pending()) {
      if (entry.source !== 'recovery' || entry.folder !== folder || (chatId !== undefined && entry.chatId !== chatId)) continue
      try { await this.#reconcileEntry(entry) } catch (error) { (failures ??= []).push(error) }
    }
    return failures
  }
  #throwFailures(failures: unknown[] | undefined): void {
    if (failures === undefined) return
    if (failures.length === 1) throw failures[0]
    throw new AggregateError(failures, 'Tooling recovery delivery reconciliation failed.')
  }
  async #reconcileEntry(entry: ConversationDelivery): Promise<void> {
    if (entry.chatId === null || entry.text === undefined) return
    const chat = this.deps.store.getChat({ folder: entry.folder === 'projectless' ? null : entry.folder, id: entry.chatId })
    if (chat === null) return
    // Observing an exact receipt needs no authority to restart its stopped recipient.
    const message = { id: entry.messageId, text: entry.text }
    if (this.deps.context.hasRecoveryMessage(chat, message)) { await this.deps.context.queueRecovery(chat, message); return }
    const problem = this.#restartProblem(chat)
    if (problem !== null) { this.#recordRestartPending(entry, problem); return }
    this.assertLaunch(chat)
    const kind = this.deps.agents.get(chat.agent)?.kind
    if (kind === 'omp') await this.deps.resume(chat)
    else if (kind === 'claude' && !entry.inputUncertain) {
      // Persist ambiguity before input; only an exact host receipt permits replay.
      this.deps.deliveries.record({ ...entry, inputUncertain: true, at: new Date().toISOString() })
      await this.deps.terminals.paste(chat, entry.text)
    }
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
      'This selected host has no verified tooling-recovery context transport. OMP and Claude are supported. The diagnostic is retained; no hold, repair card or chat was created. Choose a supported host explicitly before replaying this incident; no provider/model was substituted.'
  }
  async #createCard(folder: string, input: { title: string; body: string; idempotencyKey: string }): Promise<string> {
    return (await this.deps.workspace(folder).createKanbanCard({ ...input,
      acceptanceCriteria: [
        { text: 'Behavioral regression proves the diagnosed tooling failure is repaired.' },
        { text: 'Required verification and independent review pass; repair is integrated under existing protections.' },
        { text: 'Report deployed runtime availability or the remaining caller blocker without human-only outcome approval.' }
      ], expectedArtifacts: ['Regression tests, implementation, verification and independent review evidence'] })).id
  }
  async #hold(chat: ChatRecord, incidentId: string): Promise<void> {
    for (const folder of this.deps.callerFolders(chat)) {
      holdToolingWorkflow(this.deps.workspace(folder).ctx(), { id: chat.id, incidentId,
        ...(chat.runId === undefined ? {} : { runId: chat.runId }), ...(chat.cardId === undefined ? {} : { cardId: chat.cardId }) })
    }
  }
  async #release(chat: ChatRecord, incidentId: string): Promise<void> {
    for (const folder of this.deps.callerFolders(chat)) releaseToolingWorkflow(this.deps.workspace(folder).ctx(), { id: chat.id, incidentId })
  }
  async #wake(chat: ChatRecord): Promise<string | null> {
    this.#throwFailures(await this.#reconcile(chat.folder ?? 'projectless', chat.id))
    return this.#restartProblem(chat) ?? this.deps.resume(chat)
  }
  #contextSide(incident: RecoveryIncident, chat: ChatRecord): 'caller' | 'repair' {
    if (incident.caller.id === chat.id && incident.caller.folder === chat.folder) return 'caller'
    if (incident.repairChatId === chat.id && incident.sourceFolder === chat.folder) return 'repair'
    throw new NamingControlError('unauthorized')
  }
  #readContext(incidents: RecoveryStore, operation: Extract<NamingOperation, { op: 'recovery_context' }>, context: NamingOperationContext): { messages: { id: string; text: string }[] } {
    context.assertActive()
    if (operation.args.chatId !== context.binding.chatId || operation.args.generation !== context.binding.generation) throw new NamingControlError('unauthorized')
    const chat = this.deps.store.getChat({ folder: context.binding.folder, id: context.binding.chatId })
    if (chat === null) throw new NamingControlError('not_found')
    const incidentId = chat.repairIncidentId ?? chat.toolingIncidentId
    if (incidentId == null) return { messages: [] }
    const incident = incidents.get(incidentId)
    if (incident === null) throw new NamingControlError('operation_unavailable')
    const side = this.#contextSide(incident, chat)
    const messages = incident.messages.filter(message => message.recipient === side && !this.deps.context.hasRecoveryMessage(chat, message))
    return { messages: messages.slice(0, 1).map(message => ({ id: message.id, text: message.text })) }
  }
  #createDispatch(): NamingDispatcher {
    const incidents = createRecoveryStore({ userData: this.deps.userData })
    const recovery = createToolingRecovery({
      source: this.deps.source, store: this.deps.store, incidents, version: this.deps.version,
      transportProblem: chat => this.#transportProblem(chat),
      createCard: (folder, input) => this.#createCard(folder, input),
      play: async (folder, cardId) => { await this.deps.workspace(folder).playKanbanCard({ cardId }) },
      hold: (chat, incidentId) => this.#hold(chat, incidentId),
      release: (chat, incidentId) => this.#release(chat, incidentId),
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
      if (operation.op === 'recovery_context') return this.#readContext(incidents, operation, context)
      if (operation.op !== 'recover_tooling') throw new NamingControlError('invalid_request')
      return recovery(operation.args, context)
    }
  }
}

/** Normal terminal startup owns the repair lifecycle; no ad-hoc process or transferable grant. */
export function createDesktopToolingRecovery(deps: DesktopRecoveryDeps): DesktopToolingRecovery {
  return new DesktopRecovery(deps)
}
