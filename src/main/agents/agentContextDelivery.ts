import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { boardContextText, contextReceipts, CONTEXT_OUTBOX_FILE, type BoardContextBody, type ContextReceiptIndex, type PeerContextBody } from '../../../resources/skitarii/extension/contextDelivery'
import type { ChatRecord } from '../../shared/agents/chat'
import type { AgentView } from '../../shared/desktop/api'
import { claudeSessionFiles } from '../terminals/claudeSession'
import { ompFilePaths } from '../terminals/ompSession'
import { writePrivateFile } from '../terminals/privateFile'
import type { TerminalListener, TerminalSessions } from '../terminals/terminalSessions'
import type { ConversationDeliveries, ConversationDelivery } from './conversationDeliveries'
import type { ChatStore } from './chatStore'

interface DeliveryOptions {
  userData: string
  deliveries: ConversationDeliveries
  agentKind(chat: ChatRecord): AgentView['kind']
  now?: () => string
  env?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  readTranscript?: (file: string) => string
  writeOutbox?: (file: string, text: string) => Promise<void>
}

export interface BoardContextTransport {
  resolveFolder(folder: string): string | null
  getChat: ChatStore['getChat']
  resume(chat: ChatRecord): Promise<string | null>
  paste(chat: ChatRecord, message: BoardContextBody): Promise<string | null>
}

/** Same-chat background activation, shared by peer and board delivery monitors. */
export async function resumeContextChat(terminals: Pick<TerminalSessions, 'attach' | 'detach'>, chat: ChatRecord): Promise<string | null> {
  let finish!: (problem: string | null) => void
  const startEnded = new Promise<string | null>((resolve) => { finish = resolve })
  const listener: TerminalListener = (event) => {
    if (event.kind === 'started') finish(null)
    else if (event.kind === 'not_started') finish(event.message)
    else if (event.kind === 'exited') finish(event.message ?? 'The recipient terminal exited before startup completed.')
  }
  try {
    const result = await terminals.attach(chat, listener)
    if (result.state === 'checking') return await startEnded
    return result.state === 'running' ? null : result.message
  } finally {
    terminals.detach(chat.id, listener)
  }
}
export interface AgentContextDelivery {
  hasMessage(chat: ChatRecord, message: PeerContextBody): boolean
  /** Exact persisted user input, not a PTY paste/argument bookkeeping bit. */
  hasInput(chat: ChatRecord, text: string): boolean
  hasRecoveryMessage(chat: ChatRecord, message: BoardContextBody): boolean
  queueRecovery(chat: ChatRecord, message: BoardContextBody): Promise<void>
  hasBoardMessage(chat: ChatRecord, messageId: string, text: string): boolean
  queueBoard(chat: ChatRecord, message: BoardContextBody): Promise<void>
  pendingBoard(chat: ChatRecord): BoardContextBody[]
  publishBoard(chat: ChatRecord): Promise<void>
  reconcileBoard(folder: string, transport: BoardContextTransport): Promise<void>
  reserveBoardInput(chat: ChatRecord, messageId: string, content: string): boolean
}
interface CachedFile { stamp: string; receipts: ContextReceiptIndex }
const UNVERIFIED_BOARD_INPUT = 'A host input attempt is unverified; automatic replay is paused to avoid duplicate turns.'
const MAIN_SESSION = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f-]+\.jsonl$/i

