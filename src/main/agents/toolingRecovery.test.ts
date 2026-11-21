import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChatStore } from './chatStore'
import { createToolingRecovery } from './toolingRecovery'
import { createRecoveryStore } from './toolingRecoveryStore'
import type { NamingOperationContext } from '../naming/controlPipe'
import type { ToolingRecoveryInput } from '../../shared/agents/toolingRecovery'
import type { ChatRecord } from '../../shared/agents/chat'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const diagnostic = { command: 'get_ticket', code: 'internal_error', message: 'Failure token=private-fixture-secret', reproduction: 'Read the saved ticket', expected: 'Return its packet', arguments: { ticketId: 'tk_fixture', authorization: 'private-fixture-secret' } }
const escalation: ToolingRecoveryInput = { action: 'escalate', incidentId: 'fixture-incident', diagnostic }
function fixture(role: 'planner' | 'orchestrator' = 'planner') {
  const root = mkdtempSync(join(tmpdir(), 'dm901-recovery-')); roots.push(root)
  const sourceFolder = join(root, 'source'); mkdirSync(sourceFolder)
  const store = createChatStore({ root: join(root, 'chats') })
  const caller = store.createChat({ folder: root, agent: 'omp', role, model: null, allowSave: false, title: 'Unfinished original task' })
  const events: string[] = []
  const source = { requireAvailable: vi.fn(() => ({ path: sourceFolder, target: { kind: 'darkmechanicus_source' as const, projectId: 'pj_fixture', projectName: 'Dark Mechanicus fixture' } })) }
  const cards: { id: string; body: string }[] = []
  const receipts = new Set<string>()
  const messages = new Map<string, { id: string; text: string }>()
  let version = '1.0.0'
  const live = new Set<string>()
  const deps = {
    source, store, incidents: createRecoveryStore({ userData: root }),
    version: () => version,
    createCard: vi.fn(async (_folder: string, input: { body: string }) => { events.push('card'); const card = { id: 'kc_fixture', body: input.body }; cards.push(card); return card.id }),
    play: vi.fn(async () => { events.push('play') }),
    hold: vi.fn(async () => { events.push('hold') }),
    release: vi.fn(async () => { events.push('release') }),
    authorizeLaunch: vi.fn(),
    start: vi.fn(async (chat: ChatRecord, prompt: string, assertLaunch: () => void) => { assertLaunch(); events.push('start'); store.updateChat(chat, { firstPromptDelivery: 'submitted' }); receipts.add(prompt); live.add(chat.id); return { state: 'running' as const, pid: 123 } }),
    running: vi.fn((chat: ChatRecord) => live.has(chat.id)),
    delivery: {
      hasInput: (_chat: { id: string }, text: string) => receipts.has(text),
      queue: vi.fn(async (chat: { id: string }, message: { id: string; text: string }) => { messages.set(chat.id + message.id, message); receipts.add(message.text) }),
      received: (_chat: { id: string }, message: { text: string }) => receipts.has(message.text),
      wake: vi.fn(async () => null as string | null)
    }
  }
  const context = (chatId = caller.id, generation = 'initial'): NamingOperationContext => {
    const chat = store.getChat({ folder: chatId === caller.id ? root : sourceFolder, id: chatId }) ?? store.getChat({ folder: root, id: chatId })!
    return { binding: { grantId: 'gr_fixture', folder: chat.folder, chatId, generation, ...(chat.cardId === undefined ? {} : { cardId: chat.cardId }), signal: new AbortController().signal, assertCurrent() {} }, signal: new AbortController().signal, deadline: Infinity, remainingMs: () => 1000, assertActive() {}, publish: fn => fn() }
  }
  return { root, sourceFolder, store, caller, events, source, cards, receipts, messages, deps, context, service: createToolingRecovery(deps), setVersion: (next: string) => { version = next } }
}

