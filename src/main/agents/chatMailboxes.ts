/**
 * The agent mailboxes of chats: which chats have one, and main's own calls (`mail.manage`, through the folder's desktop
 * workspace) that provision, bind, rename, suspend and delete them in the folder's database (`core/services/agentMail.ts`).
 *
 * **Who has one.** Only OMP (Skitarii) chats of a tracked folder, decided by the chat's stored agent id (a built-in id
 * equals its kind, a custom CLI's is `cu_…`) and, at a start, the connected agent's kind too. No other CLI's chat, no
 * project-less chat (it belongs to no folder's database), and no grant issued outside a chat start, is ever provisioned
 * or bound. Native subagents an OMP chat spawns inherit its grant, so they share their parent's mailbox on purpose.
 *
 * **Identity.** An endpoint is keyed by (this machine, chat id) in the folder's own database, so the same chat id in
 * two folders has two unrelated mailboxes, and provisioning the same chat again always returns the same opaque id: a
 * crash between the SQLite commit and the `endpointId` line in the chat index finds it again. A title is display
 * metadata: rename changes the endpoint's name, never its id; restart and New session keep both.
 *
 * **Trusted list.** Listing a folder's chats provisions every OMP chat's mailbox (a stopped or never-started chat can
 * receive) and resumes one suspended by an earlier untrack; no grant is bound by it. A chat whose mailbox is deleting
 * or deleted is never provisioned again: it is a deletion that did not finish, and its caller finishes it.
 *
 * **Bind before spawn.** `bindChatMailbox` binds a fresh grant (never a stored or restored one) to the chat's open
 * mailbox before its CLI is spawned (`chatGrants.ts`). The previous binding closes for good; a closed binding never
 * reopens, so a suspended mailbox only works again for a grant main issues after the folder is tracked again.
 *
 * **Delete.** `delete` durably records the irreversible deletion (creating the tombstone for a chat that never had a
 * mailbox, so a late start cannot create one) and purges the received mail before any file of the chat is removed.
 * Mail the chat sent stays with its recipients, showing a deleted sender. If storage cannot record it, `delete` throws
 * and the chat stays, so the deletion can be retried.
 *
 * **Ownership.** The ledger (`mailboxes.jsonl` next to the chats) remembers which (folder, chat id) pairs this
 * installation provisioned. At startup an open endpoint of a chat in the ledger with no chat record left (a restored
 * database, a lost index line) is deleted; an endpoint this installation never provisioned is left alone, never guessed.
 */
import { join } from 'node:path'
import { DomainError } from '../../core/errors'
import type { ProjectWorkspace } from '../desktop/workspaceClient'
import { hasMailbox, type MailboxChat } from './chatMailboxOperations'
export { hasMailbox, type MailboxChat } from './chatMailboxOperations'
import type { ChatRecord } from '../../shared/agents/chat'
import type { ChatStore, ChatStoreFs } from './chatStore'
import { hasForgeManifest } from '../desktop/forgeContext'

const MAILBOX_AGENT = 'omp'

/** The (folder, chat id) pairs this installation provisioned, from an append-only JSON-lines file. */
interface MailboxLedger {
  /** The chat ids this installation provisioned in `folder`; empty for none. */
  owned(folder: string, owner?: string): ReadonlySet<string>
  folders(owner: string): readonly string[]
  allOwned(folder: string): ReadonlySet<string>
  deleting(folder: string): ReadonlySet<string>
  markDeleted(folder: string, chatId: string, owner: string): void
  add(folder: string, chatId: string, owner?: string): void
}

function ledgerEntry(line: string): { folder: string; chatId: string; owner: string; deleted: boolean } | null {
  const entry = JSON.parse(line) as { folder?: unknown; chatId?: unknown; owner?: unknown; deleted?: unknown }
  if (typeof entry.folder !== 'string' || typeof entry.chatId !== 'string') return null
  return { folder: entry.folder, chatId: entry.chatId, owner: typeof entry.owner === 'string' ? entry.owner : entry.folder, deleted: entry.deleted === true }
}

