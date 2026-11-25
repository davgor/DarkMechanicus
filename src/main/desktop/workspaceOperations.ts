/** Trusted operations exclusive to the project utility process. Each goes through the same Workspace store. */
import { join } from 'node:path'
import type { Ctx } from '../../core/context'
import { DomainError, fail } from '../../core/errors'
import type { Workspace } from '../../core/workspace'
import { DESKTOP_COMMANDS } from '../../shared/desktop/api'
import { NATIVE_COMMANDS, type Work } from './workspaceClient'
import { assertForgeForceSafe } from '../../core/repo/forgeForce'
import { archiveRetiredForgeStore, retireForcedStore } from '../../core/repo/forgeRetirement'
import { verifyForgeExport, verifyForgeExportOwner } from '../../core/repo/forgeExportReceipt'
import type { ForgeExportOptions } from '../../core/repo/storageMigration'
import { layoutUnder, resolveLayout } from '../../core/repo/layout'
import { nodeFs } from '../../core/repo/nodeFs'
import { hasValidatedRepositoryCache } from '../../core/repo/validatedCache'
import { assertStorageIdle } from '../../core/repo/storageMigration'
import type { StorageMode } from '../../core/repo/storageMode'
import { getAttachment, readAttachmentBytes } from '../../core/services/attachments'
import { assertGrantCapability, assertGrantUsable, revokeGrant } from '../../core/services/grants'
import { approveYolo, auditYolo, bindYoloChat, endYoloChat, isYoloEligible, listYoloAudit, revokeYolo } from '../../core/services/yolo'
import * as corrections from '../../core/services/crossRepoCorrections'
import { getHumanAgentMailState, readHumanAgentInbox, markHumanAgentMailSeen, closeAgentMailBinding, renameAgentMailEndpoint, suspendAgentMailEndpoint } from '../../core/services/agentMail'
import { findEndpointByChat, getEndpoint, listOpenEndpoints } from '../../core/services/agentMailStore'
import type { ChatRecord } from '../../shared/agents/chat'
import { bindChatMailbox, deleteChatMailbox, hasMailbox, mailboxName, provisionAll, type MailboxChat } from '../agents/chatMailboxOperations'

function sameProject(workspace: Workspace, projectId: string): Ctx {
  const ctx = workspace.ctx()
  if (ctx.projectId !== projectId) {
    fail('project_mismatch', `The chosen checkout's Dark Mechanicus database belongs to project ${ctx.projectId}, not ${projectId}. Nothing was written to it.`, {
      problem: 'stale_target', targetProjectId: projectId, databaseProjectId: ctx.projectId
    })
  }
  return ctx
}

function endpoint(ctx: Ctx, chat: ChatRecord): string {
  const row = chat.endpointId === undefined || !hasMailbox(chat) ? null : getEndpoint(ctx, chat.endpointId)
  if (row === null || row.chatId !== chat.id || row.machineId !== ctx.machineId || row.state === 'deleting' || row.state === 'deleted') {
    fail('not_found', 'This chat has no mailbox.', { chatId: chat.id })
  }
  return row.id
}

type YoloBinding = Parameters<typeof bindYoloChat>[1]
type MailWindow = Omit<Parameters<typeof readHumanAgentInbox>[1], 'endpointId'>

type Context = () => Ctx

function mailboxOperations(ctx: Context) {
  return {
    attachment(id: string) {
      const context = ctx()
      try {
        const view = getAttachment(context, id)
        return view.missing ? null : { bytes: readAttachmentBytes(context, id), mime: view.mime }
      } catch (error) {
        if (error instanceof DomainError) return null
        throw error
      }
    },
    bindMailbox: (chat: MailboxChat, grantId: string) => bindChatMailbox(ctx(), chat, grantId),
    revokeChatGrant(grantId: string, mailbox: boolean) {
      const context = ctx()
      let mailboxError = false
      if (mailbox) {
        try { closeAgentMailBinding(context, { grantId }) }
        catch { mailboxError = true }
      }
      revokeGrant(context, grantId)
      return mailboxError
    },
    deleteMailbox: (chat: MailboxChat) => deleteChatMailbox(ctx(), chat),
    renameMailbox: (endpointId: string, title: string) => renameAgentMailEndpoint(ctx(), { endpointId, name: mailboxName(title) }),
    suspendMailbox(chatId: string) {
      const context = ctx()
      const row = findEndpointByChat(context, { machineId: context.machineId, chatId })
      if (row?.state === 'open') suspendAgentMailEndpoint(context, { endpointId: row.id })
    },
    listMailboxRoutes(chatIds: readonly string[]) {
      const context = ctx()
      return chatIds.flatMap(chatId => {
        const row = findEndpointByChat(context, { machineId: context.machineId, chatId })
        return row?.state === 'open' ? [{ chatId, endpointId: row.id }] : []
      })
    },
    provisionMailboxes(deleting: readonly string[], chats: readonly MailboxChat[]) {
      const context = ctx()
      for (const id of deleting) deleteChatMailbox(context, { id, agent: 'omp', title: 'Deleted world chat' })
      return provisionAll(context, chats)
    },
    deleteOrphanMailboxes: (ids: readonly string[]) => deleteOrphanMailboxes(ctx(), ids)
  }
}

