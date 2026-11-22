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
import { approveYolo, auditYolo, isYoloEligible, bindYoloChat, endYoloChat, listYoloAudit, revokeYolo, YOLO_CAPABILITIES } from '../../core/services/yolo'
import type { YoloStatus } from '../../shared/desktop/api'
import type { GrantView } from '../../shared/domain/views'
import type { Ctx } from '../../core/context'
import type { DesktopFence } from '../../core/services/yoloFence'
import { DomainError } from '../../core/errors'
import { closeAgentMailBinding } from '../../core/services/agentMail'
import { assertGrantCapability, assertGrantUsable, hashToken } from '../../core/services/grants'
import { bindToolingGrant } from '../../core/services/toolingHold'
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
  /** Main rotates this before opening any folder; absent means YOLO cannot be enabled. */
  desktopFence?: DesktopFence
  yoloReady?: () => Promise<void>
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
interface LiveIdentity { folder: string | null; chatId: string; generation: string; runId?: string; cardId?: string }

export interface ChatGrants {
  bindChatGrant(grantId: string, identity: LiveIdentity): void
  authorizeNaming(token: string): NamingControlBinding
  yolo(folder: string, grantId: string, action: 'enable' | 'revoke' | 'inspect', confirm: (detail: string) => Promise<boolean>): Promise<YoloStatus>
  dispose(): void
  /** Binds the grant to the chat's mailbox when `chat` has one (see the module comment). */
  issueChatCli(folder: string, grant: GrantOptions, chat?: GrantChat): Promise<IssuedChatCli>
  /** One grant per target folder, each token written to its file; refused (and none left usable) when any fails. */
  issueReachCli(targets: readonly ReachTarget[], grant: GrantOptions, ownerFolder?: string): Promise<IssuedReachCli>
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
  /** The owning chat's canonical folder (world root for scoped reach), or null for a project-less chat. */
  ownerFolder: string | null
  tokenHash: string
  live: NamingControlBinding | null
  lifetime: AbortController
  /** Whether it was bound to a mailbox, whose binding its revoke closes. */
  mailbox: boolean
  runId?: string
  cardId?: string
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
  return (chatFolder === null ? null : realpathSync.native(chatFolder)) === grant.ownerFolder
}

function yoloConfirmation(parent: GrantView, held: HeldGrant, binding: NamingControlBinding, expiresAt: string): string {
  return `Agent: ${parent.label}\nChat: ${binding.chatId}\nStart: ${binding.generation}\nGrant: ${parent.id}\nFolder: ${held.folder}\nRun: ${held.runId ?? '(none; no run commands)'}\nCard: ${held.cardId ?? '(none)'}\nPowers: ${YOLO_CAPABILITIES.join(', ')}\nExpires: ${expiresAt} (never renewed automatically)\n\nThis agent can Save plans, grant retries and approve/advance checkpoints without further human review. Evidence gates remain mandatory. No OS privileges, credentials, mail management, grant issue/revoke or human feedback powers. Revocable immediately. Ends on chat exit/restart. Only approve if you accept unreviewed in-scope workflow changes.`
}

