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
import type { Ctx } from '../../core/context'
import { DomainError } from '../../core/errors'
import {
  bindAgentMailEndpoint,
  deleteAgentMailEndpoint,
  provisionAgentMailEndpoint,
  renameAgentMailEndpoint,
  resumeAgentMailEndpoint,
  suspendAgentMailEndpoint
} from '../../core/services/agentMail'
import { AGENT_MAIL_LIMITS, findEndpointByChat, listOpenEndpoints, type MailEndpoint } from '../../core/services/agentMailStore'
import type { ChatRecord } from '../../shared/agents/chat'
import type { ChatStore, ChatStoreFs } from './chatStore'

/** What a mailbox is provisioned for: the chat's id, its stored agent id, and its title as the display name. */
export type MailboxChat = Pick<ChatRecord, 'id' | 'agent' | 'title'>

/** The only agent whose chats have mailboxes: the bundled Skitarii extension runs in OMP. */
const MAILBOX_AGENT = 'omp'

/** Whether the chat has a mailbox: an OMP chat by its stored agent id, and by the connected agent's `kind` when given. */
export function hasMailbox(chat: Pick<ChatRecord, 'agent'>, kind?: string): boolean {
  return chat.agent === MAILBOX_AGENT && (kind === undefined || kind === MAILBOX_AGENT)
}

/** The endpoint's display name: the chat's title, trimmed to the store's limit; an empty title reads as "Chat". */
function mailboxName(title: string): string {
  const name = title.trim().slice(0, AGENT_MAIL_LIMITS.nameChars).trim()
  return name === '' ? 'Chat' : name
}

/**
 * The chat's open endpoint, created on first use; one suspended by an untrack is resumed (only main, trusted, calls
 * this). A deleting or deleted one throws `invalid_state`: a tombstone is never reopened.
 */
function openChatMailbox(ctx: Ctx, chat: MailboxChat): MailEndpoint {
  return ctx.db.tx(() => {
    const endpoint = provisionAgentMailEndpoint(ctx, { chatId: chat.id, name: mailboxName(chat.title) })
    return endpoint.state === 'suspended' ? resumeAgentMailEndpoint(ctx, { endpointId: endpoint.id }) : endpoint
  })
}

/** Binds a fresh grant to the chat's open mailbox in one transaction; returns the endpoint's id. */
export function bindChatMailbox(ctx: Ctx, chat: MailboxChat, grantId: string): string {
  return ctx.db.tx(() => {
    const endpoint = openChatMailbox(ctx, chat)
    bindAgentMailEndpoint(ctx, { endpointId: endpoint.id, grantId })
    return endpoint.id
  })
}

/** Records the deletion durably (a tombstone even for a chat that never had a mailbox), then purges batch by batch until done. */
function deleteChatMailbox(ctx: Ctx, chat: MailboxChat): void {
  const endpoint =
    findEndpointByChat(ctx, { machineId: ctx.machineId, chatId: chat.id }) ??
    provisionAgentMailEndpoint(ctx, { chatId: chat.id, name: mailboxName(chat.title) })
  while (!deleteAgentMailEndpoint(ctx, { endpointId: endpoint.id }).done) {
    // One bounded purge batch per call; each commits on its own.
  }
}

/** The (folder, chat id) pairs this installation provisioned, from an append-only JSON-lines file. */
interface MailboxLedger {
  /** The chat ids this installation provisioned in `folder`; empty for none. */
  owned(folder: string): ReadonlySet<string>
  add(folder: string, chatId: string): void
}

