import { testWorkspace } from '../desktop/__mocks__/projectWorkspaceFixture'
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
  const agentKind = (id: string) => id === 'claude' || id === 'codex' ? id : kind
  const delivery = createAgentContextDelivery({ userData, deliveries: ledger, agentKind: chat => agentKind(chat.agent) })
  const live = new Set([caller.id])
  let entry = 0
  const persist = (chat: ChatRecord, content: string, attribution: 'user' | 'agent'): void => {
    const sessions = join(userData, 'agents', 'omp', chat.id, 'sessions'); mkdirSync(sessions, { recursive: true })
    appendFileSync(join(sessions, '2026-11-21T00-00-00-000Z_01234567-89ab-4cde-8123-456789abcdef.jsonl'), JSON.stringify({ type: 'message', id: `fixture-entry-${++entry}`, message: { role: 'user', attribution, content } }) + '\n')
  }
  let desktop: DesktopToolingRecovery
  const start = vi.fn(async (chat: ChatRecord, options: { kickoff: string }) => {
    await desktop.assertLaunch(chat)
    persist(chat, options.kickoff, 'user'); store.updateChat(chat, { firstPromptDelivery: 'submitted', kickoffSent: true }); live.add(chat.id)
    return { state: 'running' as const, pid: 123 }
  })
  const sourceCheckout = { requireAvailable: vi.fn(() => ({ path: source.root, target: { kind: 'darkmechanicus_source' as const, projectId: sourceWs.ctx().projectId, projectName: 'Source fixture' } })) }
  const resolveFolder = vi.fn((folder: string) => folder === source.root || folder === customer.root ? folder : null)
  const paste = vi.fn()
  const pasteIfRunning = vi.fn()
  const onNoticeError = vi.fn()
  const resume = vi.fn(async (chat: ChatRecord) => {
    await desktop.assertLaunch(chat)
    const received = await desktop.dispatch({ op: 'recovery_context', args: { chatId: chat.id, generation: 'fixture-start' } }, context(chat)) as { messages: { id: string; text: string }[] }
    if (received.messages.length > 0) persist(chat, `${RECOVERY_DATA_NOTE}\n${JSON.stringify(received)}`, 'agent')
    return null
  })
  const restart = (): DesktopToolingRecovery => {
    desktop = createDesktopToolingRecovery({ userData, version: () => '1.0.0',
      source: sourceCheckout,
      store, agents: { get: id => builtInAgent(agentKind(id)) },
      workspace: folder => testWorkspace(folder === source.root ? sourceWs : customerWs),
      resolveFolder,
      context: delivery, deliveries: ledger,
      terminals: { start, isRunning: id => live.has(id), paste, pasteIfRunning,
        activeChats: () => [null, source.root, customer.root].flatMap(folder => store.listChats(folder)).filter(chat => live.has(chat.id)) },
      resume, onNoticeError
    })
    return desktop
  }
  const initialDesktop = restart()
  return { source, sourceWs, customer, customerWs, store, caller, start, desktop: initialDesktop, ledger, delivery, persist, resume, paste, pasteIfRunning, resolveFolder, sourceCheckout, restart, live, onNoticeError }
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
    expect(await sent(repair, 'question', 'Which ticket failed?')).toMatchObject({ waitingForRepair: true, messageDelivery: 'delivered' })
    expect(await sent(caller, 'answer', 'The non-sensitive fixture.')).toMatchObject({ waitingForRepair: true, messageDelivery: 'delivered' })
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

it('advises only active peers once and exposes no project diagnostic or incident permissions', async () => {
  const f = await recoveryFixture(false)
  const peer = f.store.createChat({ folder: f.source.root, agent: 'omp', model: null, role: 'worker', allowSave: false })
  const idle = f.store.createChat({ folder: null, agent: 'omp', model: null, role: 'worker', allowSave: false })
  f.live.add(peer.id)
  const escalation = { op: 'recover_tooling' as const, args: { action: 'escalate' as const, incidentId: 'notice', diagnostic } }
  const result = await f.desktop.dispatch(escalation, context(f.caller)) as { incidentId: string }
  const read = (chat: ChatRecord) => f.desktop.dispatch({ op: 'recovery_context', args: { chatId: chat.id, generation: 'fixture-start' } }, context(chat)) as { messages: { id: string; text: string }[] }
  const notice = read(peer).messages[0]!
  expect(notice.text).toContain('already working on a Dark Mechanicus failure in get_ticket')
  expect(notice.text).toContain(result.incidentId)
  expect(notice.text).not.toContain(diagnostic.message)
  expect(read(idle)).toEqual({ messages: [] })
  expect(f.resume).not.toHaveBeenCalledWith(peer)
  f.persist(peer, RECOVERY_DATA_NOTE + '\n' + JSON.stringify({ messages: [notice] }), 'agent')
  await f.desktop.dispatch(escalation, context(f.caller))
  expect(read(peer)).toEqual({ messages: [] })
  expect(f.ledger.proof(f.source.root, peer.id, 'recovery', notice.id)?.state).toBe('delivered')
  await expect(f.desktop.dispatch({ op: 'recover_tooling', args: { action: 'status', incidentId: result.incidentId } }, context(peer))).rejects.toMatchObject({ code: 'unauthorized' })
})

