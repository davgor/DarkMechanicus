import { app, clipboard, safeStorage, type IpcMain } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { questionStore, publishChannel } from '../core/humanQuestions'
import type { Db } from '../core/db/database'
import { createHash, randomBytes } from 'node:crypto'
import type { ProjectWorkspace } from './desktop/workspaceClient'
import { humanWaitCurrent, removeHumanWait } from '../../resources/skitarii/extension/humanWaitLease'

interface Route { folder: string; cardId: string; question: string }
interface Config {
  token: string
  enabled?: boolean
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

function recipientKey(c: Config): string {
  return createHash('sha256').update(c.token + '/' + c.chat).digest('hex')
}

type FolderList = () => string[]
type WorkspaceFor = (path: string) => Pick<ProjectWorkspace, 'listKanbanMessages' | 'addKanbanMessage'>

export function registerTelegramIpc(ipc: Pick<IpcMain, 'handle'>, status: () => unknown, pair: () => Promise<string>, setEnabled: (enabled: boolean) => void): void {
  ipc.handle('telegram:status', status)
  ipc.handle('telegram:pair', pair)
  ipc.handle('telegram:setEnabled', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Expected a boolean.')
    setEnabled(enabled)
  })
}

class TelegramHost {
  private file = join(app.getPath('userData'), 'telegram.enc')
  config?: Config
  issue = ''
  stopped = false
  private code = ''
  private expires = 0

  constructor(private folders: FolderList, private workspace: WorkspaceFor, private db: Db, private home: string) {
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
    this.heartbeat()
  }

  heartbeat(): void {
    publishChannel(this.db, !!this.config?.chat && this.config.enabled !== false && !this.stopped)
  }

  setEnabled(enabled: boolean): void {
    if (!this.config) throw new Error('Pair Telegram first.')
    this.save({ ...this.config, enabled, since: new Date().toISOString() })
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
    if (m.chat.id !== c.chat || !m.reply_to_message || c.enabled === false) return
    await this.routeReply(c, m.reply_to_message.message_id, m.text, update.update_id)
  }

  private async routeReply(c: Config, messageId: number, text: string, updateId: number): Promise<void> {
    const answered = this.db.get<{ id: string }>(
      "UPDATE questions SET state='answered', answer=? WHERE recipient=? AND message=? AND state='sent' RETURNING id",
      text, recipientKey(c), messageId)
    if (answered) {
      removeHumanWait(this.home, answered.id)
      return
    }
    const route = c.routes[messageId]
    if (route) await this.reply(c, route, text, updateId)
  }

  private async reply(c: Config, route: Route, body: string, update: number): Promise<void> {
    if (!this.folders().includes(route.folder)) return
    const ws = this.workspace(route.folder)
    const thread = await ws.listKanbanMessages({ cardId: route.cardId })
    if (this.current(c) && thread.at(-1)?.id === route.question) {
      await ws.addKanbanMessage({ cardId: route.cardId, body, idempotencyKey: 'telegram-' + update })
    }
  }

  private async deliverQuestion(c: Config): Promise<void> {
    const pending = this.db.tx(() => {
      for (;;) {
        const row = this.db.get<{ id: string; repo: string; question: string; state: string }>(
          "SELECT id,repo,question,state FROM questions WHERE state IN ('queued','wait_queued') ORDER BY created LIMIT 1")
        if (!row) return undefined
        const current = row.state === 'queued' || humanWaitCurrent(this.home, row.id)
        this.db.run('UPDATE questions SET state=? WHERE id=?', current ? 'sending' : 'cancelled', row.id)
        if (current) return row
      }
    })
    if (!pending) return
    try {
      const sent = await call<{ message_id: number }>(c.token, 'sendMessage', {
        chat_id: c.chat, text: basename(pending.repo).slice(0, 200) + '\n\n' + pending.question,
        reply_markup: { force_reply: true }
      })
      this.db.run("UPDATE questions SET state='sent', recipient=?, message=? WHERE id=?",
        recipientKey(c), sent.message_id, pending.id)
    } catch (error) {
      this.db.run("UPDATE questions SET state='delivery_unknown' WHERE id=?", pending.id)
      throw error
    }
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
    if (!c.chat || !this.current(c) || c.enabled === false) return
    await this.deliverQuestion(c)

  }
}

export function startTelegram(ipc: Pick<IpcMain, 'handle'>, folders: FolderList, workspace: WorkspaceFor, home: string): () => void {
  const db = questionStore(home)
  db.run("UPDATE questions SET state='delivery_unknown' WHERE state='sending'")
  const host = new TelegramHost(folders, workspace, db, home)
  host.heartbeat()
  registerTelegramIpc(ipc, () => ({ configured: !!host.config, paired: !!host.config?.chat, enabled: !!host.config && host.config.enabled !== false, issue: host.issue }), () => host.pair(), enabled => host.setEnabled(enabled))
  let busy = false
  const timer = setInterval(async () => {
    host.heartbeat()
    if (!host.config || host.config.enabled === false || busy) return
    busy = true
    try { await host.tick(host.config); host.issue = '' } catch { host.issue = 'Notification sync failed. Retrying.' }
    finally { busy = false; if (host.stopped) db.close() }
  }, 5000)
  timer.unref()
  return () => { host.stopped = true; clearInterval(timer); host.heartbeat(); if (!busy) db.close() }
}