function openLedger(fs: ChatStoreFs, file: string): MailboxLedger {
  let byFolder: Map<string, Set<string>> | null = null
  const load = (): Map<string, Set<string>> => {
    if (byFolder !== null) return byFolder
    const loaded = new Map<string, Set<string>>()
    let text = ''
    try {
      text = fs.readFile(file)
    } catch {
      // No ledger yet: this installation has provisioned nothing.
    }
    for (const line of text.split('\n')) {
      try {
        const entry = JSON.parse(line) as { folder?: unknown; chatId?: unknown }
        if (typeof entry.folder === 'string' && typeof entry.chatId === 'string') {
          loaded.set(entry.folder, (loaded.get(entry.folder) ?? new Set()).add(entry.chatId))
        }
      } catch {
        // A blank or truncated line is skipped; a pair it lost is added again the next time it is provisioned.
      }
    }
    byFolder = loaded
    return loaded
  }
  return {
    owned: (folder) => load().get(folder) ?? new Set(),
    add: (folder, chatId) => {
      const ledger = load()
      if (ledger.get(folder)?.has(chatId) === true) return
      fs.mkdirp(join(file, '..'))
      // A fresh line even after a truncated tail: a cut line only loses itself.
      fs.appendFile(file, `\n${JSON.stringify({ folder, chatId })}\n`)
      ledger.set(folder, (ledger.get(folder) ?? new Set()).add(chatId))
    }
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
export interface ChatMailboxes {
  /** Provisions (and resumes) the OMP chats' mailboxes and stores their ids; never throws: a failure is logged and the chats are returned as they are. */
  reconcile(folder: string, chats: readonly ChatRecord[]): ReconciledChats
  /** `reconcile`, then deletes the open mailboxes this installation provisioned for chats that no longer exist. Never throws. */
  recover(folder: string, chats: readonly ChatRecord[]): ReconciledChats
  /** Renames the chat's mailbox to its title; never throws. */
  rename(chat: ChatRecord): void
  /** Deletes the chat's mailbox durably (see the module comment); throws when storage cannot record it. */
  delete(chat: ChatRecord): void
  /** Suspends the open mailboxes of the folder's chats (it is being untracked); their mail stays. Never throws. */
  suspendFolder(folder: string, chats: readonly ChatRecord[]): void
}

interface ChatMailboxesDeps {
  /** The folder's desktop workspace context (`mail.manage`); throws for a folder that is not tracked. */
  contextFor: (folder: string) => Ctx
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

/** `reconcile`'s result with the folder's context: undefined when no chat needed one, null when it could not be reached. */
type Reconciled = ReconciledChats & { ctx: Ctx | null | undefined }

class ChatMailboxRegistry implements ChatMailboxes {
  private readonly ledger: MailboxLedger

  constructor(private readonly deps: ChatMailboxesDeps) {
    this.ledger = openLedger(deps.ledger.fs, deps.ledger.file)
  }

  reconcile(folder: string, chats: readonly ChatRecord[]): ReconciledChats {
    const { chats: shown, deleting } = this.reconcileWithContext(folder, chats)
    return { chats: shown, deleting }
  }

  recover(folder: string, chats: readonly ChatRecord[]): ReconciledChats {
    const { ctx, ...result } = this.reconcileWithContext(folder, chats)
    const known = new Set(chats.map((chat) => chat.id))
    const orphans = new Set([...this.ledger.owned(folder)].filter((chatId) => !known.has(chatId)))
    if (orphans.size === 0) return result
    const reached = ctx === undefined ? this.contextOrNull(folder, 'delete the mailboxes of deleted chats') : ctx
    if (reached !== null) this.deleteOrphans(reached, folder, orphans)
    return result
  }

  rename(chat: ChatRecord): void {
    if (chat.folder === null || !hasMailbox(chat) || chat.endpointId === undefined) return
    const ctx = this.contextOrNull(chat.folder, `rename the mailbox of chat ${chat.id}`)
    if (ctx === null) return
    try {
      renameAgentMailEndpoint(ctx, { endpointId: chat.endpointId, name: mailboxName(chat.title) })
    } catch (error) {
      this.deps.log(`Could not rename the mailbox of chat ${chat.id}: ${messageOf(error)}`)
    }
  }

  delete(chat: ChatRecord): void {
    if (chat.folder === null || !hasMailbox(chat)) return
    let ctx: Ctx
    try {
      ctx = this.deps.contextFor(chat.folder)
    } catch (error) {
      if (notInitialized(error)) return
      throw error
    }
    deleteChatMailbox(ctx, chat)
  }

  suspendFolder(folder: string, chats: readonly ChatRecord[]): void {
    const eligible = chats.filter((chat) => hasMailbox(chat))
    if (eligible.length === 0) return
    const ctx = this.contextOrNull(folder, 'suspend chat mailboxes')
    if (ctx === null) {
      this.deps.log(`The chat mailboxes in ${folder} stay open: the folder's storage could not be reached to suspend them.`)
      return
    }
    for (const chat of eligible) {
      try {
        const endpoint = findEndpointByChat(ctx, { machineId: ctx.machineId, chatId: chat.id })
        if (endpoint?.state === 'open') suspendAgentMailEndpoint(ctx, { endpointId: endpoint.id })
      } catch (error) {
        this.deps.log(`Could not suspend the mailbox of chat ${chat.id}; it stays open: ${messageOf(error)}`)
      }
    }
  }

  /** The folder's context, or null (logged unless the folder simply has no database). */
  private contextOrNull(folder: string, doing: string): Ctx | null {
    try {
      return this.deps.contextFor(folder)
    } catch (error) {
      if (!notInitialized(error)) this.deps.log(`Could not ${doing} in ${folder}: ${messageOf(error)}`)
      return null
    }
  }

  private reconcileWithContext(folder: string, chats: readonly ChatRecord[]): Reconciled {
    const unchanged = { chats: [...chats], deleting: [] }
    const eligible = chats.filter((chat) => hasMailbox(chat))
    if (eligible.length === 0) return { ...unchanged, ctx: undefined }
    const ctx = this.contextOrNull(folder, 'provision chat mailboxes')
    if (ctx === null) return { ...unchanged, ctx }
    let provisioned: { endpoints: Map<string, string>; deleting: Set<string> }
    try {
      provisioned = provisionAll(ctx, eligible)
    } catch (error) {
      this.deps.log(`Could not provision chat mailboxes in ${folder}: ${messageOf(error)}`)
      return { ...unchanged, ctx }
    }
    const shown: ChatRecord[] = []
    const deleting: ChatRecord[] = []
    for (const chat of chats) {
      const endpointId = provisioned.endpoints.get(chat.id)
      if (provisioned.deleting.has(chat.id)) deleting.push(chat)
      else shown.push(endpointId === undefined ? chat : this.record(folder, chat, endpointId))
    }
    return { chats: shown, deleting, ctx }
  }

  /** Stores the chat's mailbox id and its ledger pair; a write that fails is logged and leaves the record as it was. */
  private record(folder: string, chat: ChatRecord, endpointId: string): ChatRecord {
    try {
      this.ledger.add(folder, chat.id)
      return chat.endpointId === endpointId ? chat : this.deps.store.recordEndpoint(chat, endpointId)
    } catch (error) {
      // The endpoint is committed: the next provision of the same chat finds the same id.
      this.deps.log(`Could not record the mailbox of chat ${chat.id}: ${messageOf(error)}`)
      return chat
    }
  }

  /** Deletes this machine's open mailboxes of `orphans` (chats provisioned here whose records are gone); a failure is logged. */
  private deleteOrphans(ctx: Ctx, folder: string, orphans: ReadonlySet<string>): void {
    try {
      let page = listOpenEndpoints(ctx)
      for (;;) {
        for (const endpoint of page.endpoints.filter((open) => open.machineId === ctx.machineId && orphans.has(open.chatId))) {
          deleteChatMailbox(ctx, { id: endpoint.chatId, agent: MAILBOX_AGENT, title: endpoint.name })
        }
        if (!page.hasMore || page.nextAfterId === null) return
        page = listOpenEndpoints(ctx, { afterId: page.nextAfterId })
      }
    } catch (error) {
      this.deps.log(`Could not delete the mailboxes of deleted chats in ${folder}: ${messageOf(error)}`)
    }
  }
}

/** Provisions (and resumes) every chat's mailbox in one transaction, setting aside chats whose mailbox is deleting or deleted. */
function provisionAll(ctx: Ctx, chats: readonly ChatRecord[]): { endpoints: Map<string, string>; deleting: Set<string> } {
  const endpoints = new Map<string, string>()
  const deleting = new Set<string>()
  ctx.db.tx(() => {
    for (const chat of chats) {
      const state = findEndpointByChat(ctx, { machineId: ctx.machineId, chatId: chat.id })?.state
      if (state === 'deleting' || state === 'deleted') {
        deleting.add(chat.id)
      } else {
        endpoints.set(chat.id, openChatMailbox(ctx, chat).id)
      }
    }
  })
  return { endpoints, deleting }
}

export function createChatMailboxes(deps: ChatMailboxesDeps): ChatMailboxes {
  return new ChatMailboxRegistry(deps)
}