class LocalMailboxLedger implements MailboxLedger {
  private loaded = false
  private readonly byFolder = new Map<string, Set<string>>()
  private readonly ownerFolders = new Map<string, Set<string>>()
  private readonly folderChats = new Map<string, Set<string>>()
  private readonly deleted = new Map<string, Set<string>>()
  constructor(private readonly fs: ChatStoreFs, private readonly file: string) {}
  private key(folder: string, owner = folder): string { return JSON.stringify([owner, folder]) }
  private remember(entry: NonNullable<ReturnType<typeof ledgerEntry>>): void {
    const key = this.key(entry.folder, entry.owner)
    this.byFolder.set(key, (this.byFolder.get(key) ?? new Set()).add(entry.chatId))
    this.ownerFolders.set(entry.owner, (this.ownerFolders.get(entry.owner) ?? new Set()).add(entry.folder))
    this.folderChats.set(entry.folder, (this.folderChats.get(entry.folder) ?? new Set()).add(entry.chatId))
    if (entry.deleted) this.deleted.set(entry.folder, (this.deleted.get(entry.folder) ?? new Set()).add(entry.chatId))
  }
  private load(): void {
    if (this.loaded) return
    let text = ''
    try {
      text = this.fs.readFile(this.file)
    } catch {
      // No ledger yet: this installation has provisioned nothing.
    }
    for (const line of text.split('\n')) {
      try {
        const entry = ledgerEntry(line)
        if (entry !== null) this.remember(entry)
      } catch {
        // A blank or truncated line is skipped; a pair it lost is added again the next time it is provisioned.
      }
    }
    this.loaded = true
  }
  owned(folder: string, owner = folder): ReadonlySet<string> { this.load(); return this.byFolder.get(this.key(folder, owner)) ?? new Set() }
  folders(owner: string): readonly string[] { this.load(); return [...this.ownerFolders.get(owner) ?? []] }
  allOwned(folder: string): ReadonlySet<string> { this.load(); return this.folderChats.get(folder) ?? new Set() }
  deleting(folder: string): ReadonlySet<string> { this.load(); return this.deleted.get(folder) ?? new Set() }
  private append(entry: NonNullable<ReturnType<typeof ledgerEntry>>): void {
    this.fs.mkdirp(join(this.file, '..'))
    this.fs.appendFile(this.file, `\n${JSON.stringify(entry)}\n`)
    this.remember(entry)
  }
  markDeleted(folder: string, chatId: string, owner: string): void {
    if (!this.deleting(folder).has(chatId)) this.append({ folder, chatId, owner, deleted: true })
  }
  add(folder: string, chatId: string, owner = folder): void {
    if (!this.owned(folder, owner).has(chatId)) this.append({ folder, chatId, owner, deleted: false })
  }
}

/** What reconciling a folder's chats with their mailboxes found. */
interface ReconciledChats {
  /** The chats to show, each with its mailbox id stored when it has one. */
  chats: ChatRecord[]
  /** Chats whose mailbox is deleting or deleted: deletions that did not finish, for the caller to finish. */
  deleting: ChatRecord[]
}

/** The chats' mailboxes, as main manages them (see the module comment). */
type MailWork<T> = T | Promise<T>

export interface ChatMailboxes {
  /** Persist ownership before a trusted root start binds a member endpoint, including conflict repair starts. */
  recordRoute(ownerFolder: string, memberFolder: string, chatId: string): void
  /** Archive suspension without changing any neighboring chat. */
  suspendChat(chat: ChatRecord): MailWork<void>
  /** Current usable member endpoints, without manufacturing a singular identity on a world chat. */
  routes(chat: ChatRecord, only?: string, background?: boolean): MailWork<readonly { folder: string; endpointId: string }[]>
  /** Provisions (and resumes) the OMP chats' mailboxes and stores their ids; never throws: a failure is logged and the chats are returned as they are. */
  reconcile(folder: string, chats: readonly ChatRecord[]): MailWork<ReconciledChats>
  /** `reconcile`, then deletes the open mailboxes this installation provisioned for chats that no longer exist. Never throws. */
  recover(folder: string, chats: readonly ChatRecord[]): MailWork<ReconciledChats>
  /** Renames the chat's mailbox to its title; never throws. */
  rename(chat: ChatRecord): MailWork<void>
  /** Deletes the chat's mailbox durably (see the module comment); throws when storage cannot record it. */
  delete(chat: ChatRecord): MailWork<void>
  /** Suspends the open mailboxes of the folder's chats (it is being untracked); their mail stays. Never throws. */
  suspendFolder(folder: string, chats: readonly ChatRecord[]): MailWork<void>
}

interface ChatMailboxesDeps {
  /** Initialized tracked members for a world; undefined for an ordinary folder. */
  membersFor?: (folder: string) => readonly string[] | undefined
  workspaceFor: (folder: string, background?: boolean) => ProjectWorkspace
  store: Pick<ChatStore, 'recordEndpoint'>
  /** The ledger file and the filesystem it is on. */
  ledger: { file: string; fs: ChatStoreFs }
  /** Told, in one line, of each mailbox change that could not be made. */
  log: (line: string) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A folder that was never set up for Dark Mechanicus has no database, so no mailbox: nothing to do there. */
function notInitialized(error: unknown): boolean {
  return error instanceof DomainError && error.code === 'not_initialized'
}

class ChatMailboxRegistry implements ChatMailboxes {
  private readonly ledger: MailboxLedger
  private readonly unreadable = new Set<string>()