function deleteOrphanMailboxes(context: Ctx, ids: readonly string[]): void {
  const orphans = new Set(ids)
  let page = listOpenEndpoints(context)
  for (;;) {
    for (const row of page.endpoints) {
      if (row.machineId === context.machineId && orphans.has(row.chatId)) {
        deleteChatMailbox(context, { id: row.chatId, agent: 'omp', title: row.name })
      }
    }
    if (!page.hasMore || page.nextAfterId === null) return
    page = listOpenEndpoints(context, { afterId: page.nextAfterId })
  }
}

function mailReadOperations(ctx: Context) {
  return {
    mailState(chat: ChatRecord) {
      const context = ctx()
      return getHumanAgentMailState(context, { endpointId: endpoint(context, chat) })
    },
    mailRead(chat: ChatRecord, window: MailWindow) {
      const context = ctx()
      return readHumanAgentInbox(context, { ...window, endpointId: endpoint(context, chat) })
    },
    mailSeen(chat: ChatRecord, throughSeq: number) {
      const context = ctx()
      return markHumanAgentMailSeen(context, { endpointId: endpoint(context, chat), throughSeq })
    },
  }
}

function grantOperations(workspace: Workspace, ctx: Context) {
  return {
    issueChatGrant: (input: Parameters<Workspace['issueGrant']>[0]) => workspace.issueGrant(input),
    verifyChatGrant(grantId: string, tokenHash: string, capability: 'chat.name' | 'tooling.recover' | null) {
      const context = ctx()
      if (capability === null) assertGrantUsable(context, grantId)
      else assertGrantCapability(context, grantId, tokenHash, capability)
    },
    bindYoloGrant(yolo: YoloBinding) { bindYoloChat(ctx(), yolo) },
    endYolo: (grantId: string) => endYoloChat(ctx(), grantId),
    refuseYolo: (grantId: string, runId: string | null) => auditYolo(ctx(), { grantId, runId, capability: 'yolo.enable', command: 'yolo.enable', result: 'refused' }),
    approveYolo: (scope: YoloBinding, expiry: string) => approveYolo(ctx(), scope, expiry),
    revokeYolo: (grantId: string) => revokeYolo(ctx(), grantId),
    yoloTime: () => ctx().clock.nowMs(),
    yoloStatus(grantId: string, live: boolean, runId: string | null) {
      const context = ctx()
      const audit = listYoloAudit(context, { grantId })
      if (!live) return { live, expiresAt: null, audit }
      const elevation = context.db.get<{ expires_at: string }>('SELECT expires_at FROM yolo_elevations WHERE grant_id = ?', grantId)
      const active = isYoloEligible(context, grantId, 'plan.save', runId)
      return { live, expiresAt: active ? elevation?.expires_at ?? null : null, audit }
    },
  }
}

function forgeOperations(workspace: Workspace, ctx: Context, home: string) {
  return {
    initialized: () => workspace.isInitialized(),
    /** Machine-local proof, read before this owner reconciles, that the member already holds a validated import. */
    hasValidatedCache: () => hasValidatedRepositoryCache(ctx().db),
    async reconcileMember() {
      const hasLocalCache = hasValidatedRepositoryCache(ctx().db)
      const result = await workspace.reconcileRepository()
      return { result, hasLocalCache }
    },
    checkStorageIdle(force: boolean) {
      const context = ctx()
      if (force) assertForgeForceSafe(context.db)
      else assertStorageIdle({ db: context.db, clock: context.clock, sessionId: context.session.id })
    },
    exportForge(target: string, mode: StorageMode, force = false, setup?: ForgeExportOptions['setup']) {
      workspace.exportForge?.(target, mode, { force, setup })
    },
    verifyForge(target: string, preparing: boolean) {
      const layout = preparing ? layoutUnder(target, 'repo', join(target, '.darkmechanicus.preparing')) : resolveLayout(target)
      const verify = preparing ? verifyForgeExportOwner : verifyForgeExport
      verify({ fs: nodeFs, layout, source: workspace.repoRoot }, ctx().projectId)
    },
    retireForcedForge(source: string, member: string, mode?: StorageMode) {
      retireForcedStore(home, source, member, mode)
    },
    archiveRetiredForge(source: string, member: string) {
      archiveRetiredForgeStore(home, source, member)
    },
  }
}

