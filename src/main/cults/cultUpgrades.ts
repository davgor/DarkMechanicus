/**
 * Grant upgrades an approved petition gives the running Magos (`docs/design/cults.md`, section 7), without restarting
 * it, and their revocation when the run ends:
 *
 * - **Allow save**: its own grant's `allow_save` is flipped (`setChatGrantAllowSave`), which the next `dm` command
 *   sees, and its chat record's `allowSave` follows. Revoked by flipping both back.
 * - **Folder access**: a new `orchestrator` grant (without Allow save) in that tracked folder's own database, its token
 *   written to a private file in the Magos's scratch folder (`reachTargets`), and attached to the Magos's running
 *   terminal, which renews it with its own grant and revokes it if it exits. Revoked when the run ends, the token
 *   file deleted.
 *
 * Every upgrade is in the ledger until it is revoked, so the start after a crash revokes what the crash left.
 */
import { rm } from 'node:fs/promises'
import { DomainError, fail } from '../../core/errors'
import type { CultRunView } from '../../shared/cults/cult'
import type { ChatGrants } from '../agents/chatGrants'
import { reachTargets } from '../agents/chatReach'
import type { ChatStore } from '../agents/chatStore'
import { ensureScratchFolder } from '../agents/scratchFolder'
import type { TerminalSessions } from '../terminals/terminalSessions'
import type { CultLedger, LedgerGrant } from './cultLedger'

export interface UpgradeDeps {
  userData: string
  chatStore: Pick<ChatStore, 'getChat' | 'updateChat'>
  grants: Pick<ChatGrants, 'setChatGrantAllowSave' | 'issueReachCli' | 'revokeChatGrant'>
  terminals: Pick<TerminalSessions, 'attachGrant' | 'detachGrant'>
  ledger: CultLedger
  /** Revokes a grant through the desktop's own session in its folder: for what a crash left, which no grant registry holds. */
  revokeGrantIn: (folder: string, grantId: string) => Promise<void>
  onError: (error: unknown) => void
}

/** The Magos a petition upgrades: its chat and display name. */
export interface UpgradedMagos {
  chatId: string
  displayName: string
}

/** A grant the Magos no longer holds (revoked when it exited) cannot be flipped back, and needs nothing more. */
function ignoreGone(error: unknown): void {
  if (!(error instanceof DomainError && (error.code === 'not_found' || error.code === 'invalid_state'))) throw error
}

function setRecordAllowSave(deps: UpgradeDeps, entry: Pick<LedgerGrant, 'folder' | 'chatId'>, allowSave: boolean): void {
  try {
    deps.chatStore.updateChat({ folder: entry.folder, id: entry.chatId }, { allowSave })
  } catch (error) {
    deps.onError(error)
  }
}

/** Turns Allow save on for the running Magos's own grant; refused when it holds none. */
export async function grantAllowSave(deps: UpgradeDeps, run: CultRunView, magos: UpgradedMagos): Promise<LedgerGrant> {
  const grantId = deps.chatStore.getChat({ folder: run.workDir, id: magos.chatId })?.grantIds?.at(-1) ?? fail('invalid_state', `${magos.displayName} holds no grant.`)
  const entry: LedgerGrant = { runId: run.id, chatId: magos.chatId, kind: 'allow_save', folder: run.workDir, grantId, tokenFile: null }
  await deps.ledger.addGrant(entry)
  try {
    await deps.grants.setChatGrantAllowSave(grantId, true)
  } catch (error) {
    await deps.ledger.removeGrant(grantId)
    throw error
  }
  setRecordAllowSave(deps, entry, true)
  return entry
}

/** Gives the running Magos an orchestrator grant (no Allow save) in another tracked folder; refused when it has exited. */
export async function grantFolderAccess(deps: UpgradeDeps, run: CultRunView, magos: UpgradedMagos, folder: string): Promise<LedgerGrant> {
  const [target] = reachTargets(ensureScratchFolder(deps.userData, magos.chatId), [folder])
  const label = `${magos.displayName} · Cult folder access`
  const issued = await deps.grants.issueReachCli([target!], { role: 'orchestrator', allowSave: false, runSave: false, label }, run.workDir)
  const grantId = issued.grantIds[0]!
  const entry: LedgerGrant = { runId: run.id, chatId: magos.chatId, kind: 'folder_access', folder, grantId, tokenFile: target!.tokenFile }
  await deps.ledger.addGrant(entry)
  if (!deps.terminals.attachGrant(magos.chatId, grantId)) {
    // Never attached, so no terminal stop revokes it: revoked here, or it would stay usable until it expires.
    await deps.grants.revokeChatGrant(grantId)
    await revokeUpgrade(deps, entry)
    fail('invalid_state', `${magos.displayName} is no longer running.`)
  }
  return entry
}

/** Takes an upgrade back from a member this app session started; see the module comment. */
export async function revokeUpgrade(deps: UpgradeDeps, entry: LedgerGrant): Promise<void> {
  if (entry.kind === 'allow_save') {
    await deps.grants.setChatGrantAllowSave(entry.grantId, false).catch(ignoreGone)
    setRecordAllowSave(deps, entry, false)
  } else {
    // Not attached any more: the terminal's stop or exit took it and revoked it.
    if (deps.terminals.detachGrant(entry.chatId, entry.grantId)) await deps.grants.revokeChatGrant(entry.grantId)
    await rm(entry.tokenFile!, { force: true })
  }
  await deps.ledger.removeGrant(entry.grantId)
}

/** Revokes an upgrade a crash left: through the folder's own desktop session, since no grant registry holds it now. */
export async function revokeLeftUpgrade(deps: UpgradeDeps, entry: LedgerGrant): Promise<void> {
  await deps.revokeGrantIn(entry.folder, entry.grantId)
  if (entry.kind === 'allow_save') setRecordAllowSave(deps, entry, false)
  else await rm(entry.tokenFile!, { force: true })
  await deps.ledger.removeGrant(entry.grantId)
}
