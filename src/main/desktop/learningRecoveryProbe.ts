import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { openDatabase } from '../../core/db/database'
import { boundForgeRoot } from '../../core/repo/forgeBinding'
import { resolveLayout } from '../../core/repo/layout'
import { nodeFs } from '../../core/repo/nodeFs'
import { resolveStorageMode } from '../../core/repo/storageMode'
import { LEARNING_INTEGRATION_OPEN_STATES } from '../../shared/domain/learnings'

const OPEN_STATES_SQL = LEARNING_INTEGRATION_OPEN_STATES.map((state) => `'${state}'`).join(', ')

/**
 * DM-983: whether startup recovery must open the folder's workspace to continue learning approvals. A read-only query
 * of the project database (at the root the workspace pool opens) for an open integration this machine owns, so a folder
 * with none never starts a workspace owner. A project without a database or a machine record has nothing this machine
 * owns; any doubt (an unreadable record, a database the query cannot read) answers true and leaves the decision to the
 * workspace's own `pendingLearningApprovals`.
 */
export function mayHavePendingLearningApprovals(folder: string, home: string): boolean {
  try {
    const root = boundForgeRoot(nodeFs, home, realpathSync.native(folder))
    const layout = resolveLayout(root, { mode: resolveStorageMode({ repoRoot: root, homeDir: home, fs: nodeFs }), homeDir: home })
    if (!existsSync(layout.dbFile) || !existsSync(layout.machineFile)) return false
    const record: unknown = JSON.parse(readFileSync(layout.machineFile, 'utf8'))
    const machineId = typeof record === 'object' && record !== null && 'machineId' in record ? record.machineId : undefined
    if (typeof machineId !== 'string') return true
    const db = openDatabase(layout.dbFile, { readOnly: true })
    try {
      return db.get(`SELECT 1 AS found FROM learning_integrations WHERE state IN (${OPEN_STATES_SQL}) AND owner_machine_id = ? LIMIT 1`, machineId) !== undefined
    } finally {
      db.close()
    }
  } catch {
    return true
  }
}