it('isolates notice delivery failures and pastes a generic advisory once to a live projectless Claude peer', async () => {
  const f = await recoveryFixture(false)
  const claude = f.store.createChat({ folder: null, agent: 'claude', model: null, role: 'worker', allowSave: false })
  const unsupported = f.store.createChat({ folder: f.customer.root, agent: 'codex', model: null, role: 'worker', allowSave: false })
  const broken = f.store.createChat({ folder: f.customer.root, agent: 'omp', model: null, role: 'worker', allowSave: false })
  for (const peer of [claude, unsupported, broken]) f.live.add(peer.id)
  const originalQueue = f.delivery.queueRecovery.bind(f.delivery)
  const failure = new Error('Fixture peer outbox failed')
  vi.spyOn(f.delivery, 'queueRecovery').mockImplementation(async (chat, message) => {
    if (chat.id === broken.id) throw failure
    await originalQueue(chat, message)
  })
  const privateCommand = 'Unrecognized private project command'
  const escalation = { op: 'recover_tooling' as const, args: { action: 'escalate' as const, incidentId: 'mixed-hosts',
    diagnostic: { ...diagnostic, command: privateCommand } } }
  expect(await f.desktop.dispatch(escalation, context(f.caller))).toMatchObject({ connection: 'connected', problem: null })
  expect(f.onNoticeError).toHaveBeenCalledExactlyOnceWith(failure)
  expect(f.pasteIfRunning).toHaveBeenCalledExactlyOnceWith(claude, expect.stringContaining('already working on a Dark Mechanicus failure'))
  expect(f.pasteIfRunning.mock.calls[0]![1]).not.toContain(privateCommand)
  expect(f.ledger.pending().some(entry => entry.chatId === unsupported.id)).toBe(false)
  await f.desktop.poll('projectless')
  expect(f.pasteIfRunning).toHaveBeenCalledOnce()
  expect(f.resume).not.toHaveBeenCalledWith(claude)
})

it('keeps an authorized write available before and after failed repair setup', async () => {
  const f = await recoveryFixture(false)
  const grant = await f.customerWs.issueGrant({ role: 'orchestrator', label: 'Skitarii fixture' })
  const callerWorkspace = f.customer.open('orchestrator', { transport: 'cli', grantToken: grant.token })
  f.sourceCheckout.requireAvailable.mockImplementation(() => { throw new Error('Missing fixture source') })
  const report = await f.desktop.dispatch({ op: 'recover_tooling', args: { action: 'escalate', incidentId: 'missing-source', diagnostic } }, context(f.caller))
  expect(report).toMatchObject({ waitingForRepair: true, startup: 'not_started', cardId: null })
  expect((await callerWorkspace.createKanbanCard({ title: 'Authorized unrelated change' })).title).toBe('Authorized unrelated change')
  expect(f.ledger.pending()).toEqual([])
})

