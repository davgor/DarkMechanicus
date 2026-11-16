/**
 * The grants chat terminals run on. Each is revoked through the workspace it was issued in, held
 * since issue, never by finding its folder again: a folder renamed while its chat ran is no longer
 * at its path, but the workspace's open SQLite handle still reaches its `state.sqlite` on POSIX.
 *
 * The workspace is the desktop pool's, so it stays open until the folder is untracked or the app
 * has disposed its chats. One the pool has closed since is opened again in the folder it was issued
 * in, for the revoke only, and closed after. A grant that cannot be revoked either way is logged in
 * one line naming it and its expiry, and never throws: the session ending must not wait on it.
 *
 * While a chat runs its grant is renewed through the same workspace, to `minutes` from the renewal,
 * so a chat that runs for days keeps its role and one whose app died loses it within `minutes`. A
 * grant already revoked is renewed nothing; a renewal that fails is logged in one line, never thrown.
 *
 * An OMP chat's grant is bound to the chat's mailbox before it is returned, so before its CLI is spawned
 * (`chatMailboxes.ts`), and only while the folder is still tracked with the workspace the grant came from: a start
 * whose folder was untracked meanwhile binds nothing. A grant whose binding fails is revoked before the error is
 * thrown. Revoking a grant closes its binding first, through the same workspace; one that cannot be closed is logged.
 * No other grant (another CLI's chat, a project-less chat's, a grant issued outside a chat start) is ever bound.
 *
 * A project-less chat (`issueReachCli`) holds one grant per folder it reaches, each issued in that folder's own
 * workspace and checked there like any other: its token opens no other folder. Each token is written to its own
 * file (`chatReach.ts`), and the grants are revoked, renewed and bound for naming one by one, like a folder chat's.
 * A start that cannot issue all of them revokes the ones it did and fails.
 */
import { realpathSync } from 'node:fs'
import { DomainError } from '../../core/errors'
import { closeAgentMailBinding } from '../../core/services/agentMail'
import { assertGrantCapability, hashToken } from '../../core/services/grants'
import { NamingControlError } from '../../shared/agents/chatNaming'
import type { NamingControlBinding } from '../naming/controlPipe'
import { writePrivateFile } from '../terminals/privateFile'
import type { Workspace } from '../../core/workspace'
import type { ChatRole, DarkMechanicusCli } from '../../shared/agents/chat'
import { bindChatMailbox, hasMailbox, type MailboxChat } from './chatMailboxes'
import type { ReachTarget } from './chatReach'

interface ChatGrantsDeps {
  /** The desktop's workspace for a tracked folder; throws for one that is not. Asked only at issue. */
  workspaceFor: (folder: string) => Workspace
  /** The `dm` invocation pinned to `folder` (to none for null: a project-less chat's), before the grant's token is added. */
  cliFor: (folder: string | null) => DarkMechanicusCli
  /** How long a chat's grant lasts. */
  minutes: number
  /** Told, in one line, of each grant that could not be revoked. */
  log: (line: string) => void
  desktopAddress?: () => string | undefined
  desktopReady?: () => Promise<void>
}

/** What the chat terminals (`terminalSessions.ts`) issue and revoke chat grants through. */
interface GrantOptions { role: ChatRole; allowSave: boolean; label: string }
/** The trusted chat a grant is issued for: its stored identity and title, and its connected agent's kind. */
export type GrantChat = MailboxChat & { kind: string }
export interface IssuedChatCli {
  cli: DarkMechanicusCli
  grantId: string
  /** The chat's mailbox the grant is bound to; null for a chat without one. */
  endpointId: string | null
}
/** A project-less chat's `dm` invocation, pinned to no folder, and the grants it holds, one per folder, in the targets' order. */
interface IssuedReachCli { cli: DarkMechanicusCli; grantIds: string[] }
/** The live terminal a grant is bound to for naming: its chat's folder (null for a project-less chat), id and start. */
interface LiveIdentity { folder: string | null; chatId: string; generation: string }

export interface ChatGrants {
  bindChatGrant(grantId: string, identity: LiveIdentity): void
  authorizeNaming(token: string): NamingControlBinding
  dispose(): void
  /** Binds the grant to the chat's mailbox when `chat` has one (see the module comment). */
  issueChatCli(folder: string, grant: GrantOptions, chat?: GrantChat): Promise<IssuedChatCli>
  /** One grant per target folder, each token written to its file; refused (and none left usable) when any fails. */
  issueReachCli(targets: readonly ReachTarget[], grant: GrantOptions): Promise<IssuedReachCli>
  /** Never throws: a grant it cannot revoke is logged. */
  revokeChatGrant(grantId: string): Promise<void>
  /** Moves a held grant's expiry to `minutes` from now. Never throws: a renewal that fails is logged. */
  renewChatGrant(grantId: string): Promise<void>
}