function correctionOperations(workspace: Workspace, ctx: Context) {
  return {
    beginCorrection: (...args: Tail<typeof corrections.beginCrossRepoCorrection>) => corrections.beginCrossRepoCorrection(ctx(), ...args),
    requestedCorrection: (...args: Tail<typeof corrections.requestedCrossRepoCorrection>) => corrections.requestedCrossRepoCorrection(ctx(), ...args),
    correctionLink: (...args: Tail<typeof corrections.crossRepoCorrectionLink>) => corrections.crossRepoCorrectionLink(ctx(), ...args),
    recordCorrection: (...args: Tail<typeof corrections.recordCrossRepoDelivery>) => corrections.recordCrossRepoDelivery(ctx(), ...args),
    failCorrection: (...args: Tail<typeof corrections.recordCrossRepoFailure>) => corrections.recordCrossRepoFailure(ctx(), ...args),
    discardCorrection: (...args: Tail<typeof corrections.discardCrossRepoCorrection>) => corrections.discardCrossRepoCorrection(ctx(), ...args),
    listCorrections: (...args: Tail<typeof corrections.listCrossRepoCorrections>) => corrections.listCrossRepoCorrections(ctx(), ...args),
    previewCorrection(...args: Tail<typeof corrections.previewCrossRepoSource>) {
      const context = ctx()
      const side = corrections.previewCrossRepoSource(context, ...args)
      const planned = side.packet === null ? null : corrections.plannedTickets(side.packet, corrections.placeholderDeps(context))
      return { side, draft: { tickets: planned?.tickets ?? [], dependencies: planned?.dependencies ?? [], validation: null } }
    },
    recordCorrectionResults(key: string, data: ReturnType<typeof corrections.crossRepoResults>) {
      const context = ctx()
      return corrections.recordCrossRepoResults(context, key, { ...data, readAt: context.clock.nowIso() })
    },
    holdCorrection(projectId: string, ...args: Tail<typeof corrections.heldCorrection>) {
      return corrections.heldCorrection(sameProject(workspace, projectId), ...args)
    },
    correctionResults(projectId: string, ...args: Tail<typeof corrections.crossRepoResults>) {
      return corrections.crossRepoResults(sameProject(workspace, projectId), ...args)
    },
    previewCorrectionTarget(projectId: string, ...args: Tail<typeof corrections.previewCrossRepoTarget>) {
      return corrections.previewCrossRepoTarget(sameProject(workspace, projectId), ...args)
    },
    materializeCorrection(projectId: string, ...args: Tail<typeof corrections.materializeCrossRepoCorrection>) {
      return corrections.materializeCrossRepoCorrection(sameProject(workspace, projectId), ...args)
    }
  }
}

function workspaceOperations(workspace: Workspace, home: string) {
  const ctx = () => workspace.ctx()
  return { ...mailboxOperations(ctx), ...mailReadOperations(ctx), ...grantOperations(workspace, ctx),
    ...forgeOperations(workspace, ctx, home), ...correctionOperations(workspace, ctx) }
}

type Tail<F> = F extends (ctx: Ctx, ...args: infer Args) => unknown ? Args : never
export type NativeOperations = ReturnType<typeof workspaceOperations>

const commands: ReadonlySet<string> = new Set([...DESKTOP_COMMANDS, ...NATIVE_COMMANDS])

export async function runWorkspaceOperation(workspace: Workspace, work: Work, home: string): Promise<unknown> {
  switch (work.kind) {
    case 'command':
      if (!commands.has(work.name)) throw new DomainError('unauthorized', 'That command is unavailable to the desktop.')
      const invoke = workspace[work.name] as (input: unknown) => Promise<unknown>
      return invoke.call(workspace, work.input)
    case 'heartbeat':
      workspace.heartbeat()
      return undefined
    case 'native': {
      const operations = workspaceOperations(workspace, home)
      if (!Object.hasOwn(operations, work.name)) throw new DomainError('unauthorized', 'That workspace operation is unavailable.')
      return (operations[work.name] as (...args: readonly unknown[]) => unknown)(...work.args)
    }
  }
}