it('stops advertising a repair once its repair agent reports availability', async () => {
  const f = await recoveryFixture(false)
  const peer = f.store.createChat({ folder: f.customer.root, agent: 'omp', model: null, role: 'worker', allowSave: false })
  f.live.add(peer.id)
  const { incidentId, repairChatId } = await f.desktop.dispatch({
    op: 'recover_tooling', args: { action: 'escalate', incidentId: 'resolved-notice', diagnostic }
  }, context(f.caller)) as { incidentId: string; repairChatId: string }
  const read = { op: 'recovery_context', args: { chatId: peer.id, generation: 'fixture-start' } } as const
  expect(f.desktop.dispatch(read, context(peer))).toMatchObject({ messages: [{ text: expect.stringContaining('already working') }] })
  f.live.delete(repairChatId)
  expect(f.desktop.dispatch(read, context(peer))).toEqual({ messages: [] })
  f.live.add(repairChatId)
  const repair = f.store.getChat({ folder: f.source.root, id: repairChatId })!
  await f.desktop.dispatch({ op: 'recover_tooling', args: { action: 'available', incidentId, version: '1.0.0', evidence: 'Fixture verified' } }, context(repair))
  expect(f.desktop.dispatch(read, context(peer))).toEqual({ messages: [] })
  expect(f.ledger.pending().filter(entry => entry.chatId === peer.id)).toEqual([])
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
  expect(f.start).not.toHaveBeenCalled()
})

it('retains an unsupported selected host without pausing its workflow or creating a repair', async () => {
  const f = await recoveryFixture(false, 'codex')
  const result = await f.desktop.dispatch({ op: 'recover_tooling', args: { action: 'escalate', incidentId: 'unsupported', diagnostic } }, context(f.caller))
  expect(result).toMatchObject({ waitingForRepair: true, cardId: null, repairChatId: null, startup: 'not_started', connection: 'unavailable' })
  expect(f.sourceCheckout.requireAvailable).not.toHaveBeenCalled()
  expect(f.start).not.toHaveBeenCalled()
  expect(f.store.listChats(f.source.root)).toEqual([])
  expect((await f.sourceWs.listKanbanCards({})).lanes.backlog).toEqual([])
})

it('refuses stale receiver generations and isolates messages by authenticated recipient', async () => {
  const f = await recoveryFixture(false)
  const result = await f.desktop.dispatch({ op: 'recover_tooling', args: { action: 'escalate', incidentId: 'identity', diagnostic } }, context(f.caller)) as { incidentId: string; repairChatId: string }
  expect(() => f.desktop.dispatch({ op: 'recovery_context', args: { chatId: f.caller.id, generation: 'stale' } }, context(f.caller))).toThrow('authority is not usable')
  const impostor = f.store.createChat({ folder: f.customer.root, agent: 'omp', role: 'orchestrator', allowSave: false, model: null })
  expect(f.desktop.dispatch({ op: 'recovery_context', args: { chatId: impostor.id, generation: 'fixture-start' } }, context(impostor))).toEqual({ messages: [] })
  await expect(f.desktop.dispatch({ op: 'recover_tooling', args: { action: 'message', incidentId: result.incidentId, messageId: 'forged', text: 'Read caller data' } }, context(impostor))).rejects.toMatchObject({ code: 'unauthorized' })
  f.store.deleteChat(impostor)
  expect(() => f.desktop.dispatch({ op: 'recovery_context', args: { chatId: impostor.id, generation: 'fixture-start' } }, context(impostor))).toThrow('not found')
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

it('starts the repair without opening the caller workspace during its Forge transfer', async () => {
  const f = await recoveryFixture(false)
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
      waitingForRepair: true, connection: 'connected', cardId: expect.any(String), repairChatId: expect.any(String)
    })
    expect(f.start).toHaveBeenCalledTimes(1)
  } finally { finish(); await transfer }
})

type RecoveryFixture = Awaited<ReturnType<typeof recoveryFixture>>

async function fixtureIncident(f: RecoveryFixture, caller: ChatRecord, key: string) {
  const result = await f.desktop.dispatch({ op: 'recover_tooling', args: { action: 'escalate', incidentId: key, diagnostic } }, context(caller)) as { incidentId: string; repairChatId: string }
  return { ...result, caller, key, repair: f.store.getChat({ folder: f.source.root, id: result.repairChatId })! }
}

async function twoIncidentRestart(receipted: boolean) {
  const f = await recoveryFixture(false)
  const cold = await fixtureIncident(f, f.caller, 'cold-repair')
  const caller = f.store.createChat({ folder: null, agent: 'omp', model: null, role: 'orchestrator', allowSave: false })
  const active = await fixtureIncident(f, caller, 'live-repair')
  await f.desktop.poll(f.source.root)
  await f.desktop.poll(f.customer.root)
  const deliver = f.resume.getMockImplementation()!
  if (!receipted) f.resume.mockImplementation(async () => null)
  await f.desktop.dispatch({ op: 'recover_tooling', args: { action: 'message', incidentId: cold.incidentId, messageId: 'cold-answer', text: 'Retained cold incident answer' } }, context(cold.caller))
  f.resume.mockImplementation(deliver)
  f.live.delete(cold.repair.id)
  const desktop = f.restart()
  await desktop.dispatch({ op: 'recover_tooling', args: { action: 'escalate', incidentId: active.key, diagnostic } }, context(active.caller, 'new-live-generation'))
  f.resume.mockClear()
  return { f, desktop, cold, active }
}

