import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { openHumanWait } from '../../resources/skitarii/extension/humanWaitLease'
import type { Workspace } from '../core/workspace'
import { askHuman, humanAnswer, telegramAvailable } from '../core/humanQuestions'
import { startTelegram } from './telegram'

const env = vi.hoisted(() => ({ dir: '', token: '', encryption: true }))
vi.mock('electron', () => ({
  clipboard: { readText: () => env.token },
  app: { getPath: () => env.dir },
  safeStorage: { isEncryptionAvailable: () => env.encryption, getSelectedStorageBackend: () => 'test', encryptString: Buffer.from, decryptString: (data: Buffer) => data.toString() }
}))

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(env.dir, { recursive: true, force: true }) })

function boardFixture() {
  const now = '2099-01-01T00:00:00Z'
  const card = { id: 'card', key: 'DM-1', title: 'Build', updatedAt: now }
  const question = { id: 'question', body: '@human Which target?', authorRole: 'worker', createdAt: now }
  const history: Record<string, typeof question[]> = {
    card: [question], old: [{ ...question, id: 'old', createdAt: '2000' }],
    person: [{ ...question, id: 'person', authorRole: 'desktop' }],
    note: [{ ...question, id: 'note', body: 'Progress update: wondering which target?' }], empty: []
  }
  const replies: unknown[] = []
  const ws = {
    listKanbanCards: async () => ({ lanes: { in_progress: Object.keys(history).map(id => ({ ...card, id })), ready_for_review: [] } }),
    listKanbanMessages: async ({ cardId }: { cardId: string }) => history[cardId],
    addKanbanMessage: async (reply: unknown) => { replies.push(reply) }
  }
  return { history, replies, ws, question }
}

function seedLegacyRoute(question: string): void {
  // A previous app version could have already sent a card question before the upgrade.
  const configPath = join(env.dir, 'telegram.enc')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.routes[81] = { folder: 'folder', cardId: 'card', question }
  writeFileSync(configPath, JSON.stringify(config))
}

function update(id: number, who: number, text: string, messageId = 81) {
  return {
    update_id: id, message: { chat: { type: 'private', id: who }, from: { id: who }, text, reply_to_message: { message_id: messageId } }
  }
}

async function pairBot(handlers: Map<string, (...args: unknown[]) => unknown>, outbound: unknown[], queue: (update: unknown) => void) {
  env.token = 'invalid'
  await expect(handlers.get('telegram:pair')!()).rejects.toThrow('Invalid Telegram token')
  env.token = '12345:' + 'a'.repeat(32)
  env.encryption = false
  await expect(handlers.get('telegram:pair')!()).rejects.toThrow('protected OS credential store')
  env.encryption = true
  const code = await handlers.get('telegram:pair')!()
  queue(update(0, 18, '/start wrong'))
  await vi.advanceTimersByTimeAsync(5000)
  expect(outbound).toEqual([])
  expect(await handlers.get('telegram:status')!()).toEqual({ configured: true, enabled: true, paired: false, issue: '' })
  queue(update(1, 17, '/start ' + code))
  await vi.advanceTimersByTimeAsync(5000)
  expect(outbound).toEqual([]) // An @human card question alone says nothing about engagement.
}

