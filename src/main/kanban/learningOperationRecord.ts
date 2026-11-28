/**
 * DM-952: the clean-checkout requirement of one learning approval, derived by main from the live workspace.
 *
 * In repo storage mode the core's flush writes the current operation's portable record
 * (`.darkmechanicus/learnings/integrations/<li>.json`) into the registered root checkout before native apply runs.
 * This binding derives that exact path from the workspace's own root and storage mode and the operation this machine
 * prepared and still has open, and has the native layer issue the one allowance for it. In db mode, for an operation
 * this machine does not own, or for any other checkout, the requirement allows nothing. Nothing here takes a path from
 * the renderer or a persisted plan, and the requirement is derived again for every apply or recovery, never stored.
 * DM-956: the workspace is the desktop's own project workspace (`ProjectWorkspace`), whose store lives in its utility
 * process; whether this machine owns the operation is asked of it (`learningApprovalOwned`).
 *
 * DM-982: repo storage writes but never commits the card's own records (card record, events) and, once an approval is
 * published, its integration record and published learnings, so every approval was refused until the person committed
 * them by hand. The allowance therefore also names the card records of this approval and the integration, learning
 * and card records of this machine's published approvals whose text is still exactly what this machine exported
 * (`learningApprovalFiles`), asked of the workspace at the same moment. Nothing is committed, reset, stashed or
 * ignored for the person: the native preflight keeps each of them only while it is untracked and the prepared tree
 * leaves it, and every other path still refuses the approval.
 */
import { relative, sep } from 'node:path'
import { resolveLayout } from '../../core/repo/layout'
import { ownedPaths } from '../../core/repo/paths'
import type { CleanCheckoutRequirement } from '../../shared/git/learningIntegration'
import type { ProjectWorkspace } from '../desktop/workspaceClient'
import { mintOwnedRecordAllowance } from '../git/learningCheckout'

type OperationRecordWorkspace = Pick<ProjectWorkspace, 'repoRoot' | 'getStorageStatus' | 'call'>

export async function learningOperationRecord(workspace: OperationRecordWorkspace, integrationId: string): Promise<CleanCheckoutRequirement> {
  const { storage } = await workspace.getStorageStatus()
  const owned = await workspace.call('learningApprovalOwned', integrationId)
  if (storage.mode !== 'repo' || !owned) return { record: null }
  const file = ownedPaths(resolveLayout(workspace.repoRoot, { mode: 'repo' })).learningIntegrationFile(integrationId)
  const records = await workspace.call('learningApprovalFiles', integrationId)
  return { record: mintOwnedRecordAllowance(workspace.repoRoot, relative(workspace.repoRoot, file).split(sep).join('/'), records) }
}
