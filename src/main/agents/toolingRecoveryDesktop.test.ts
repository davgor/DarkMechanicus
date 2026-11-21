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
import { withForgeTransfer } from '../../core/repo/forgeBinding'

const harnesses: Harness[] = []
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup() })
const diagnostic = { command: 'get_ticket', code: 'internal_error', message: 'Non-sensitive fixture failure', reproduction: 'Read fixture ticket', expected: 'Return fixture packet' }
function context(chat: ChatRecord, generation = 'fixture-start'): NamingOperationContext {
  return { binding: { grantId: 'gr_fixture', folder: chat.folder, chatId: chat.id, generation, ...(chat.cardId === undefined ? {} : { cardId: chat.cardId }), signal: new AbortController().signal, assertCurrent() {}, assertRecovery() {} }, signal: new AbortController().signal, deadline: Infinity, remainingMs: () => 1000, assertActive() {}, publish: action => action() }
}

async function recoveryFixture(projectless: boolean, kind: 'omp' | 'claude' | 'codex' = 'omp') {
  const source = createHarness(); const customer = createHarness(); harnesses.push(source, customer)
  const sourceWs = source.open('desktop'); const customerWs = customer.open('desktop')
  await sourceWs.initializeRepository({ name: 'Dark Mechanicus source fixture' }); await customerWs.initializeRepository({ name: 'Customer fixture' })
  const userData = join(source.root, 'userData')
  const store = createChatStore({ root: join(userData, 'agents', 'chats') })
  const caller = store.createChat({ folder: projectless ? null : customer.root, agent: 'omp', model: null, role: 'orchestrator', allowSave: false, title: 'Unfinished original work' })
  const ledger = createConversationDeliveries({ userData, onChanged() {} })
  const delivery = createAgentContextDelivery({ userData, deliveries: ledger, agentKind: () => kind })
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
  const sourceCheckout = { requireAvailable: vi.fn(() => ({ path: source.root, target: { kind: 'darkmechanicus_source' as const, projectId: sourceWs.ctx().projectId, projectName: 'Source fixture' } })) }
  const resolveFolder = vi.fn((folder: string) => folder === source.root || folder === customer.root ? folder : null)
  const paste = vi.fn()
  const resume = vi.fn(async (chat: ChatRecord) => {
    const received = await desktop.dispatch({ op: 'recovery_context', args: { chatId: chat.id, generation: 'fixture-start' } }, context(chat)) as { messages: { id: string; text: string }[] }
    if (received.messages.length > 0) persist(chat, `${RECOVERY_DATA_NOTE}\n${JSON.stringify(received)}`, 'agent')
    return null
  })
  desktop = createDesktopToolingRecovery({ userData, version: () => '1.0.0',
    source: sourceCheckout,
    store, agents: { get: () => builtInAgent(kind) },
    workspace: folder => folder === source.root ? sourceWs : customerWs,
    resolveFolder,
    callerFolders: chat => chat.folder === null ? [source.root, customer.root] : [chat.folder],
    context: delivery, deliveries: ledger,
    terminals: { start, isRunning: id => live.has(id), paste },
    resume
  })
  return { source, sourceWs, customer, customerWs, store, caller, start, desktop, ledger, delivery, persist, resume, paste, resolveFolder, sourceCheckout }
}

