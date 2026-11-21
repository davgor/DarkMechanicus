import { app, clipboard, safeStorage, type IpcMain } from 'electron'
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

type FolderList = () => string[]
type WorkspaceFor = (path: string) => Workspace

export function registerTelegramIpc(ipc: Pick<IpcMain, 'handle'>, status: () => unknown, pair: () => Promise<string>): void {
  ipc.handle('telegram:status', status)
  ipc.handle('telegram:pair', pair)
}

class TelegramHost {
  private file = join(app.getPath('userData'), 'telegram.enc')
  config?: Config
  issue = ''
  stopped = false
  private code = ''
  private expires = 0

  constructor(private folders: FolderList, private workspace: WorkspaceFor) {
    try {
      if (existsSync(this.file)) this.config = JSON.parse(safeStorage.decryptString(readFileSync(this.file)))
    } catch { this.issue = 'Could not read Telegram configuration.' }
  }
  save(value: Config): void {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('A protected OS credential store is required.')
    }
    writeFileSync(this.file + '.tmp', safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 })
    renameSync(this.file + '.tmp', this.file)
    this.config = value
  }

  async pair(): Promise<string> {
    const token = clipboard.readText().trim()
    if (typeof token !== 'string' || !/^\d{4,20}:[\w-]{25,100}$/.test(token)) throw new Error('Invalid Telegram token.')
    await call(token, 'getMe', {})
    this.save({ token, since: new Date().toISOString(), offset: 0, routes: {} })
    this.issue = ''
    this.code = randomBytes(12).toString('hex')
    this.expires = Date.now() + 600000
    return this.code

  }

  private current(c: Config): boolean { return this.config === c && !this.stopped }

  private acceptPairing(c: Config, chatId: number, text: string): void {
      if (Date.now() < this.expires && text === '/start ' + this.code) {
        c.chat = chatId
        this.code = ''
      }
  }

  private async receive(c: Config, update: Update): Promise<void> {
    const m = update.message
    if (!m || m.chat.type !== 'private' || m.chat.id !== m.from?.id || !m.text) return
    if (!c.chat) {
      this.acceptPairing(c, m.chat.id, m.text)
      return
    }
    if (m.chat.id !== c.chat || !m.reply_to_message) return
    const route = c.routes[m.reply_to_message.message_id]
    if (route) await this.reply(c, route, m.text, update.update_id)
  }

  private async reply(c: Config, route: Route, body: string, update: number): Promise<void> {
    if (!this.folders().includes(route.folder)) return
    const ws = this.workspace(route.folder)
    const thread = await ws.listKanbanMessages({ cardId: route.cardId })
    if (this.current(c) && thread.at(-1)?.id === route.question) {
      await ws.addKanbanMessage({ cardId: route.cardId, body, idempotencyKey: 'telegram-' + update })
    }
  }

  private async notify(c: Config, folder: string, card: { id: string; key: string; title: string }): Promise<void> {
    const question = (await this.workspace(folder).listKanbanMessages({ cardId: card.id })).at(-1)
    if (!question || question.createdAt < c.since || question.authorRole === 'desktop') return
    if (!/\?|^@human\b/i.test(question.body) || !this.current(c)) return
    if (Object.values(c.routes).some(r => r.question === question.id)) return
    const sent = await call<{ message_id: number }>(c.token, 'sendMessage', {
      chat_id: c.chat, text: (card.key + ' · ' + card.title + '\n\n' + question.body).slice(0, 4000),
      reply_markup: { force_reply: true }
    })
    if (!this.current(c)) return
    c.routes[sent.message_id] = { folder, cardId: card.id, question: question.id }
    this.save(c)
  }

  async tick(c: Config): Promise<void> {
    const updates = await call<Update[]>(c.token, 'getUpdates', { offset: c.offset, allowed_updates: ['message'] })
    for (const update of updates) {
      if (!this.current(c)) return
      await this.receive(c, update)
      if (!this.current(c)) return
      c.offset = update.update_id + 1
      this.save(c)
    }
    if (!c.chat) return
    for (const folder of this.folders()) {
      const { lanes } = await this.workspace(folder).listKanbanCards({})
      for (const card of [...lanes.in_progress, ...lanes.ready_for_review]) {
        if (card.updatedAt >= c.since) await this.notify(c, folder, card)
      }
    }
  }
}

export function startTelegram(ipc: Pick<IpcMain, 'handle'>, folders: FolderList, workspace: WorkspaceFor): () => void {
  const host = new TelegramHost(folders, workspace)
  registerTelegramIpc(ipc, () => ({ configured: !!host.config, paired: !!host.config?.chat, issue: host.issue }), () => host.pair())
  let busy = false
  const timer = setInterval(async () => {
    if (!host.config || busy) return
    busy = true
    try { await host.tick(host.config); host.issue = '' } catch { host.issue = 'Notification sync failed. Retrying.' }
    finally { busy = false }
  }, 5000)
  timer.unref()
  return () => { host.stopped = true; clearInterval(timer) }
}