class ChatGrantRegistry implements ChatGrants {
  private readonly held = new Map<string, HeldGrant>()
  private readonly liveByHash = new Map<string, HeldGrant>()
  constructor(private readonly deps: ChatGrantsDeps) {}
  private invalidate(grant: HeldGrant): void {
    if (grant.live !== null) {
      try { endYoloChat(grant.workspace.ctx(), grant.live.grantId) }
      catch { this.deps.log(`Could not end YOLO binding for ${grant.live.grantId}; its fixed expiry still applies.`) }
    }
    grant.lifetime.abort()
    this.liveByHash.delete(grant.tokenHash)
    grant.live = null
  }
  private assertBinding(grantId: string, grant: HeldGrant, binding: NamingControlBinding, naming = true): void {
    if (this.held.get(grantId) !== grant || grant.live !== binding || binding.signal.aborted || grant.workspace.sessionId() === null || realpathSync.native(grant.folder) !== grant.folder || !ownedBy(grant, binding.folder)) {
      throw new NamingControlError('unauthorized')
    }
    const ctx = grant.workspace.ctx()
    if (naming) assertGrantCapability({ db: ctx.db, clock: ctx.clock, machineId: ctx.machineId }, grantId, grant.tokenHash, 'chat.name')
    else assertGrantUsable(ctx, grantId)
  }
  /** Issues one grant in the folder's workspace and holds it; answers it with its token and that workspace. */
  private async issueHeld(folder: string, grant: GrantOptions, ownerFolder: string | null, mailbox: boolean): Promise<{ grantId: string; token: string; workspace: Workspace }> {
    const workspace = this.deps.workspaceFor(folder)
    const issued = await workspace.issueGrant({ role: grant.role, label: grant.label, allowSave: grant.allowSave, minutes: this.deps.minutes })
    this.held.set(issued.grant.id, { workspace, expiresAt: issued.grant.expiresAt, folder: realpathSync.native(folder), ownerFolder, tokenHash: hashToken(issued.token), live: null, lifetime: new AbortController(), mailbox })
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
    const issued = await this.issueHeld(folder, grant, realpathSync.native(folder), mailbox)
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
  async issueReachCli(targets: readonly ReachTarget[], grant: GrantOptions, ownerFolder?: string): Promise<IssuedReachCli> {
    if (targets.length === 0) {
      throw new Error('A project-less chat needs at least one tracked folder to hold a grant in.')
    }
    await this.deps.desktopReady?.()
    const owner = ownerFolder === undefined ? null : realpathSync.native(ownerFolder)
    const issued: { grantId: string; token: string }[] = []
    try {
      for (const target of targets) {
        const held = await this.issueHeld(target.folder, grant, owner, false)
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
      grantId, folder: grant.ownerFolder, chatId: identity.chatId, generation: identity.generation,
      ...(identity.runId === undefined ? {} : { runId: identity.runId }),
      ...(identity.cardId === undefined ? {} : { cardId: identity.cardId }),
      signal: grant.lifetime.signal, assertCurrent: () => this.assertBinding(grantId, grant, binding),
      assertRecovery: () => {
        this.assertBinding(grantId, grant, binding, false)
        const ctx = grant.workspace.ctx()
        assertGrantCapability(ctx, grantId, grant.tokenHash, 'tooling.recover')
      },
    }
    this.invalidateEarlierStarts(binding)
    grant.live = binding
    this.liveByHash.set(grant.tokenHash, grant)
    grant.runId = identity.runId
    grant.cardId = identity.cardId
    if (this.deps.desktopFence !== undefined) bindYoloChat(grant.workspace.ctx(), this.yoloBinding(grantId, grant, binding))
    bindToolingGrant(grant.workspace.ctx(), grantId, identity.chatId)
  }
  authorizeNaming(token: string): NamingControlBinding {
    const binding = this.liveByHash.get(hashToken(token))?.live
    if (!binding) throw new NamingControlError('unauthorized')
    binding.assertCurrent()
    return binding
  }
  private yoloBinding(grantId: string, held: HeldGrant, binding: NamingControlBinding) {
    const fence = this.deps.desktopFence
    if (fence === undefined) throw new DomainError('unauthorized', 'No current desktop instance can authorize YOLO.')
    return { grantId, chatId: binding.chatId, generation: binding.generation, desktopId: fence.instance, desktopPid: fence.pid,
      fencePath: fence.path, proofEndpoint: fence.proofEndpoint, proofPublicKey: fence.proofPublicKey, runId: held.runId ?? null, ...(held.cardId === undefined ? {} : { cardId: held.cardId }) }
  }
  private requireYoloGrant(workspace: Workspace, grantId: string): HeldGrant & { live: NamingControlBinding } {
    const held = this.held.get(grantId)
    if (held === undefined || held.live === null || held.live.signal.aborted || held.workspace !== workspace) {
      auditYolo(workspace.ctx(), { grantId, runId: null, capability: 'yolo.enable', command: 'yolo.enable', result: 'refused' })
      throw new DomainError('unauthorized', 'Only an existing live chat in this folder can receive YOLO.')
    }
    return held as HeldGrant & { live: NamingControlBinding }
  }
  private assertYoloCurrent(ctx: Ctx, grantId: string, held: HeldGrant, binding: NamingControlBinding): void {
    try { this.assertBinding(grantId, held, binding, false) }
    catch (error) {
      auditYolo(ctx, { grantId, runId: held.runId ?? null, capability: 'yolo.enable', command: 'yolo.enable', result: 'refused' })
      throw error
    }
  }
  private async enableYolo(workspace: Workspace, grantId: string, confirm: (detail: string) => Promise<boolean>): Promise<void> {
    const ctx = workspace.ctx()
    const held = this.requireYoloGrant(workspace, grantId)
    const binding = held.live
    this.assertYoloCurrent(ctx, grantId, held, binding)
    const scope = this.yoloBinding(grantId, held, binding)
    await this.deps.yoloReady?.()
    const parent = (await workspace.listGrants()).find((grant) => grant.id === grantId)
    if (!parent?.active) throw new DomainError('unauthorized', 'That grant is no longer active.')
    const expiry = new Date(Math.min(ctx.clock.nowMs() + 24 * 60 * 60_000, Date.parse(parent.expiresAt))).toISOString()
    if (!await confirm(yoloConfirmation(parent, held, binding, expiry))) {
      auditYolo(ctx, { grantId, runId: scope.runId, capability: 'yolo.enable', command: 'yolo.enable', result: 'refused' })
      return
    }
    this.assertYoloCurrent(ctx, grantId, held, binding)
    approveYolo(ctx, scope, expiry)
  }
  private yoloStatus(workspace: Workspace, grantId: string): YoloStatus {
    const ctx = workspace.ctx()
    const audit = listYoloAudit(ctx, { grantId })
    const held = this.held.get(grantId)
    if (!held || !held.live || held.live.signal.aborted || held.workspace !== workspace) return { live: false, expiresAt: null, audit }
    const elevation = ctx.db.get<{ expires_at: string }>('SELECT expires_at FROM yolo_elevations WHERE grant_id = ?', grantId)
    const active = isYoloEligible(ctx, grantId, 'plan.save', held.runId ?? null)
    return { live: true, expiresAt: active ? elevation?.expires_at ?? null : null, audit }
  }
  async yolo(folder: string, grantId: string, action: 'enable' | 'revoke' | 'inspect', confirm: (detail: string) => Promise<boolean>): Promise<YoloStatus> {
    const workspace = this.deps.workspaceFor(folder)
    if (action === 'revoke') revokeYolo(workspace.ctx(), grantId)
    if (action === 'enable') await this.enableYolo(workspace, grantId, confirm)
    return this.yoloStatus(workspace, grantId)
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
    issueReachCli: (targets, grant, ownerFolder) => registry.issueReachCli(targets, grant, ownerFolder),
    issueChatCli: (folder, grant, chat) => registry.issueChatCli(folder, grant, chat),
    revokeChatGrant: (id) => registry.revokeChatGrant(id),
    renewChatGrant: (id) => registry.renewChatGrant(id),
    bindChatGrant: (id, identity) => registry.bindChatGrant(id, identity),
    authorizeNaming: (token) => registry.authorizeNaming(token),
    yolo: (folder, grantId, action, confirm) => registry.yolo(folder, grantId, action, confirm),
    dispose: () => registry.dispose()
  }
}
