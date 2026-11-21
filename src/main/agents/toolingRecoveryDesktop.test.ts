import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import type { ChatRecord } from '../../shared/agents/chat'
import type { NamingOperationContext } from '../naming/controlPipe'
import { RECOVERY_DATA_NOTE } from '../../../resources/skitarii/extension/contextDelivery'
import { createChatStore } from './chatStore'
import { createConversationDeliveries } from './conversationDeliveries'
import { createAgentContextDelivery } from './agentContextDelivery'
import { createDesktopToolingRecovery, type DesktopToolingRecovery } from './toolingRecoveryDesktop'
import { builtInAgent } from './__mocks__/chatFixtures'

const harnesses: Harness[] = []
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup() })
const diagnostic = { command: 'get_ticket', code: 'internal_error', message: 'Non-sensitive fixture failure', reproduction: 'Read fixture ticket', expected: 'Return fixture packet' }
function context(chat: ChatRecord, generation = 'fixture-start'): NamingOperationContext {
  return { binding: { grantId: 'gr_fixture', folder: chat.folder, chatId: chat.id, generation, ...(chat.cardId === undefined ? {} : { cardId: chat.cardId }), signal: new AbortController().signal, assertCurrent() {}, assertRecovery() {} }, signal: new AbortController().signal, deadline: Infinity, remainingMs: () => 1000, assertActive() {}, publish: action => action() }
}

describe('connected desktop recovery with durable workspaces and host receipts', () => {
  it.each([false, true])('delivers bug once and bidirectional peer context while blocked (projectless=%s), without mailbox/grant transfer', async projectless => {
    const source = createHarness(); const customer = createHarness(); harnesses.push(source, customer)
    const sourceWs = source.open('desktop'); const customerWs = customer.open('desktop')
    await sourceWs.initializeRepository({ name: 'Dark Mechanicus source fixture' }); await customerWs.initializeRepository({ name: 'Customer fixture' })
    const userData = join(source.root, 'userData')
    const store = createChatStore({ root: join(userData, 'agents', 'chats') })
    const caller = store.createChat({ folder: projectless ? null : customer.root, agent: 'omp', model: null, role: 'orchestrator', allowSave: false, title: 'Unfinished original work' })
    const ledger = createConversationDeliveries({ userData, onChanged() {} })
    const delivery = createAgentContextDelivery({ userData, deliveries: ledger, agentKind: () => 'omp' })
    const live = new Set([caller.id])
    let entry = 0
    const persist = (chat: ChatRecord, content: string, attribution: 'user' | 'agent'): void => {
      const sessions = join(userData, 'agents', 'omp', chat.id, 'sessions'); mkdirSync(sessions, { recursive: true })
      appendFileSync(join(sessions, '2026-11-21T00-00-00-000Z_01234567-89ab-4cde-8123-456789abcdef.jsonl'), JSON.stringify({ type: 'message', id: `fixture-entry-${++entry}`, message: { role: 'user', attribution, content } }) + '\n')
    }
    let desktop: DesktopToolingRecovery
    const start = vi.fn(async (chat: ChatRecord, options: { kickoff: string }) => {
      desktop.assertLaunch(chat)
      persist(chat, options.kickoff, 'user'); store.updateChat(chat, { firstPromptDelivery: 'submitted', kickoffSent: true }); live.add(chat.id)
      return { state: 'running' as const, pid: 123 }
    })
    desktop = createDesktopToolingRecovery({ userData, version: () => '1.0.0',
      source: { requireAvailable: () => ({ path: source.root, target: { kind: 'darkmechanicus_source', projectId: sourceWs.ctx().projectId, projectName: 'Source fixture' } }) },
      store, agents: { get: () => builtInAgent('omp') },
      workspace: folder => folder === source.root ? sourceWs : customerWs,
      resolveFolder: folder => folder === source.root || folder === customer.root ? folder : null,
      callerFolders: chat => chat.folder === null ? [source.root, customer.root] : [chat.folder],
      context: delivery, deliveries: ledger,
      terminals: { start, isRunning: id => live.has(id), paste: vi.fn() },
      resume: async chat => {
        const received = await desktop.dispatch({ op: 'recovery_context', args: { chatId: chat.id, generation: 'fixture-start' } }, context(chat)) as { messages: { id: string; text: string }[] }
        if (received.messages.length > 0) persist(chat, `${RECOVERY_DATA_NOTE}\n${JSON.stringify(received)}`, 'agent')
        return null
      }
    })
    let originalGrantRevoked = false
    const originalContext = context(caller)
    originalContext.binding.assertCurrent = () => { if (originalGrantRevoked) throw new Error('Old caller generation is revoked') }
    const result = await desktop.dispatch({ op: 'recover_tooling', args: { action: 'escalate', incidentId: 'fixture', diagnostic } }, originalContext) as { incidentId: string; repairChatId: string; cardId: string; connection: string }
    expect(result.connection).toBe('connected')
    const repair = store.getChat({ folder: source.root, id: result.repairChatId })!
    expect(repair).toMatchObject({ role: 'orchestrator', allowSave: false, cardId: result.cardId })
    expect((await sourceWs.getKanbanCard({ cardId: result.cardId })).playPending).toBe(true)
    expect((await customerWs.listKanbanCards({})).lanes.backlog).toHaveLength(0)
    expect(store.getChat(caller)?.endpointId).toBeUndefined()
    const sent = async (chat: ChatRecord, messageId: string, text: string) => desktop.dispatch({ op: 'recover_tooling', args: { action: 'message', incidentId: result.incidentId, messageId, text } }, context(chat))
    expect(await sent(repair, 'question', 'Which ticket failed?')).toMatchObject({ blocked: true, messageDelivery: 'delivered' })
    expect(await sent(caller, 'answer', 'The non-sensitive fixture.')).toMatchObject({ blocked: true, messageDelivery: 'delivered' })
    originalGrantRevoked = true
    await desktop.dispatch({ op: 'recover_tooling', args: { action: 'escalate', incidentId: 'fixture', diagnostic } }, context(caller, 'fixture-restarted'))
    expect(start).toHaveBeenCalledTimes(1)
    expect(await sent(caller, 'after-restart', 'Still connected after authenticated replay.')).toMatchObject({ messageDelivery: 'delivered' })
    expect(() => desktop.dispatch({ op: 'recovery_context', args: { chatId: repair.id, generation: 'fixture-start' } }, context(caller))).toThrow('authority is not usable')
  })

  it('isolates corrupt optional recovery state instead of preventing desktop construction or creating duplicates', async () => {
    const h = createHarness(); harnesses.push(h)
    const folder = join(h.root, 'agents'); mkdirSync(folder)
    writeFileSync(join(folder, 'tooling-recovery.json'), 'corrupt fixture')
    const desktop = createDesktopToolingRecovery({ userData: h.root } as never)
    expect(() => desktop.dispatch({ op: 'recover_tooling', args: { action: 'status', incidentId: 'fixture' } }, {} as NamingOperationContext)).toThrow('not available')
  })
})