describe('independent pending recovery incidents after desktop restart', () => {
  it.each([false, true])('delivers a valid live-incident message without an unrelated cold restart failure (receipted=%s)', async receipted => {
    const { f, desktop, cold, active } = await twoIncidentRestart(receipted)
    await expect(desktop.dispatch({ op: 'recover_tooling', args: { action: 'message', incidentId: active.incidentId, messageId: 'live-answer', text: 'Live incident answer' } }, context(active.caller))).resolves.toMatchObject({ messageDelivery: 'delivered', problem: null })
    await expect(desktop.poll(f.source.root)).resolves.toBeUndefined()
    expect(f.ledger.proof(f.source.root, active.repair.id, 'recovery', `recovery_${active.incidentId}_caller_live-answer`)).toMatchObject({ state: 'delivered', problem: null })
    await expect(desktop.assertLaunch(cold.repair)).rejects.toThrow('live caller handoff')
    expect(f.resume.mock.calls.some(([chat]) => chat.id === cold.repair.id)).toBe(false)
  })

  it.each([false, true])('reconciles actual receipts or retains an explicit pending cold incident without stopping later deliveries (receipted=%s)', async receipted => {
    const { f, desktop, cold, active } = await twoIncidentRestart(receipted)
    const deliver = f.resume.getMockImplementation()!
    f.resume.mockImplementation(async () => null)
    await expect(desktop.dispatch({ op: 'recover_tooling', args: { action: 'message', incidentId: active.incidentId, messageId: 'later-live-entry', text: 'Later live data' } }, context(active.repair))).resolves.toMatchObject({ messageDelivery: 'pending' })
    f.resume.mockImplementation(deliver)
    const pending = desktop.dispatch({ op: 'recovery_context', args: { chatId: active.caller.id, generation: 'fixture-start' } }, context(active.caller)) as { messages: { id: string; text: string }[] }
    expect(pending.messages).toHaveLength(1)
    expect(pending.messages[0]!.text).toContain('Later live data')
    await expect(desktop.poll(f.source.root)).resolves.toBeUndefined()
    const proof = f.ledger.proof(f.source.root, cold.repair.id, 'recovery', `recovery_${cold.incidentId}_caller_cold-answer`)
    expect(proof).toMatchObject({
      messageId: `recovery_${cold.incidentId}_caller_cold-answer`,
      chatId: cold.repair.id,
      text: expect.stringContaining('Retained cold incident answer'),
      state: receipted ? 'delivered' : 'pending',
      problem: receipted ? null : expect.stringContaining('live caller handoff')
    })
    expect(f.delivery.hasRecoveryMessage(cold.repair, { id: proof!.messageId, text: proof!.text! })).toBe(receipted)
    expect(f.delivery.hasRecoveryMessage(active.caller, pending.messages[0]!)).toBe(true)
    expect(f.resume.mock.calls.some(([chat]) => chat.id === cold.repair.id)).toBe(false)
    await expect(desktop.assertLaunch(cold.repair)).rejects.toThrow('live caller handoff')
  })

  it('returns explicit pending state instead of starting an unreplayed repair', async () => {
    const { f, desktop, cold } = await twoIncidentRestart(false)
    await expect(desktop.dispatch({ op: 'recover_tooling', args: { action: 'message', incidentId: cold.incidentId, messageId: 'waiting-for-replay', text: 'Keep this diagnostic pending' } }, context(cold.caller))).resolves.toMatchObject({ messageDelivery: 'pending', problem: expect.stringContaining('live caller handoff') })
    expect(f.ledger.proof(f.source.root, cold.repair.id, 'recovery', `recovery_${cold.incidentId}_caller_waiting-for-replay`)).toMatchObject({ state: 'pending', problem: expect.stringContaining('live caller handoff') })
    expect(f.resume.mock.calls.some(([chat]) => chat.id === cold.repair.id)).toBe(false)
    await expect(desktop.assertLaunch(cold.repair)).rejects.toThrow('live caller handoff')
  })

  it('still surfaces an unexpected current-recipient source guard failure', async () => {
    const { f, desktop, active } = await twoIncidentRestart(false)
    f.sourceCheckout.requireAvailable.mockImplementation(() => { throw new Error('Source inspection failed') })
    await expect(desktop.dispatch({ op: 'recover_tooling', args: { action: 'message', incidentId: active.incidentId, messageId: 'source-failure', text: 'Retain this pending diagnostic' } }, context(active.caller))).rejects.toThrow('Source inspection failed')
    expect(f.ledger.proof(f.source.root, active.repair.id, 'recovery', `recovery_${active.incidentId}_caller_source-failure`)).toMatchObject({ state: 'pending' })
    expect(f.resume).not.toHaveBeenCalled()
  })
})