describe('single-call connected tooling recovery', () => {
  it.each(['planner', 'orchestrator'] as const)('interrupts unfinished %s work before filing and starts a card-bound repair with proven input and two-way routes', async role => {
    const f = fixture(role)
    const result = await f.service(escalation, f.context())
    expect(f.events).toEqual(['hold', 'card', 'play', 'start'])
    expect(result).toMatchObject({ blocked: true, cardId: 'kc_fixture', startup: 'running', prompt: 'delivered', connection: 'connected' })
    expect(result.repairChatId).not.toBe(f.caller.id)
    expect(f.store.getChat(f.caller)).toMatchObject({ title: 'Unfinished original task', role, toolingIncidentId: result.incidentId })
    expect(f.store.getChat({ folder: f.sourceFolder, id: result.repairChatId! })).toMatchObject({ role: 'orchestrator', allowSave: false, cardId: 'kc_fixture', repairIncidentId: result.incidentId })
    expect(f.cards[0]!.body).not.toContain('private-fixture-secret')
    expect(f.cards[0]!.body).toContain(f.caller.id)
    const question = await f.service({ action: 'message', incidentId: result.incidentId, messageId: 'question', text: 'Which saved ticket failed?' }, f.context(result.repairChatId!))
    expect(question.messageDelivery).toBe('delivered')
    const answer = await f.service({ action: 'message', incidentId: result.incidentId, messageId: 'answer', text: 'The fixture ticket.' }, f.context())
    expect(answer.messageDelivery).toBe('delivered')
    expect(f.deps.delivery.wake).toHaveBeenCalledWith(expect.objectContaining({ id: f.caller.id }))
  })

  it.each(['missing', 'uninitialized', 'unrelated', 'stale'])('refuses %s source before creating any card or chat and retains the original blocked diagnostic', async reason => {
    const f = fixture(); f.source.requireAvailable.mockImplementation(() => { throw new Error(reason) })
    const result = await f.service(escalation, f.context())
    expect(result).toMatchObject({ blocked: true, cardId: null, repairChatId: null, startup: 'not_started', connection: 'unavailable' })
    expect(f.cards).toHaveLength(0)
    expect(f.store.listChats(f.root)).toHaveLength(1)
    expect(f.events).toEqual(['hold'])
    expect((await f.service({ action: 'status', incidentId: result.incidentId }, f.context())).problem).toContain(reason)
  })

  it('replays one incident without duplicate card, chat, first prompt or connection, including after service restart', async () => {
    const f = fixture(); const first = await f.service(escalation, f.context())
    const fresh = createToolingRecovery({ ...f.deps, incidents: createRecoveryStore({ userData: f.root }) })
    const again = await fresh(escalation, f.context())
    expect(again.repairChatId).toBe(first.repairChatId)
    expect(f.deps.createCard).toHaveBeenCalledTimes(1)
    expect(f.deps.start).toHaveBeenCalledTimes(1)
    expect(f.store.listChats(f.root)).toHaveLength(1)
    expect(f.store.listChats(f.sourceFolder)).toHaveLength(1)
    expect(f.deps.delivery.queue).toHaveBeenCalledTimes(2)
  })

  it('preserves partial state after filing and startup failures and never recursively escalates a repair', async () => {
    const f = fixture(); f.deps.start.mockRejectedValueOnce(new Error('fixture spawn failed'))
    const result = await f.service(escalation, f.context())
    expect(result).toMatchObject({ blocked: true, cardId: 'kc_fixture', startup: 'failed', prompt: 'pending', connection: 'unavailable' })
    expect(result.repairChatId).not.toBeNull()
    await expect(f.service({ ...escalation, incidentId: 'nested' }, f.context(result.repairChatId!))).rejects.toMatchObject({ code: 'unauthorized' })
    expect(f.cards).toHaveLength(1)
    const other = fixture(); other.deps.createCard.mockRejectedValueOnce(new Error('tracking storage unavailable'))
    const failed = await other.service(escalation, other.context())
    expect(failed).toMatchObject({ blocked: true, cardId: null, repairChatId: null })
    expect(failed.problem).toContain('tracking storage unavailable')
  })

  it('does not equate a running PTY, accepted queue or invented peer ids with host delivery', async () => {
    const f = fixture(); f.deps.start.mockImplementation(async () => ({ state: 'running', pid: 123 }))
    f.deps.running.mockReturnValue(true)
    f.deps.delivery.queue.mockImplementation(async () => {})
    const result = await f.service(escalation, f.context())
    expect(result).toMatchObject({ blocked: true, startup: 'running', prompt: 'pending', connection: 'pending' })
  })

  it('rejects other chats and input conflicts; only a changed verified runtime and restarted caller can lift the exact hold', async () => {
    const f = fixture(); const result = await f.service(escalation, f.context())
    const outsider = f.store.createChat({ folder: f.root, agent: 'omp', role: 'orchestrator', model: null, allowSave: false })
    await expect(f.service({ action: 'status', incidentId: result.incidentId }, f.context(outsider.id))).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(f.service({ ...escalation, diagnostic: { ...diagnostic, expected: 'different' } }, f.context())).rejects.toMatchObject({ code: 'conflict' })
    await f.service({ action: 'available', incidentId: result.incidentId, version: '1.1.0', evidence: 'Independent review and regression pass; merged abc123.' }, f.context(result.repairChatId!))
    expect(await f.service({ action: 'resume', incidentId: result.incidentId }, f.context())).toMatchObject({ blocked: true })
    f.setVersion('1.1.0')
    expect(await f.service({ action: 'resume', incidentId: result.incidentId }, f.context())).toMatchObject({ blocked: true })
    expect(await f.service({ action: 'resume', incidentId: result.incidentId }, f.context(f.caller.id, 'restarted'))).toMatchObject({ blocked: false })
    expect(f.deps.release).toHaveBeenCalledTimes(1)
  })
  it('serializes concurrent replay, opposite-side messages and availability without losing diagnostics or handshakes', async () => {
    const f = fixture(); const result = await f.service(escalation, f.context())
    await Promise.all([
      f.service(escalation, f.context()),
      f.service({ action: 'message', incidentId: result.incidentId, messageId: 'concurrent-origin', text: 'Original question' }, f.context()),
      f.service({ action: 'message', incidentId: result.incidentId, messageId: 'concurrent-repair', text: 'Repair answer' }, f.context(result.repairChatId!)),
      f.service({ action: 'available', incidentId: result.incidentId, version: '1.1.0', evidence: 'Reviewed fixture release' }, f.context(result.repairChatId!))
    ])
    const stored = f.deps.incidents.get(result.incidentId)!
    expect(stored.messages).toHaveLength(4)
    expect(stored.available?.version).toBe('1.1.0')
    expect(f.cards).toHaveLength(1)
  })

  it('revalidates exact source identity after filing and inside the final native startup guard', async () => {
    const f = fixture()
    f.deps.createCard.mockImplementationOnce(async () => {
      f.source.requireAvailable.mockReturnValue({ path: f.sourceFolder, target: { kind: 'darkmechanicus_source', projectId: 'pj_replaced', projectName: 'Replaced' } })
      return 'kc_fixture'
    })
    const refused = await f.service(escalation, f.context())
    expect(refused).toMatchObject({ cardId: 'kc_fixture', repairChatId: null, startup: 'not_started', blocked: true })
    expect(f.deps.start).not.toHaveBeenCalled()
    const native = fixture()
    native.deps.start.mockImplementationOnce(async (_chat, _prompt, guard: () => void) => {
      native.source.requireAvailable.mockImplementation(() => { throw new Error('Source replaced during native auth') })
      guard()
      return { state: 'running', pid: 123 }
    })
    const stopped = await native.service(escalation, native.context())
    expect(stopped).toMatchObject({ startup: 'failed', blocked: true, connection: 'unavailable' })
    expect(stopped.problem).toContain('Source replaced during native auth')
  })
})