interface HeldGrant {
  workspace: Workspace
  expiresAt: string
  /** The canonical folder the grant was issued in. */
  folder: string
  /** Whether it was issued to a project-less chat, which only a project-less chat's terminal may be bound by. */
  projectless: boolean
  tokenHash: string
  live: NamingControlBinding | null
  lifetime: AbortController
  /** Whether it was bound to a mailbox, whose binding its revoke closes. */
  mailbox: boolean
}

async function through(held: HeldGrant, act: (workspace: Workspace) => Promise<unknown>): Promise<void> {
  // A workspace with no session is one the pool closed since issue: the command opens it again in
  // its folder, so it is closed again after rather than left open outside the pool.
  const reopened = held.workspace.sessionId() === null
  try {
    await act(held.workspace)
  } finally {
    if (reopened) {
      held.workspace.close()
    }
  }
}

/** Whether a terminal of a chat in `chatFolder` may be bound by the grant: a folder chat's by a grant of its own folder, a project-less chat's only by one issued to it. */
function ownedBy(grant: HeldGrant, chatFolder: string | null): boolean {
  return chatFolder === null ? grant.projectless : !grant.projectless && realpathSync.native(chatFolder) === grant.folder
}

class ChatGrantRegistry implements ChatGrants {
  private readonly held = new Map<string, HeldGrant>()
  private readonly liveByHash = new Map<string, HeldGrant>()
  constructor(private readonly deps: ChatGrantsDeps) {}
  private invalidate(grant: HeldGrant): void {
    grant.lifetime.abort()
    this.liveByHash.delete(grant.tokenHash)
    grant.live = null
  }
  private assertBinding(grantId: string, grant: HeldGrant, binding: NamingControlBinding): void {
    if (this.held.get(grantId) !== grant || grant.live !== binding || binding.signal.aborted || grant.workspace.sessionId() === null || realpathSync.native(grant.folder) !== grant.folder) {
      throw new NamingControlError('unauthorized')
    }
    const ctx = grant.workspace.ctx()
    assertGrantCapability({ db: ctx.db, clock: ctx.clock, machineId: ctx.machineId }, grantId, grant.tokenHash, 'chat.name')
  }
  /** Issues one grant in the folder's workspace and holds it; answers it with its token and that workspace. */
  private async issueHeld(folder: string, grant: GrantOptions, projectless: boolean, mailbox: boolean): Promise<{ grantId: string; token: string; workspace: Workspace }> {
    const workspace = this.deps.workspaceFor(folder)
    const issued = await workspace.issueGrant({ role: grant.role, label: grant.label, allowSave: grant.allowSave, minutes: this.deps.minutes })
    this.held.set(issued.grant.id, { workspace, expiresAt: issued.grant.expiresAt, folder: realpathSync.native(folder), projectless, tokenHash: hashToken(issued.token), live: null, lifetime: new AbortController(), mailbox })
    return { grantId: issued.grant.id, token: issued.token, workspace }
  }
  /** The invocation with `token` as its grant and the naming transport's address, nothing else of either kind. */
  private withGrant(launch: DarkMechanicusCli, token: string): DarkMechanicusCli {
    const env: Record<string, string> = { ...launch.env, DM_SESSION_TOKEN: token }
    delete env['DM_DESKTOP_PIPE']
    const address = this.deps.desktopAddress?.()
    if (address !== undefined) env['DM_DESKTOP_PIPE'] = address
    return { ...launch, env }
  }
  async issueChatCli(folder: string, grant: GrantOptions, chat?: GrantChat): Promise<IssuedChatCli> {
    await this.deps.desktopReady?.()
    const mailbox = chat !== undefined && hasMailbox(chat, chat.kind)
    const issued = await this.issueHeld(folder, grant, false, mailbox)
    let endpointId: string | null = null
    if (mailbox) {
      try {
        // The issue awaited: a folder untracked (or its workspace replaced) since then gets no binding.
        if (this.deps.workspaceFor(folder) !== issued.workspace) {
          throw new DomainError('unauthorized', 'That folder is no longer tracked by Dark Mechanicus.')
        }
        endpointId = bindChatMailbox(issued.workspace.ctx(), chat, issued.grantId)
      } catch (error) {
        await this.revokeChatGrant(issued.grantId)
        throw error
      }
    }
    return { cli: this.withGrant(this.deps.cliFor(folder), issued.token), grantId: issued.grantId, endpointId }
  }
  /**
   * The environment's `DM_SESSION_TOKEN` is the first folder's token, as every chat terminal carries one; the CLI is
   * pinned to no folder, so a call names its folder and token file and the first token alone reaches nothing else.
   * A project-less chat has no mailbox: none of its grants is bound to one.
   */
  async issueReachCli(targets: readonly ReachTarget[], grant: GrantOptions): Promise<IssuedReachCli> {
    if (targets.length === 0) {
      throw new Error('A project-less chat needs at least one tracked folder to hold a grant in.')
    }
    await this.deps.desktopReady?.()
    const issued: { grantId: string; token: string }[] = []
    try {
      for (const target of targets) {
        const held = await this.issueHeld(target.folder, grant, true, false)
        issued.push(held)
        await writePrivateFile(target.tokenFile, `${held.token}\n`, 0o600)
      }
    } catch (error) {
      await Promise.all(issued.map(({ grantId }) => this.revokeChatGrant(grantId)))
      throw error
    }
    return { cli: this.withGrant(this.deps.cliFor(null), issued[0]?.token ?? ''), grantIds: issued.map(({ grantId }) => grantId) }
  }
  /** The held grant a live terminal of the chat may be bound by, or `unauthorized`. */
  private bindable(grantId: string, identity: LiveIdentity): HeldGrant {
    const grant = this.held.get(grantId)
    if (!grant || grant.lifetime.signal.aborted || grant.live !== null || identity.generation === '' || !ownedBy(grant, identity.folder)) throw new NamingControlError('unauthorized')
    return grant
  }
  /** Ends the bindings of the chat's earlier starts; a project-less start binds each of its grants, all of one generation. */
  private invalidateEarlierStarts(binding: NamingControlBinding): void {
    for (const previous of this.liveByHash.values()) {
      const live = previous.live
      if (live?.folder === binding.folder && live.chatId === binding.chatId && live.generation !== binding.generation) this.invalidate(previous)
    }
  }
  bindChatGrant(grantId: string, identity: LiveIdentity): void {
    const grant = this.bindable(grantId, identity)
    const binding: NamingControlBinding = {
      grantId, folder: identity.folder === null ? null : grant.folder, chatId: identity.chatId, generation: identity.generation,
      signal: grant.lifetime.signal, assertCurrent: () => this.assertBinding(grantId, grant, binding)
    }
    this.invalidateEarlierStarts(binding)
    grant.live = binding
    this.liveByHash.set(grant.tokenHash, grant)
  }
  authorizeNaming(token: string): NamingControlBinding {
    const binding = this.liveByHash.get(hashToken(token))?.live
    if (!binding) throw new NamingControlError('unauthorized')
    binding.assertCurrent()
    return binding
  }
  dispose(): void {
    for (const grant of this.held.values()) this.invalidate(grant)
  }
  async revokeChatGrant(grantId: string): Promise<void> {
    const grant = this.held.get(grantId)
    if (grant === undefined) {
      this.deps.log(`Could not revoke chat grant ${grantId}: it was not issued by this app session.`)
      return
    }
    this.invalidate(grant)
    this.held.delete(grantId)
    try {
      await through(grant, async (workspace) => {
        if (grant.mailbox) {
          try {
            closeAgentMailBinding(workspace.ctx(), { grantId })
          } catch {
            this.deps.log(`Could not close the mailbox binding of chat grant ${grantId}; revoking the grant still ends it.`)
          }
        }
        await workspace.revokeGrant({ grantId })
      })
    } catch {
      this.deps.log(`Could not revoke chat grant ${grantId}; it stays usable until it expires at ${grant.expiresAt}.`)
    }
  }
  async renewChatGrant(grantId: string): Promise<void> {
    const grant = this.held.get(grantId)
    if (grant === undefined) {
      return
    }
    try {
      await through(grant, async (workspace) => {
        grant.expiresAt = (await workspace.renewGrant({ grantId, minutes: this.deps.minutes })).expiresAt
      })
    } catch {
      this.deps.log(`Could not renew chat grant ${grantId}; it stays usable until it expires at ${grant.expiresAt}.`)
    }
  }
}

export function createChatGrants(deps: ChatGrantsDeps): ChatGrants {
  const registry = new ChatGrantRegistry(deps)
  // Terminal dependencies spread this interface; retain the registry receiver.
  return {
    issueReachCli: (targets, grant) => registry.issueReachCli(targets, grant),
    issueChatCli: (folder, grant, chat) => registry.issueChatCli(folder, grant, chat),
    revokeChatGrant: (id) => registry.revokeChatGrant(id),
    renewChatGrant: (id) => registry.renewChatGrant(id),
    bindChatGrant: (id, identity) => registry.bindChatGrant(id, identity),
    authorizeNaming: (token) => registry.authorizeNaming(token),
    dispose: () => registry.dispose()
  }
}
