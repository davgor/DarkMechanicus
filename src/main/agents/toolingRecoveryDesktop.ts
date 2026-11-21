import type { Workspace } from '../../core/workspace'
import { holdToolingWorkflow, releaseToolingWorkflow } from '../../core/services/toolingHold'
import { NamingControlError } from '../../shared/agents/chatNaming'
import type { ChatRecord } from '../../shared/agents/chat'
import type { AgentRegistry } from '../desktop/agentRegistry'
import type { SourceCheckouts } from '../desktop/sourceCheckout'
import type { NamingDispatcher } from '../naming/controlPipe'
import type { TerminalSessions } from '../terminals/terminalSessions'
import type { AgentContextDelivery } from './agentContextDelivery'
import type { ConversationDeliveries } from './conversationDeliveries'
import type { ChatStore } from './chatStore'
import { createToolingRecovery } from './toolingRecovery'
import { createRecoveryStore } from './toolingRecoveryStore'

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
/** No ad-hoc child process, role switch or transferable grant: normal terminal startup owns the repair lifecycle. */
export function createDesktopToolingRecovery(deps: DesktopRecoveryDeps): DesktopToolingRecovery {
  const launchGuards = new Map<string, () => void>()
  const assertLaunch = (chat: ChatRecord): void => {
    if (chat.repairIncidentId === undefined) return
    const guard = launchGuards.get(chat.id)
    if (guard === undefined) throw new Error('Repair restart needs a live caller handoff; replay the same incident, never create another repair.')
    guard()
  }
  const reconcile = async (folder: string): Promise<void> => {
    if (folder !== 'projectless' && deps.resolveFolder(folder) !== folder) return
    for (const entry of deps.deliveries.pending()) {
      if (entry.source !== 'recovery' || entry.folder !== folder || entry.chatId === null || entry.text === undefined) continue
      const chat = deps.store.getChat({ folder: folder === 'projectless' ? null : folder, id: entry.chatId })
      if (chat === null) continue
      if (chat.repairIncidentId !== undefined) assertLaunch(chat)
      const message = { id: entry.messageId, text: entry.text }
      if (deps.context.hasRecoveryMessage(chat, message)) { await deps.context.queueRecovery(chat, message); continue }
      const kind = deps.agents.get(chat.agent)?.kind
      if (kind === 'omp') {
        await deps.resume(chat)
      } else if (kind === 'claude' && !entry.inputUncertain) {
        // Persist ambiguity before physical input; replay requires an exact host receipt, never a paste return value.
        deps.deliveries.record({ ...entry, inputUncertain: true, at: new Date().toISOString() })
        await deps.terminals.paste(chat, entry.text)
      }
    }
  }
  let dispatch: NamingDispatcher
  try {
    const incidents = createRecoveryStore({ userData: deps.userData })
    const recovery = createToolingRecovery({
      source: deps.source, store: deps.store, incidents, version: deps.version,
      createCard: async (folder, input) => (await deps.workspace(folder).createKanbanCard({ ...input,
        acceptanceCriteria: [
          { text: 'Behavioral regression proves the diagnosed tooling failure is repaired.' },
          { text: 'Required verification and independent review pass; repair is integrated under existing protections.' },
          { text: 'Report deployed runtime availability or the remaining caller blocker without human-only outcome approval.' }
        ], expectedArtifacts: ['Regression tests, implementation, verification and independent review evidence'] })).id,
      play: async (folder, cardId) => { await deps.workspace(folder).playKanbanCard({ cardId }) },
      hold: async (chat, incidentId) => {
        for (const folder of deps.callerFolders(chat)) {
          holdToolingWorkflow(deps.workspace(folder).ctx(), { id: chat.id, incidentId, ...(chat.runId === undefined ? {} : { runId: chat.runId }), ...(chat.cardId === undefined ? {} : { cardId: chat.cardId }) })
        }
      },
      release: async (chat, incidentId) => {
        for (const folder of deps.callerFolders(chat)) releaseToolingWorkflow(deps.workspace(folder).ctx(), { id: chat.id, incidentId })
      },
      authorizeLaunch: (chat, guard) => { launchGuards.set(chat.id, guard) },
      start: (chat, prompt, guard) => {
        launchGuards.set(chat.id, guard)
        return deps.terminals.start(chat, { kickoff: prompt })
      },
      running: chat => deps.terminals.isRunning(chat.id),
      delivery: {
        hasInput: (chat, text) => deps.context.hasInput(chat, text),
        queue: (chat, message) => deps.context.queueRecovery(chat, message),
        received: (chat, message) => deps.context.hasRecoveryMessage(chat, message),
        wake: async chat => {
          await reconcile(chat.folder ?? 'projectless')
          return deps.resume(chat)
        }
      }
    })
    dispatch = (operation, context) => {
      if (operation.op === 'recovery_context') {
        context.assertActive()
        if (operation.args.chatId !== context.binding.chatId || operation.args.generation !== context.binding.generation) throw new NamingControlError('unauthorized')
        const chat = deps.store.getChat({ folder: context.binding.folder, id: context.binding.chatId })
        if (chat === null) throw new NamingControlError('not_found')
        const incidentId = chat.repairIncidentId ?? chat.toolingIncidentId
        if (incidentId == null) return { messages: [] }
        const incident = incidents.get(incidentId)
        if (incident === null) throw new NamingControlError('operation_unavailable')
        const origin = incident.caller.id === chat.id && incident.caller.folder === chat.folder
        const repair = incident.repairChatId === chat.id && incident.sourceFolder === chat.folder
        if (!origin && !repair) throw new NamingControlError('unauthorized')
        const messages = incident.messages.filter(message => message.recipient === (origin ? 'caller' : 'repair') && !deps.context.hasRecoveryMessage(chat, message))
        return { messages: messages.slice(0, 1).map(message => ({ id: message.id, text: message.text })) }
      }
      if (operation.op !== 'recover_tooling') throw new NamingControlError('invalid_request')
      return recovery(operation.args, context)
    }
  } catch {
    // Optional recovery state must not prevent desktop boot or silently become an empty journal.
    dispatch = () => { throw new NamingControlError('operation_unavailable') }
  }
  return { dispatch, assertLaunch, poll: async folder => { await reconcile(folder); await reconcile('projectless') } }
}
