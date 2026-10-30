/**
 * The default agent CLI of each tracked folder, stored in the `folder_agent_defaults` table of the app
 * database and keyed by the folder's canonical path. Removing an agent clears its rows through the
 * foreign key's cascade; untracking a folder clears its row through `set(folder, null)`.
 */
import { z } from 'zod'
import type { Db } from '../../core/db/database'
import { parseInput } from '../../core/schemas'
import { agentIdSchema } from '../../shared/desktop/agentKinds'
import type { AgentId } from '../../shared/desktop/api'
import { connectedAgent } from './agentHandlers'
import type { AgentRegistry } from './agentRegistry'

export interface FolderAgentDefaults {
  /** The default agent id of this canonical folder path, or null. */
  get(folder: string): AgentId | null
  /** Sets the default of this canonical folder path; null deletes it. */
  set(folder: string, agentId: AgentId | null): void
}

export function createFolderAgentDefaults(options: {
  db: Db
  /** ISO timestamp source for `updated_at`. */
  now?: () => string
}): FolderAgentDefaults {
  const { db } = options
  const now = options.now ?? (() => new Date().toISOString())
  return {
    get: (folder) =>
      db.get<{ agent_id: AgentId }>('SELECT agent_id FROM folder_agent_defaults WHERE folder = ?', folder)?.agent_id ??
      null,
    set: (folder, agentId) => {
      if (agentId === null) {
        db.run('DELETE FROM folder_agent_defaults WHERE folder = ?', folder)
        return
      }
      db.run(
        `INSERT INTO folder_agent_defaults (folder, agent_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (folder) DO UPDATE SET agent_id = excluded.agent_id, updated_at = excluded.updated_at`,
        folder,
        agentId,
        now()
      )
    }
  }
}

const setFolderDefaultSchema = z.strictObject({
  folder: z.unknown(),
  agentId: agentIdSchema.nullable()
})

export interface FolderDefaultHandlerDeps {
  folderDefaults: FolderAgentDefaults
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface FolderDefaultHandlers {
  folderDefaultAgent(folder: unknown): Promise<AgentId | null>
  setFolderDefaultAgent(request: unknown): Promise<AgentId | null>
}

/**
 * `requireTracked` canonicalizes the folder and refuses an untracked one with `unauthorized`; a
 * malformed agent id is `invalid_input` and one that is not connected `not_found`.
 */
export function createFolderDefaultHandlers(
  deps: FolderDefaultHandlerDeps & { agents: Pick<AgentRegistry, 'get'> },
  requireTracked: (folder: unknown) => string
): FolderDefaultHandlers {
  return {
    folderDefaultAgent: async (folder) => deps.folderDefaults.get(requireTracked(folder)),
    setFolderDefaultAgent: async (request) => {
      const { folder, agentId } = parseInput(setFolderDefaultSchema, request, 'folder default agent')
      const tracked = requireTracked(folder)
      const id = agentId === null ? null : connectedAgent(deps.agents, agentId).id
      deps.folderDefaults.set(tracked, id)
      return id
    }
  }
}