  constructor(private readonly deps: ChatMailboxesDeps) {
    this.ledger = new LocalMailboxLedger(deps.ledger.fs, deps.ledger.file)
  }

  recordRoute(ownerFolder: string, memberFolder: string, chatId: string): void {
    if (this.ledger.deleting(memberFolder).has(chatId)) throw new DomainError('invalid_state', 'This world chat mailbox was deleted.')
    this.ledger.add(memberFolder, chatId, ownerFolder)
  }

  async suspendChat(chat: ChatRecord): Promise<void> {
    if (chat.folder === null || !hasMailbox(chat)) return
    const members = this.members(chat.folder)
    const folders = members === undefined ? [chat.folder] : [...new Set([...members, ...this.ledger.folders(chat.folder)])]
    for (const folder of folders) await this.suspendAt(folder, [chat])
  }

  async reconcile(folder: string, chats: readonly ChatRecord[]): Promise<ReconciledChats> {
    const members = this.members(folder)
    if (members !== undefined) {
      const deleting = new Set<string>()
      for (const member of members) {
        for (const chat of (await this.reconcileAt(member, chats, folder)).deleting) deleting.add(chat.id)
      }
      // A removed member is no longer a mail route, even if its old endpoint remains locally readable.
      if (!this.unreadable.has(folder)) for (const member of this.ledger.folders(folder).filter(path => !members.includes(path))) await this.suspendAt(member, chats)
      return { chats: chats.filter(chat => !deleting.has(chat.id)), deleting: chats.filter(chat => deleting.has(chat.id)) }
    }
    return this.reconcileAt(folder, chats)
  }

  async recover(folder: string, chats: readonly ChatRecord[]): Promise<ReconciledChats> {
    const result = await this.reconcile(folder, chats)
    const targets = this.members(folder) === undefined ? [folder] : this.ledger.folders(folder)
    const known = new Set(chats.map(chat => chat.id))
    for (const target of targets) {
      const orphans = [...this.ledger.owned(target, folder)].filter(id => !known.has(id))
      if (!orphans.length) continue
      try { await this.deps.workspaceFor(target).call('deleteOrphanMailboxes', orphans) }
      catch (error) { this.logFailure(target, 'delete the mailboxes of deleted chats', error) }
    }
    return result
  }

  async rename(chat: ChatRecord): Promise<void> {
    if (chat.folder !== null && this.members(chat.folder) !== undefined) {
      for (const route of await this.routes(chat)) await this.rename({ ...chat, folder: route.folder, endpointId: route.endpointId })
      return
    }
    if (chat.folder === null || !hasMailbox(chat) || chat.endpointId === undefined) return
    let workspace: ProjectWorkspace
    try { workspace = this.deps.workspaceFor(chat.folder) }
    catch (error) { this.logFailure(chat.folder, 'rename the mailbox of chat ' + chat.id, error); return }
    try { await workspace.call('renameMailbox', chat.endpointId, chat.title) }
    catch (error) { this.deps.log('Could not rename the mailbox of chat ' + chat.id + ': ' + messageOf(error)) }
  }

  async delete(chat: ChatRecord): Promise<void> {
    if (chat.folder !== null && this.members(chat.folder) !== undefined) {
      for (const folder of new Set([...(this.members(chat.folder) ?? []), ...this.ledger.folders(chat.folder)])) await this.deleteWorldRoute({ ...chat, folder: chat.folder }, folder)
      return
    }
    if (chat.folder === null || !hasMailbox(chat) || hasForgeManifest(chat.folder)) return
    try { await this.deps.workspaceFor(chat.folder).call('deleteMailbox', chat) }
    catch (error) { if (!notInitialized(error)) throw error }
  }

  private async deleteWorldRoute(chat: ChatRecord & { folder: string }, folder: string): Promise<void> {
    this.ledger.markDeleted(folder, chat.id, chat.folder)
    try { await this.delete({ ...chat, folder }) }
    catch (error) {
      // The durable intent is drained when this member is tracked again, without opening an untracked database.
      if (!(error instanceof DomainError && error.code === 'unauthorized')) throw error
    }
  }

  async suspendFolder(folder: string, chats: readonly ChatRecord[]): Promise<void> {
    if (this.members(folder) !== undefined) {
      for (const member of new Set([...(this.members(folder) ?? []), ...this.ledger.folders(folder)])) await this.suspendAt(member, chats)
      return
    }
    const owned = [...this.ledger.allOwned(folder)].map(id => ({ id, agent: MAILBOX_AGENT, title: 'Chat' }))
    await this.suspendAt(folder, [...chats, ...owned])
  }