function fileStamp(file: string): string {
  const stat = statSync(file, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}

/** One machine-local observer. Only host JSONL entries, never PTY writes or send return values, mint proof. */
export function createAgentContextDelivery(options: DeliveryOptions): AgentContextDelivery {
  return new ContextDeliveryService(options)
}

function ompSessionFiles(userData: string, chatId: string): string[] {
  const dir = ompFilePaths(userData, chatId).sessionDir
  try {
    return readdirSync(dir).filter((name) => MAIN_SESSION.test(name)).sort().map((name) => join(dir, name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return []
  }
}

function sameRecipient(latest: ChatRecord | null, chat: ChatRecord): latest is ChatRecord {
  return latest !== null && latest.agent === chat.agent && latest.endpointId === chat.endpointId && latest.sessionId === chat.sessionId
}

class ContextDeliveryService implements AgentContextDelivery {
  readonly #files = new Map<string, CachedFile>()
  readonly #publications = new Map<string, Promise<void>>()
  readonly #reconciling = new Set<string>()

  constructor(private readonly options: DeliveryOptions) {}

  #now(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }

  #paths(chat: ChatRecord): string[] {
    const kind = this.options.agentKind(chat)
    if (kind === 'omp') return ompSessionFiles(this.options.userData, chat.id)
    if (kind !== 'claude' || chat.folder === null || chat.sessionId === null) return []
    return claudeSessionFiles({ env: this.options.env ?? process.env, platform: this.options.platform ?? process.platform,
      folder: chat.folder, sessionId: chat.sessionId })
  }

  #fileReceipt(chat: ChatRecord, file: string): ContextReceiptIndex | null {
    try {
      const kind = this.options.agentKind(chat)
      const stamp = `${kind}:${chat.sessionId ?? ''}:${fileStamp(file)}`
      let cached = this.#files.get(file)
      if (cached?.stamp !== stamp) {
        const text = this.options.readTranscript === undefined ? readFileSync(file, 'utf8') : this.options.readTranscript(file)
        cached = { stamp, receipts: contextReceipts(text, kind === 'claude' ? chat.sessionId! : undefined) }
        // Keep the pre-read stamp: an append racing this read must invalidate the next observation.
        this.#files.set(file, cached)
      }
      return cached.receipts
    } catch (error) {
      this.#files.delete(file)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return null
    }
  }

  #receiptsFor(chat: ChatRecord): ContextReceiptIndex[] {
    const receipts: ContextReceiptIndex[] = []
    for (const file of this.#paths(chat)) {
      const found = this.#fileReceipt(chat, file)
      if (found !== null) receipts.push(found)
    }
    return receipts
  }

  #hash(chat: ChatRecord, source: 'peer' | 'board', value: unknown): string {
    return createHash('sha256').update(JSON.stringify({ folder: chat.folder, chatId: chat.id, source, value })).digest('hex')
  }

  #observed(chat: ChatRecord, source: 'peer' | 'board', messageId: string, bodyHash: string): boolean {
    if (chat.folder === null) return false
    const proof = this.options.deliveries.proof(chat.folder, chat.id, source, messageId)
    return proof?.state === 'delivered' && proof.bodyHash === bodyHash && proof.entryId !== undefined
  }

  hasInput(chat: ChatRecord, text: string): boolean {
    return this.#receiptsFor(chat).some(receipts => receipts.people.has(text))
  }

  hasRecoveryMessage(chat: ChatRecord, message: BoardContextBody): boolean {
    for (const receipts of this.#receiptsFor(chat)) {
      const found = receipts.recoveries.get(message.id)
      if (found?.text === message.text) return true
      // Terminal-only hosts have no attributed peer API: the exact input is explicitly marked peer data.
      if (this.options.agentKind(chat) === 'claude' && receipts.people.has(message.text)) return true
    }
    return false
  }

  async queueRecovery(chat: ChatRecord, message: BoardContextBody): Promise<void> {
    const folder = chat.folder ?? 'projectless'
    const prior = this.options.deliveries.proof(folder, chat.id, 'recovery', message.id)
    if (prior !== undefined && prior.text !== message.text) throw new Error('Recovery message identity conflicts with its accepted body.')
    if (this.hasRecoveryMessage(chat, message)) {
      this.options.deliveries.record({ folder, chatId: chat.id, source: 'recovery', messageId: message.id,
        text: message.text, state: 'delivered', problem: null, at: this.#now() })
    } else if (prior === undefined) {
      this.options.deliveries.record({ folder, chatId: chat.id, source: 'recovery', messageId: message.id,
        text: message.text, state: 'pending', problem: null, at: this.#now() })
    }
  }

  hasMessage(chat: ChatRecord, message: PeerContextBody): boolean {
    const bodyHash = this.#hash(chat, 'peer', { id: message.id, seq: message.seq, body: message.body })
    if (this.#observed(chat, 'peer', message.id, bodyHash)) return true
    for (const receipts of this.#receiptsFor(chat)) {
      const found = receipts.peers.get(message.id)
      if (found?.seq !== message.seq || found.body !== message.body) continue
      if (chat.folder !== null) this.options.deliveries.record({ folder: chat.folder, chatId: chat.id, source: 'peer',
        messageId: message.id, bodyHash, entryId: found.entryId, state: 'delivered', problem: null, at: this.#now() })
      return true
    }
    return false
  }

  hasBoardMessage(chat: ChatRecord, messageId: string, text: string): boolean {
    const bodyHash = this.#hash(chat, 'board', { id: messageId, text })
    if (this.#observed(chat, 'board', messageId, bodyHash)) return true
    const content = boardContextText({ id: messageId, text })
    for (const receipts of this.#receiptsFor(chat)) {
      const entryId = receipts.people.get(content)
      if (entryId === undefined) continue
      if (chat.folder !== null) this.options.deliveries.record({ folder: chat.folder, chatId: chat.id, source: 'board',
        messageId, bodyHash, entryId, state: 'delivered', problem: null, at: this.#now() })
      return true
    }
    return false
  }

  pendingBoard(chat: ChatRecord): BoardContextBody[] {
    return this.options.deliveries.pending()
      .filter((entry) => entry.source !== 'recovery' && entry.folder === chat.folder && entry.chatId === chat.id && entry.text !== undefined)
      .map((entry) => ({ id: entry.messageId, text: entry.text! }))
  }

  async #publishSnapshot(chat: ChatRecord): Promise<void> {
    const outbox = join(this.options.userData, 'agents', 'omp', chat.id, CONTEXT_OUTBOX_FILE)
    const text = JSON.stringify({ version: 1, chatId: chat.id, endpointId: chat.endpointId, messages: this.pendingBoard(chat) })
    if (this.options.writeOutbox !== undefined) await this.options.writeOutbox(outbox, text)
    else await writePrivateFile(outbox, text, 0o600)
  }

  async publishBoard(chat: ChatRecord): Promise<void> {
    if (this.options.agentKind(chat) !== 'omp') return
    if (chat.endpointId === undefined) throw new Error('The recipient mailbox is not provisioned; person messages remain pending.')
    const key = `${chat.folder}\0${chat.id}`
    const prior = this.#publications.get(key) ?? Promise.resolve()
    const publication = prior.catch(() => {
      // The previous caller observes its failure; retained pending bodies allow this independent publication to recover.
    }).then(() => this.#publishSnapshot(chat))
    this.#publications.set(key, publication)
    try {
      await publication
    } finally {
      if (this.#publications.get(key) === publication) this.#publications.delete(key)
    }
  }

  reserveBoardInput(chat: ChatRecord, messageId: string, content: string): boolean {
    if (chat.folder === null) throw new Error('A board input must belong to its tracked folder.')
    const pending = this.options.deliveries.proof(chat.folder, chat.id, 'board', messageId)
    if (pending?.state === 'delivered' || pending?.inputUncertain === true) return false
    if (pending?.state !== 'pending' || pending.text === undefined || boardContextText({ id: messageId, text: pending.text }) !== content) {
      throw new Error('No exact durable pending person body belongs to this recipient input.')
    }
    this.options.deliveries.record({ ...pending, inputUncertain: true, problem: UNVERIFIED_BOARD_INPUT, at: this.#now() })
    return true
  }

  #updateProblem(entry: ConversationDelivery, problem: string | null): void {
    if (entry.chatId === null) return
    const current = this.options.deliveries.proof(entry.folder, entry.chatId, 'board', entry.messageId)
    if (current?.state === 'pending' && current.problem !== problem) {
      this.options.deliveries.record({ ...current, problem, at: this.#now() })
    }
  }

  async #deliverBoard(entry: ConversationDelivery, chat: ChatRecord, transport: BoardContextTransport): Promise<void> {
    const message = { id: entry.messageId, text: entry.text! }
    if (this.hasBoardMessage(chat, message.id, message.text)) {
      await this.publishBoard(chat)
      return
    }
    if (this.options.deliveries.proof(entry.folder, chat.id, 'board', message.id)?.inputUncertain === true) {
      this.#updateProblem(entry, UNVERIFIED_BOARD_INPUT)
      return
    }
    const omp = this.options.agentKind(chat) === 'omp'
    if (omp) await this.publishBoard(chat)
    if (transport.resolveFolder(entry.folder) !== entry.folder) return
    const latest = transport.getChat({ folder: entry.folder, id: chat.id })
    if (!sameRecipient(latest, chat)) return
    const problem = omp ? await transport.resume(latest) : await transport.paste(latest, message)
    const current = transport.getChat({ folder: entry.folder, id: chat.id })
    if (current !== null && this.hasBoardMessage(current, message.id, message.text)) await this.publishBoard(current)
    else this.#updateProblem(entry, problem)
  }

  async #reconcileEntry(entry: ConversationDelivery, transport: BoardContextTransport): Promise<void> {
    if (entry.chatId === null || entry.text === undefined) return
    try {
      const chat = transport.getChat({ folder: entry.folder, id: entry.chatId })
      if (chat === null) {
        this.#updateProblem(entry, 'The selected recipient chat no longer exists; the saved message was not sent elsewhere.')
        return
      }
      await this.#deliverBoard(entry, chat, transport)
    } catch (error) {
      this.#updateProblem(entry, error instanceof Error ? error.message : String(error))
    }
  }

  async reconcileBoard(folder: string, transport: BoardContextTransport): Promise<void> {
    if (this.#reconciling.has(folder) || transport.resolveFolder(folder) !== folder) return
    this.#reconciling.add(folder)
    try {
      for (const entry of this.options.deliveries.pending()) {
        if (entry.source === 'recovery') continue
        if (entry.folder !== folder) continue
        if (transport.resolveFolder(folder) !== folder) return
        await this.#reconcileEntry(entry, transport)
      }
    } finally {
      this.#reconciling.delete(folder)
    }
  }

  #assertBoardIdentity(prior: ConversationDelivery, chat: ChatRecord, message: BoardContextBody, bodyHash: string): void {
    if (prior.chatId !== chat.id || (prior.text !== undefined && prior.text !== message.text) ||
      (prior.bodyHash !== undefined && prior.bodyHash !== bodyHash)) {
      throw new Error('The accepted board message identity belongs to a different body or recipient.')
    }
  }

  async queueBoard(chat: ChatRecord, message: BoardContextBody): Promise<void> {
    if (chat.folder === null) throw new Error('A board message must belong to its tracked folder.')
    const prior = this.options.deliveries.forMessages(chat.folder, [message.id]).get(message.id)
    const bodyHash = this.#hash(chat, 'board', { id: message.id, text: message.text })
    if (prior !== undefined) {
      this.#assertBoardIdentity(prior, chat, message, bodyHash)
      if (this.#observed(chat, 'board', message.id, bodyHash)) return
    }
    if (prior?.state !== 'pending') {
      this.options.deliveries.record({ folder: chat.folder, chatId: chat.id, messageId: message.id, source: 'board',
        state: 'pending', text: message.text, bodyHash, problem: null, at: this.#now() })
    }
    await this.publishBoard(chat)
  }
}
