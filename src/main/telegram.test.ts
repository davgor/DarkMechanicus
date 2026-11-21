import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import type { Workspace } from '../core/workspace'
import { startTelegram } from './telegram'

const env = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({
  clipboard: { readText: () => '12345:' + 'a'.repeat(32) },
  app: { getPath: () => env.dir },
  safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test', encryptString: Buffer.from }
}))

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(env.dir, { recursive: true, force: true }) })

it('pairs one private user and routes only their threaded reply to the original card', async () => {
  env.dir = mkdtempSync(join(tmpdir(), 'telegram-test-'))
  vi.useFakeTimers()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipc = { handle: handlers.set.bind(handlers) } as unknown as IpcMain
  const now = '2099-01-01T00:00:00Z'
  const ws = {
    listKanbanCards: async () => ({ lanes: { in_progress: [{ id: 'card', key: 'DM-1', title: 'Build', updatedAt: now }], ready_for_review: [] } }),
    listKanbanMessages: async () => [{ id: 'question', body: 'Which target?', authorRole: 'worker', createdAt: now }],
    addKanbanMessage: vi.fn()
  }
  let updates: unknown[] = []
  const outbound: unknown[] = []
  function send(body: string) { outbound.push(JSON.parse(body)); return { message_id: 81 } }
  vi.stubGlobal('fetch', async (url: string, options: { body: string }) => ({
    ok: true, json: async () => ({ ok: true, result: url.endsWith('getUpdates') ? updates.splice(0) : url.endsWith('sendMessage') ? send(options.body) : {} })
  }))
  const stop = startTelegram(ipc, () => ['folder'], () => ws as unknown as Workspace)
  try {
    const code = await handlers.get('telegram:pair')!()
    const update = (id: number, who: number, text: string) => ({
      update_id: id, message: { chat: { type: 'private', id: who }, from: { id: who }, text, reply_to_message: { message_id: 81 } }
    })
    updates = [update(1, 17, '/start ' + code)]
    await vi.advanceTimersByTimeAsync(5000)
    expect(outbound).toEqual([{ chat_id: 17, text: 'DM-1 · Build\n\nWhich target?', reply_markup: { force_reply: true } }])
    updates = [update(2, 18, 'unpaired'), update(3, 17, 'Windows')]
    await vi.advanceTimersByTimeAsync(5000)
    expect(ws.addKanbanMessage).toHaveBeenCalledExactlyOnceWith({ cardId: 'card', body: 'Windows', idempotencyKey: 'telegram-3' })
    expect(await handlers.get('telegram:status')!()).toEqual({ configured: true, paired: true, issue: '' })
  } finally { stop() }
})
