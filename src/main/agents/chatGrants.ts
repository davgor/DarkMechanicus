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
 */
import { realpathSync } from 'node:fs'
import { assertGrantCapability, hashToken } from '../../core/services/grants'
import { NamingControlError } from '../../shared/agents/chatNaming'
import type { NamingControlBinding } from '../naming/controlPipe'
import type { Workspace } from '../../core/workspace'
import type { ChatRole, DarkMechanicusCli } from '../../shared/agents/chat'

interface ChatGrantsDeps {
  /** The desktop's workspace for a tracked folder; throws for one that is not. Asked only at issue. */
  workspaceFor: (folder: string) => Workspace
  /** The `dm` invocation pinned to `folder`, before the grant's token is added. */
  cliFor: (folder: string) => DarkMechanicusCli
  /** How long a chat's grant lasts. */
  minutes: number
  /** Told, in one line, of each grant that could not be revoked. */
  log: (line: string) => void
  desktopAddress?: () => string | undefined
  desktopReady?: () => Promise<void>
}

/** What the chat terminals (`terminalSessions.ts`) issue and revoke chat grants through. */
interface GrantOptions { role: ChatRole; allowSave: boolean; label: string }
export interface IssuedChatCli { cli: DarkMechanicusCli; grantId: string }
interface LiveIdentity { folder: string; chatId: string; generation: string }

export interface ChatGrants {
  bindChatGrant(grantId: string, identity: LiveIdentity): void
  authorizeNaming(token: string): NamingControlBinding
  dispose(): void
  issueChatCli(folder: string, grant: GrantOptions): Promise<IssuedChatCli>
  /** Never throws: a grant it cannot revoke is logged. */
  revokeChatGrant(grantId: string): Promise<void>
  /** Moves a held grant's expiry to `minutes` from now. Never throws: a renewal that fails is logged. */
  renewChatGrant(grantId: string): Promise<void>
}

interface HeldGrant {
  workspace: Workspace
  expiresAt: string
  folder: string
  tokenHash: string
  live: NamingControlBinding | null
  lifetime: AbortController
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
  async issueChatCli(folder: string, grant: GrantOptions): Promise<IssuedChatCli> {
    await this.deps.desktopReady?.()
    const workspace = this.deps.workspaceFor(folder)
    const issued = await workspace.issueGrant({ role: grant.role, label: grant.label, allowSave: grant.allowSave, minutes: this.deps.minutes })
    this.held.set(issued.grant.id, { workspace, expiresAt: issued.grant.expiresAt, folder: realpathSync.native(folder), tokenHash: hashToken(issued.token), live: null, lifetime: new AbortController() })
    const launch = this.deps.cliFor(folder)
    const env: Record<string, string> = { ...launch.env, DM_SESSION_TOKEN: issued.token }
    delete env['DM_DESKTOP_PIPE']
    const address = this.deps.desktopAddress?.()
    if (address !== undefined) env['DM_DESKTOP_PIPE'] = address
    return {
      cli: { ...launch, env },
      grantId: issued.grant.id
    }
  }
  bindChatGrant(grantId: string, identity: LiveIdentity): void {
    const grant = this.held.get(grantId)
    if (!grant || grant.lifetime.signal.aborted || grant.live !== null || realpathSync.native(identity.folder) !== grant.folder || identity.generation === '') throw new NamingControlError('unauthorized')
    const binding: NamingControlBinding = {
      grantId, folder: grant.folder, chatId: identity.chatId, generation: identity.generation,
      signal: grant.lifetime.signal, assertCurrent: () => this.assertBinding(grantId, grant, binding)
    }
    for (const previous of this.liveByHash.values()) {
      if (previous.live?.folder === binding.folder && previous.live.chatId === binding.chatId) this.invalidate(previous)
    }
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
      await through(grant, (workspace) => workspace.revokeGrant({ grantId }))
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
    issueChatCli: (folder, grant) => registry.issueChatCli(folder, grant),
    revokeChatGrant: (id) => registry.revokeChatGrant(id),
    renewChatGrant: (id) => registry.renewChatGrant(id),
    bindChatGrant: (id, identity) => registry.bindChatGrant(id, identity),
    authorizeNaming: (token) => registry.authorizeNaming(token),
    dispose: () => registry.dispose()
  }
}
