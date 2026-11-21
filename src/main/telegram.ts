import { app, safeStorage, type IpcMain } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Workspace } from '../core/workspace'

interface Route { folder: string; cardId: string; question: string }
interface Config {
  token: string
  chat?: number
  since: string
  offset: number
  routes: Record<string, Route>
}
interface Update {
  update_id: number
  message?: { chat: { id: number; type: string }; from?: { id: number }; text?: string; reply_to_message?: { message_id: number } }
}

async function call<T>(token: string, method: string, body: object): Promise<T> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    })
    const json = await response.json() as { ok: boolean; result: T }
    if (response.ok && json.ok) return json.result
  } catch { /* Never propagate a URL containing the credential. */ }
  throw new Error('Telegram request failed. Check the token and connection.')
}

export function startTelegram(ipc: Pick<IpcMain, 'handle'>, folders: () => string[], workspace: (path: string) => Workspace): () => void {
  const file = join(app.getPath('userData'), 'telegram.enc')
  let config: Config | undefined
  let issue = ''
  let code = ''
  let expires = 0
  let stopped = false
  try {
    if (existsSync(file)) config = JSON.parse(safeStorage.decryptString(readFileSync(file)))
  } catch { issue = 'Could not read Telegram configuration.' }
  function save(value: Config): void {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('A protected OS credential store is required.')
    }
    writeFileSync(file + '.tmp', safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 })
    renameSync(file + '.tmp', file)
    config = value
  }
  ipc.handle('telegram:status', () => ({ configured: !!config, paired: !!config?.chat, issue }))
  ipc.handle('telegram:pair', async (_, token: unknown) => {
    if (typeof token !== 'string' || !/^\d{4,20}:[\w-]{25,100}$/.test(token)) throw new Error('Invalid Telegram token.')
    await call(token, 'getMe', {})
    save({ token, since: new Date().toISOString(), offset: 0, routes: {} })
    issue = ''
    code = randomBytes(12).toString('hex')
    expires = Date.now() + 600000
    return code
  })
  async function tick(c: Config): Promise<void> {
    const updates = await call<Update[]>(c.token, 'getUpdates', { offset: c.offset, allowed_updates: ['message'] })
    for (const u of updates) {
      if (config !== c || stopped) return
      const m = u.message
      if (m && m.chat.type === 'private' && m.chat.id === m.from?.id && m.text) {
        if (!c.chat && code && Date.now() < expires && m.text === '/start ' + code) {
          c.chat = m.chat.id
          code = ''
        } else if (m.chat.id === c.chat && m.reply_to_message) {
          const route = c.routes[m.reply_to_message.message_id]
          if (route && folders().includes(route.folder)) {
            const ws = workspace(route.folder)
            const thread = await ws.listKanbanMessages({ cardId: route.cardId })
            if (thread.at(-1)?.id === route.question) {
              await ws.addKanbanMessage({ cardId: route.cardId, body: m.text, idempotencyKey: 'telegram-' + u.update_id })
            }
          }
        }
      }
      if (config !== c || stopped) return
      c.offset = u.update_id + 1
      save(c)
    }
    if (!c.chat) return
    for (const folder of folders()) {
      const ws = workspace(folder)
      const { lanes } = await ws.listKanbanCards({})
      for (const card of [...lanes.in_progress, ...lanes.ready_for_review]) {
        if (card.updatedAt < c.since) continue
        const question = (await ws.listKanbanMessages({ cardId: card.id })).at(-1)
        if (!question || question.createdAt < c.since || question.authorRole === 'desktop' || !/\?|^@human\b/i.test(question.body)) continue
        if (Object.values(c.routes).some(r => r.question === question.id)) continue
        if (config !== c || stopped) return
        const sent = await call<{ message_id: number }>(c.token, 'sendMessage', {
          chat_id: c.chat, text: (card.key + ' · ' + card.title + '\n\n' + question.body).slice(0, 4000),
          reply_markup: { force_reply: true }
        })
        if (config !== c || stopped) return
        c.routes[sent.message_id] = { folder, cardId: card.id, question: question.id }
        save(c)
      }
    }
  }
  let busy = false
  const timer = setInterval(async () => {
    if (!config || busy) return
    busy = true
    try { await tick(config); issue = '' } catch { issue = 'Notification sync failed. Retrying.' }
    finally { busy = false }
  }, 5000)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}