it('pairs one private user and routes only their threaded reply to the original card', async () => {
  env.dir = mkdtempSync(join(tmpdir(), 'telegram-test-'))
  vi.useFakeTimers()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipc = { handle: handlers.set.bind(handlers) } as unknown as IpcMain
  const { history, replies, ws, question } = boardFixture()
  let updates: unknown[] = []
  const outbound: unknown[] = []
  function send(body: string) { outbound.push(JSON.parse(body)); return { message_id: 82 } }
  vi.stubGlobal('fetch', async (url: string, options: { body: string }) => ({
    ok: true, json: async () => ({ ok: true, result: url.endsWith('getUpdates') ? updates.splice(0) : url.endsWith('sendMessage') ? send(options.body) : {} })
  }))
  let stop = startTelegram(ipc, () => ['folder'], () => ws as unknown as Workspace, env.dir)
  try {
    await pairBot(handlers, outbound, u => { updates = [u] })
    stop()
    seedLegacyRoute(question.id)
    stop = startTelegram(ipc, () => ['folder'], () => ws as unknown as Workspace, env.dir)
    updates = [update(2, 18, 'unpaired'), update(3, 17, 'Windows')]
    await vi.advanceTimersByTimeAsync(5000)
    expect(replies).toEqual([{ cardId: 'card', body: 'Windows', idempotencyKey: 'telegram-3' }])
    stop()
    stop = startTelegram(ipc, () => ['folder'], () => ws as unknown as Workspace, env.dir)
    history.card = [{ ...question, authorRole: 'desktop', id: 'answered' }]
    updates = [update(4, 17, 'late')]
    await vi.advanceTimersByTimeAsync(5000)
    expect(outbound).toHaveLength(0)
    expect(replies).toHaveLength(1)
    expect(await handlers.get('telegram:status')!()).toEqual({ configured: true, enabled: true, paired: true, issue: '' })
    const { questionId } = askHuman(env.dir, 'another-project', 'Which deployment target should I use?')
    await vi.advanceTimersByTimeAsync(5000)
    expect(outbound).toEqual([{ chat_id: 17, text: 'another-project\n\nWhich deployment target should I use?', reply_markup: { force_reply: true } }])
    expect(humanAnswer(env.dir, 'another-project', questionId).state).toBe('sent')
    expect(() => humanAnswer(env.dir, 'other-project', questionId)).toThrow('Unknown human question')
    updates = [update(5, 18, 'wrong sender', 82), update(6, 17, 'Staging', 82)]
    await vi.advanceTimersByTimeAsync(5000)
    expect(humanAnswer(env.dir, 'another-project', questionId)).toEqual({ state: 'answered', answer: 'Staging' })
    const waiting = askHuman(env.dir, 'another-project', 'Which branch?')
    await handlers.get('telegram:setEnabled')!(undefined, false)
    expect(telegramAvailable(env.dir)).toBe(false)
    expect(humanAnswer(env.dir, 'another-project', waiting.questionId).state).toBe('cancelled')
    expect(() => askHuman(env.dir, 'another-project', 'Which branch?')).toThrow('Telegram is unavailable')
    stop()
    stop = startTelegram(ipc, () => [], () => ws as unknown as Workspace, env.dir)
    expect(await handlers.get('telegram:status')!()).toEqual({ configured: true, enabled: false, paired: true, issue: '' })
    await handlers.get('telegram:setEnabled')!(undefined, true)
    expect(telegramAvailable(env.dir)).toBe(true)
  } finally { stop() }
})

it('4/5. sends the actionable guarded wait once, skips a stale queued reminder and resolves a paired reply', async () => {
  env.dir = mkdtempSync(join(tmpdir(), 'telegram-guarded-wait-'))
  vi.useFakeTimers()
  writeFileSync(join(env.dir, 'telegram.enc'), JSON.stringify({ token: 'test-only', enabled: true, chat: 17, offset: 0, since: '', routes: {} }))
  const { ws } = boardFixture()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const outbound: unknown[] = []
  let updates: unknown[] = []
  vi.stubGlobal('fetch', async (url: string, options: { body: string }) => {
    if (url.endsWith('sendMessage')) outbound.push(JSON.parse(options.body))
    return { ok: true, json: async () => ({ ok: true, result: url.endsWith('getUpdates') ? updates.splice(0) : { message_id: 82 } }) }
  })
  const stop = startTelegram({ handle: handlers.set.bind(handlers) } as unknown as IpcMain, () => [], () => ws as unknown as Workspace, env.dir)
  const stale = randomUUID()
  const current = randomUUID()
  let reengaged: (() => void) | undefined
  const replyObserved = new Promise<void>(resolve => { reengaged = resolve })
  const closeStale = openHumanWait(env.dir, stale, () => {})
  const closeCurrent = openHumanWait(env.dir, current, () => reengaged?.())
  try {
    const body = 'Approve the blue fixture rollout?\n\nWhy this is blocking progress: Deployment may not start until you approve the target.'
    askHuman(env.dir, 'fixture-project', 'Do not send this stale request', stale)
    closeStale()
    expect(() => askHuman(env.dir, 'fixture-project', 'Old wake', stale)).toThrow('This human wait has ended')
    expect(askHuman(env.dir, 'fixture-project', body, current)).toEqual({ state: 'queued', questionId: current })
    expect(() => askHuman(env.dir, 'fixture-project', body, current)).toThrow('already has a contact attempt')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(humanAnswer(env.dir, 'fixture-project', stale).state).toBe('cancelled')
    expect(outbound).toEqual([{ chat_id: 17, text: `fixture-project\n\n${body}`, reply_markup: { force_reply: true } }])
    updates = [update(1, 17, 'Not approved', 82)]
    await vi.advanceTimersByTimeAsync(5_000)
    await replyObserved
    expect(humanAnswer(env.dir, 'fixture-project', current)).toEqual({ state: 'answered', answer: 'Not approved' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(outbound).toHaveLength(1)
  } finally {
    closeStale()
    closeCurrent()
    stop()
  }
})