async function installStaleCallerGuard(fixture: Awaited<ReturnType<typeof twoIncidentRestart>>, failure: Error) {
  const { f, desktop, cold } = fixture
  const deliver = f.resume.getMockImplementation()!
  f.resume.mockImplementation(async () => null)
  f.live.add(cold.repair.id)
  const stale = context(cold.caller, 'previous-caller-generation')
  await desktop.dispatch({ op: 'recover_tooling', args: { action: 'escalate', incidentId: cold.key, diagnostic } }, stale)
  f.live.delete(cold.repair.id)
  f.resume.mockImplementation(deliver)
  stale.binding.assertCurrent = () => { throw failure }
}

describe('surfacing recovery failures after unrelated polling progress', () => {
  it('delivers and acknowledges later same-source and projectless peers before rejecting an installed stale caller guard', async () => {
    const fixture = await twoIncidentRestart(false)
    const { f, desktop, active } = fixture
    const failure = new Error('Previous caller generation is no longer current')
    await installStaleCallerGuard(fixture, failure)
    const deliver = f.resume.getMockImplementation()!
    f.resume.mockImplementation(async () => null)
    await desktop.dispatch({ op: 'recover_tooling', args: { action: 'message', incidentId: active.incidentId, messageId: 'source-peer', text: 'Live same-source message' } }, context(active.caller))
    await desktop.dispatch({ op: 'recover_tooling', args: { action: 'message', incidentId: active.incidentId, messageId: 'projectless-peer', text: 'Live projectless message' } }, context(active.repair))
    f.resume.mockImplementation(deliver)
    const pending = [active.repair, active.caller].map(chat => {
      // The in-process dispatcher erases operation-specific return types.
      const received = desktop.dispatch({ op: 'recovery_context', args: { chatId: chat.id, generation: 'fixture-start' } }, context(chat)) as { messages: { id: string; text: string }[] }
      expect(received.messages).toHaveLength(1)
      return { chat, message: received.messages[0]! }
    })
    expect(pending.map(({ message }) => message.text)).toEqual([expect.stringContaining('Live same-source message'), expect.stringContaining('Live projectless message')])
    await expect(desktop.poll(f.source.root)).rejects.toBe(failure)
    for (const { chat, message } of pending) expect(f.delivery.hasRecoveryMessage(chat, message)).toBe(true)
    await expect(desktop.poll(f.source.root)).rejects.toBe(failure)
    for (const { chat, message } of pending) expect(f.ledger.proof(chat.folder ?? 'projectless', chat.id, 'recovery', message.id)).toMatchObject({ state: 'delivered', problem: null })
  })

  it('surfaces source and projectless failures together instead of dropping either original error', async () => {
    const fixture = await twoIncidentRestart(false)
    const { f, desktop, active } = fixture
    const stale = new Error('Stale source repair caller')
    const host = new Error('Projectless host unavailable')
    await installStaleCallerGuard(fixture, stale)
    const deliver = f.resume.getMockImplementation()!
    f.resume.mockImplementation(async () => null)
    await desktop.dispatch({ op: 'recover_tooling', args: { action: 'message', incidentId: active.incidentId, messageId: 'failing-host', text: 'Retain projectless context' } }, context(active.repair))
    f.resume.mockImplementation(async chat => {
      if (chat.id === active.caller.id) throw host
      return deliver(chat)
    })
    await expect(desktop.poll(f.source.root)).rejects.toMatchObject({ message: 'Tooling recovery delivery reconciliation failed.', errors: [stale, host] })
    expect(f.ledger.proof('projectless', active.caller.id, 'recovery', `recovery_${active.incidentId}_repair_failing-host`)).toMatchObject({ state: 'pending' })
  })
})