  private async suspendAt(folder: string, chats: readonly MailboxChat[]): Promise<void> {
    if (hasForgeManifest(folder)) return
    const eligible = chats.filter((chat) => hasMailbox(chat))
    if (eligible.length === 0) return
    let workspace: ProjectWorkspace
    try { workspace = this.deps.workspaceFor(folder) }
    catch (error) {
      this.logFailure(folder, 'suspend chat mailboxes', error)
      this.deps.log(`The chat mailboxes in ${folder} stay open: the folder's storage could not be reached to suspend them.`)
      return
    }
    for (const chatId of new Set(eligible.map(chat => chat.id))) {
      try {
        await workspace.call('suspendMailbox', chatId)
      } catch (error) {
        this.deps.log(`Could not suspend the mailbox of chat ${chatId}; it stays open: ${messageOf(error)}`)
      }
    }
  }

  private members(folder: string): readonly string[] | undefined {
    const knownWorld = hasForgeManifest(folder) || this.ledger.folders(folder).some(member => member !== folder)
    try {
      const members = this.deps.membersFor?.(folder)
      this.unreadable.delete(folder)
      return members ?? (knownWorld ? [] : undefined)
    } catch { this.unreadable.add(folder); return knownWorld ? [] : undefined }
  }

  async routes(chat: ChatRecord, only?: string, background?: boolean): Promise<readonly { folder: string; endpointId: string }[]> {
    if (chat.folder === null || chat.archived || !hasMailbox(chat)) return []
    const members = this.members(chat.folder)
    if (members === undefined) return chat.endpointId === undefined ? [] : [{ folder: chat.folder, endpointId: chat.endpointId }]
    const routes: { folder: string; endpointId: string }[] = []
    for (const folder of only === undefined ? members : members.filter(path => path === only)) {
      const endpointId = await this.routeAt(folder, chat.id, background)
      if (endpointId !== undefined) routes.push({ folder, endpointId })
    }
    return routes
  }

  private async routeAt(folder: string, chatId: string, background: boolean | undefined): Promise<string | undefined> {
    if (hasForgeManifest(folder) || this.ledger.deleting(folder).has(chatId)) return undefined
    try {
      const [route] = await this.deps.workspaceFor(folder, background).call('listMailboxRoutes', [chatId])
      return route?.endpointId
    } catch (error) { this.logFailure(folder, 'read world mailbox routes', error); return undefined }
  }

  private logFailure(folder: string, doing: string, error: unknown): void {
    if (!notInitialized(error)) this.deps.log('Could not ' + doing + ' in ' + folder + ': ' + messageOf(error))
  }

  private async reconcileAt(folder: string, chats: readonly ChatRecord[], owner = folder): Promise<ReconciledChats> {
    const unchanged = { chats: [...chats], deleting: [] }
    const eligible = chats.filter(chat => !chat.archived && hasMailbox(chat))
    await this.suspendAt(folder, chats.filter(chat => chat.archived))
    const pending = [...this.ledger.deleting(folder)]
    if ((eligible.length === 0 && pending.length === 0) || hasForgeManifest(folder)) return unchanged
    try {
      const provisioned = await this.deps.workspaceFor(folder).call('provisionMailboxes', pending, eligible)
      const shown: ChatRecord[] = []
      const deleting: ChatRecord[] = []
      for (const chat of chats) {
        const endpointId = provisioned.endpoints.get(chat.id)
        if (provisioned.deleting.has(chat.id)) deleting.push(chat)
        else shown.push(endpointId === undefined ? chat : this.record(folder, chat, endpointId, owner))
      }
      return { chats: shown, deleting }
    } catch (error) {
      this.logFailure(folder, 'provision chat mailboxes', error)
      return unchanged
    }
  }

  /** Stores the chat's mailbox id and its ledger pair; a write that fails is logged and leaves the record as it was. */
  private record(folder: string, chat: ChatRecord, endpointId: string, owner = folder): ChatRecord {
    try {
      this.ledger.add(folder, chat.id, owner)
      if (owner !== folder) return chat
      return chat.endpointId === endpointId ? chat : this.deps.store.recordEndpoint(chat, endpointId)
    } catch (error) {
      // The endpoint is committed: the next provision of the same chat finds the same id.
      this.deps.log(`Could not record the mailbox of chat ${chat.id}: ${messageOf(error)}`)
      return chat
    }
  }

}

export function createChatMailboxes(deps: ChatMailboxesDeps): ChatMailboxes {
  return new ChatMailboxRegistry(deps)
}
