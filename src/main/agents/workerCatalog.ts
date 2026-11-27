/**
 * The worker-model catalog Start run hands a Skitarii (OMP) Magos: main lists the agent's OMP catalog without a
 * session (`ompModels.ts`), maps it to a `register_host` input (`core/hostCatalogs/omp.ts`) and writes it to a private
 * file in the chat's own OMP folder (removed with the chat). The kickoff names the file in one fixed line; the Magos
 * still registers it itself, so its authority is unchanged and the payload is never a value a model wrote.
 */
import { dirname, join } from 'node:path'
import { ompHostCatalog } from '../../core/hostCatalogs/omp'
import type { ChatRecord } from '../../shared/agents/chat'
import type { AgentId, AgentView } from '../../shared/desktop/api'
import type { OmpModels } from '../agentChat/ompModels'
import { ompFilePaths } from '../terminals/ompSession'
import { writePrivateFile } from '../terminals/privateFile'

const CATALOG_FILE = 'host-catalog.json'

interface WorkerCatalogDeps {
  userData: string
  models: Pick<OmpModels, 'catalogModels'>
  agentFor(id: AgentId): AgentView | null
  write?: (path: string, text: string) => Promise<void>
}

/** Writes the chat's catalog file and answers its path; null for a chat whose agent is not OMP. */
export type WorkerCatalog = (chat: Pick<ChatRecord, 'id' | 'agent' | 'model'>) => Promise<string | null>

export function createWorkerCatalog(deps: WorkerCatalogDeps): WorkerCatalog {
  const write = deps.write ?? ((path: string, text: string) => writePrivateFile(path, text, 0o600))
  return async (chat) => {
    if (deps.agentFor(chat.agent)?.kind !== 'omp') return null
    const catalog = ompHostCatalog(await deps.models.catalogModels(chat.agent), chat.model)
    const path = join(dirname(ompFilePaths(deps.userData, chat.id).config), CATALOG_FILE)
    await write(path, `${JSON.stringify(catalog, null, 2)}\n`)
    return path
  }
}

/** The fixed kickoff line naming the file. */
export function workerCatalogLine(path: string): string {
  return `Worker models: this app wrote this host's register_host input to ${JSON.stringify(path)}. Register it with register_host as written, with canSelectWorkerModel true, before start_run; then start each worker with your task tool's model set to the claimed modelId and the claimed effort as its thinking level (get_context topic host-catalog).`
}
