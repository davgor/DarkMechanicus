import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import type { Workspace } from '../core/workspace'
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
  const question = { id: 'question', body: 'Which target?', authorRole: 'worker', createdAt: now }
  const history: Record<string, typeof question[]> = {
    card: [question], old: [{ ...question, id: 'old', createdAt: '2000' }],
    person: [{ ...question, id: 'person', authorRole: 'desktop' }],
    note: [{ ...question, id: 'note', body: 'Working' }], empty: []
  }
  const replies: unknown[] = []
  const ws = {
    listKanbanCards: async () => ({ lanes: { in_progress: Object.keys(history).map(id => ({ ...card, id })), ready_for_review: [] } }),
    listKanbanMessages: async ({ cardId }: { cardId: string }) => history[cardId],
    addKanbanMessage: async (reply: unknown) => { replies.push(reply) }
  }
  return { history, replies, ws, question }
}

it('pairs one private user and routes only their threaded reply to the original card', async () => {
  env.dir = mkdtempSync(join(tmpdir(), 'telegram-test-'))
  vi.useFakeTimers()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipc = { handle: handlers.set.bind(handlers) } as unknown as IpcMain
  const { history, replies, ws, question } = boardFixture()
  let updates: unknown[] = []
  const outbound: unknown[] = []
  function send(body: string) { outbound.push(JSON.parse(body)); return { message_id: 81 } }
  vi.stubGlobal('fetch', async (url: string, options: { body: string }) => ({
    ok: true, json: async () => ({ ok: true, result: url.endsWith('getUpdates') ? updates.splice(0) : url.endsWith('sendMessage') ? send(options.body) : {} })
  }))
  let stop = startTelegram(ipc, () => ['folder'], () => ws as unknown as Workspace)
  try {
    env.token = 'invalid'
    await expect(handlers.get('telegram:pair')!()).rejects.toThrow('Invalid Telegram token')
    env.token = '12345:' + 'a'.repeat(32)
    env.encryption = false
    await expect(handlers.get('telegram:pair')!()).rejects.toThrow('protected OS credential store')
    env.encryption = true
    const code = await handlers.get('telegram:pair')!()
    const update = (id: number, who: number, text: string) => ({
      update_id: id, message: { chat: { type: 'private', id: who }, from: { id: who }, text, reply_to_message: { message_id: 81 } }
    })
    updates = [update(0, 18, '/start wrong')]
    await vi.advanceTimersByTimeAsync(5000)
    expect(outbound).toEqual([])
    expect(await handlers.get('telegram:status')!()).toEqual({ configured: true, paired: false, issue: '' })
    updates = [update(1, 17, '/start ' + code)]
    await vi.advanceTimersByTimeAsync(5000)
    expect(outbound).toEqual([{ chat_id: 17, text: 'DM-1 · Build\n\nWhich target?', reply_markup: { force_reply: true } }])
    updates = [update(2, 18, 'unpaired'), update(3, 17, 'Windows')]
    await vi.advanceTimersByTimeAsync(5000)
    expect(replies).toEqual([{ cardId: 'card', body: 'Windows', idempotencyKey: 'telegram-3' }])
    stop()
    stop = startTelegram(ipc, () => ['folder'], () => ws as unknown as Workspace)
    history.card = [{ ...question, authorRole: 'desktop', id: 'answered' }]
    updates = [update(4, 17, 'late')]
    await vi.advanceTimersByTimeAsync(5000)
    expect(outbound).toHaveLength(1)
    expect(replies).toHaveLength(1)
    expect(await handlers.get('telegram:status')!()).toEqual({ configured: true, paired: true, issue: '' })
  } finally { stop() }
})