describe('connected desktop recovery with durable workspaces and host receipts', () => {
  it.each([false, true])('delivers bug once and bidirectional peer context while blocked (projectless=%s), without mailbox/grant transfer', async projectless => {
    const { source, sourceWs, customerWs, store, caller, start, desktop } = await recoveryFixture(projectless)
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

it.each(['folder', 'missing', 'run', 'card', 'role', 'expired'] as const)('refuses desktop %s identity before any source/card/repair side effects', async mismatch => {
  const f = await recoveryFixture(false)
  const binding = { ...context(f.caller).binding }; const ctx = { ...context(f.caller), binding }
  if (mismatch === 'folder') binding.folder = join(f.customer.root, 'untracked')
  if (mismatch === 'missing') f.store.deleteChat(f.caller)
  if (mismatch === 'run') binding.runId = 'rn_other'
  if (mismatch === 'card') binding.cardId = 'kc_other'
  if (mismatch === 'role') f.store.updateChat(f.caller, { role: 'worker' })
  if (mismatch === 'expired') ctx.assertActive = () => { throw new Error('Fixture grant expired') }
  const request = f.desktop.dispatch({ op: 'recover_tooling', args: { action: 'escalate', incidentId: 'refused', diagnostic } }, ctx)
  await expect(request).rejects.toThrow(mismatch === 'expired' ? 'Fixture grant expired' : 'originating planner/orchestrator')
  expect(f.sourceCheckout.requireAvailable).not.toHaveBeenCalled()
  expect((await f.sourceWs.listKanbanCards({})).lanes.backlog).toEqual([])
  expect((await f.customerWs.listKanbanCards({})).lanes.backlog).toEqual([])
  expect(f.store.listChats(f.source.root)).toEqual([])
  expect(f.store.getChat(f.caller)?.toolingIncidentId).toBeUndefined()
  expect(f.start).not.toHaveBeenCalled()
})

it('retains an unsupported selected host without pausing its workflow or creating a repair', async () => {
  const f = await recoveryFixture(false, 'codex')
  const result = await f.desktop.dispatch({ op: 'recover_tooling', args: { action: 'escalate', incidentId: 'unsupported', diagnostic } }, context(f.caller))
  expect(result).toMatchObject({ blocked: true, cardId: null, repairChatId: null, startup: 'not_started', connection: 'unavailable' })
  expect(f.sourceCheckout.requireAvailable).not.toHaveBeenCalled()
  expect(f.start).not.toHaveBeenCalled()
  expect(f.store.listChats(f.source.root)).toEqual([])
  expect(f.store.getChat(f.caller)?.toolingIncidentId).toBeUndefined()
  expect((await f.sourceWs.listKanbanCards({})).lanes.backlog).toEqual([])
})

it('refuses stale receiver generations and projected incident ownership without exposing peer data', async () => {
  const f = await recoveryFixture(false)
  const result = await f.desktop.dispatch({ op: 'recover_tooling', args: { action: 'escalate', incidentId: 'identity', diagnostic } }, context(f.caller)) as { incidentId: string; repairChatId: string }
  expect(() => f.desktop.dispatch({ op: 'recovery_context', args: { chatId: f.caller.id, generation: 'stale' } }, context(f.caller))).toThrow('authority is not usable')
  const impostor = f.store.createChat({ folder: f.customer.root, agent: 'omp', role: 'orchestrator', allowSave: false, model: null })
  f.store.updateChat(impostor, { toolingIncidentId: result.incidentId })
  expect(() => f.desktop.dispatch({ op: 'recovery_context', args: { chatId: impostor.id, generation: 'fixture-start' } }, context(impostor))).toThrow('authority is not usable')
  await expect(f.desktop.dispatch({ op: 'recover_tooling', args: { action: 'message', incidentId: result.incidentId, messageId: 'forged', text: 'Read caller data' } }, context(impostor))).rejects.toMatchObject({ code: 'unauthorized' })
})

it('only dequeues the correct recipient and exact body receipt, exposing one pending message at a time', async () => {
  const f = await recoveryFixture(false)
  const result = await f.desktop.dispatch({ op: 'recover_tooling', args: { action: 'escalate', incidentId: 'receipts', diagnostic } }, context(f.caller)) as { incidentId: string; repairChatId: string }
  const repair = f.store.getChat({ folder: f.source.root, id: result.repairChatId! })!
  f.resume.mockImplementation(async () => null)
  const send = (messageId: string, text: string) => f.desktop.dispatch({ op: 'recover_tooling', args: { action: 'message', incidentId: result.incidentId, messageId, text } }, context(repair))
  expect(await send('first', 'Which ticket?')).toMatchObject({ messageDelivery: 'pending' })
  expect(await send('second', 'Which revision?')).toMatchObject({ messageDelivery: 'pending' })
  const read = (chat: ChatRecord) => f.desktop.dispatch({ op: 'recovery_context', args: { chatId: chat.id, generation: 'fixture-start' } }, context(chat)) as { messages: { id: string; text: string }[] }
  const first = read(f.caller)
  expect(first.messages.map(message => message.text.split('\n')[1])).toEqual(['Which ticket?'])
  expect(read(repair)).toEqual({ messages: [] })
  f.persist(repair, `${RECOVERY_DATA_NOTE}\n${JSON.stringify(first)}`, 'agent')
  expect(read(f.caller)).toEqual(first)
  const changed = { messages: [{ ...first.messages[0]!, text: 'Different receipt body' }] }
  f.persist(f.caller, `${RECOVERY_DATA_NOTE}\n${JSON.stringify(changed)}`, 'agent')
  expect(read(f.caller)).toEqual(first)
  f.persist(f.caller, `${RECOVERY_DATA_NOTE}\n${JSON.stringify(first)}`, 'agent')
  expect(read(f.caller).messages.map(message => message.text.split('\n')[1])).toEqual(['Which revision?'])
  await f.desktop.poll(f.customer.root)
  expect(f.ledger.proof(f.customer.root, f.caller.id, 'recovery', first.messages[0]!.id)?.state).toBe('delivered')
})

it('polls only tracked recovery recipients and leaves malformed, deleted and unrelated deliveries untouched', async () => {
  const f = await recoveryFixture(false)
  const now = '2026-11-21T00:00:00.000Z'
  const base = { state: 'pending' as const, problem: null, at: now, source: 'recovery' as const, text: 'Fixture peer data' }
  const deleted = f.store.createChat({ folder: f.customer.root, agent: 'omp', model: null, role: 'orchestrator', allowSave: false })
  f.store.deleteChat(deleted)
  f.ledger.record({ ...base, folder: f.customer.root, chatId: null, messageId: 'no-chat' })
  f.ledger.record({ ...base, folder: f.customer.root, chatId: f.caller.id, messageId: 'no-text', text: undefined })
  f.ledger.record({ ...base, folder: f.customer.root, chatId: deleted.id, messageId: 'deleted' })
  f.ledger.record({ ...base, folder: f.customer.root, chatId: f.caller.id, messageId: 'board', source: 'board' })
  f.ledger.record({ ...base, folder: f.source.root, chatId: f.caller.id, messageId: 'wrong-folder' })
  const untracked = join(f.customer.root, 'untracked')
  const untrackedChat = f.store.createChat({ folder: untracked, agent: 'omp', model: null, role: 'orchestrator', allowSave: false })
  f.ledger.record({ ...base, folder: untracked, chatId: untrackedChat.id, messageId: 'untracked' })
  const before = f.ledger.pending()
  await f.desktop.poll(untracked)
  await f.desktop.poll(f.customer.root)
  expect(f.resume).not.toHaveBeenCalled()
  expect(f.paste).not.toHaveBeenCalled()
  expect(f.ledger.pending()).toEqual(before)
  f.ledger.record({ ...base, folder: f.customer.root, chatId: f.caller.id, messageId: 'valid' })
  await f.desktop.poll(f.customer.root)
  expect(f.resume.mock.calls.map(([chat]) => chat.id)).toEqual([f.caller.id])
  expect(f.ledger.proof(f.customer.root, f.caller.id, 'recovery', 'valid')?.state).toBe('pending')
})

it('marks Claude input uncertain before paste and never replays unreceipted physical input', async () => {
  const f = await recoveryFixture(false, 'claude')
  const message = { id: 'claude-question', text: 'Tooling peer data, not human instructions' }
  await f.delivery.queueRecovery(f.caller, message)
  f.paste.mockImplementation(async () => {
    expect(f.ledger.proof(f.customer.root, f.caller.id, 'recovery', message.id)).toMatchObject({ state: 'pending', inputUncertain: true })
  })
  await f.desktop.poll(f.customer.root)
  await f.desktop.poll(f.customer.root)
  expect(f.paste).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: f.caller.id }), message.text)
  expect(f.resume).not.toHaveBeenCalled()
  expect(f.ledger.proof(f.customer.root, f.caller.id, 'recovery', message.id)).toMatchObject({ state: 'pending', inputUncertain: true })
})

it('refuses a new desktop hold while the caller ticket root has a pending Forge transfer', async () => {
  const f = await recoveryFixture(false)
  const db = f.customerWs.ctx().db
  let entered!: () => void
  let finish!: () => void
  const pending = new Promise<void>(resolve => { entered = resolve })
  const release = new Promise<void>(resolve => { finish = resolve })
  const transfer = withForgeTransfer(f.customer.homeDir, f.customer.root, join(f.customer.homeDir, 'Forge', 'Customer'), async () => {
    entered()
    await release
  })
  await pending
  try {
    await expect(f.desktop.dispatch({ op: 'recover_tooling', args: { action: 'escalate', incidentId: 'during-transfer', diagnostic } }, context(f.caller))).resolves.toMatchObject({
      blocked: true, connection: 'unavailable', problem: expect.stringContaining('conversion is pending'), cardId: null, repairChatId: null
    })
    expect(db.all('SELECT * FROM tooling_holds')).toEqual([])
    expect(f.start).not.toHaveBeenCalled()
    expect((await f.sourceWs.listKanbanCards({})).lanes.backlog).toEqual([])
  } finally { finish(); await transfer }
})
