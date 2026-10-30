/**
 * The behavior behind the `agents:*` IPC channels, as a pure factory over injected dependencies (no
 * Electron imports). The renderer only ever names a built-in agent kind (find, download), an agent
 * id, or a custom CLI's name, protocol and arguments (`customAgent.ts`): the executable to run comes
 * from the native file dialog in this process or the registry, never from an IPC payload, so a
 * compromised renderer cannot make main run a program of its choosing.
 */
import { z } from 'zod'
import { DomainError } from '../../core/errors'
import { parseInput } from '../../core/schemas'
import { AGENT_KINDS, agentIdSchema } from '../../shared/desktop/agentKinds'
import type { AgentDownloadResult, AgentFindResult, AgentView, BuiltInAgentKind } from '../../shared/desktop/api'
import { DOWNLOADABLE_AGENT_KINDS, type DownloadableAgentKind } from './agentInstallRecipes'
import type { AgentProbeResult } from './agentProbe'
import type { AgentRegistry } from './agentRegistry'
import type { CustomAgents } from './customAgent'

/** What `agents:find` takes: one of the built-in kinds, no paths, no options. */
export const agentKindSchema = z.enum(AGENT_KINDS)

/** What `agents:download` takes: a kind the app has an installer for (not Autonomous), no paths, no options. */
const downloadableAgentKindSchema = z.enum(DOWNLOADABLE_AGENT_KINDS)

/**
 * The connected agent an IPC payload names. A malformed id is refused with `invalid_input` and an id
 * that is not connected with `not_found`, so nothing runs for either.
 */
export function connectedAgent(agents: Pick<AgentRegistry, 'get'>, input: unknown): AgentView {
  const id = parseInput(agentIdSchema, input, 'agent id')
  const agent = agents.get(id)
  if (agent === null) {
    throw new DomainError('not_found', `No connected agent has the id ${id}. Connect it under Agents first.`)
  }
  return agent
}

export interface AgentHandlerDeps {
  agents: Pick<AgentRegistry, 'list' | 'get' | 'upsert' | 'remove'>
  /** Adds and edits custom CLIs, each through the file dialog, the checks, the confirmation and the handshake (`createCustomAgents`). */
  customAgents: CustomAgents
  /** Ends the live chat processes of an agent that was removed (`SessionManager.endAgentSessions`). */
  endAgentSessions: (id: AgentView['id']) => Promise<void>
  /** Native file dialog for the kind's executable; null when the person cancels. The only source of a path to run. */
  pickExecutable: (kind: BuiltInAgentKind) => Promise<string | null>
  /** Runs the executable's version flag and says whether it is that kind's CLI (`probeAgent`, wired in main). */
  probeAgent: (kind: BuiltInAgentKind, executablePath: string) => Promise<AgentProbeResult>
  /** Confirms, downloads, installs, probes and stores a kind's CLI (`createAgentInstaller`, wired in main). Owns the source URL, command and location. */
  installAgent: (kind: DownloadableAgentKind) => Promise<AgentDownloadResult>
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface AgentHandlers {
  listAgents(): Promise<AgentView[]>
  findAgent(kind: unknown): Promise<AgentFindResult>
  /** Removes the row (a custom agent's folder defaults go with it through the cascade), then stops its chats' processes. */
  removeAgent(id: unknown): Promise<AgentView[]>
  addCustomAgent(request: unknown): Promise<AgentFindResult>
  updateCustomAgent(request: unknown): Promise<AgentFindResult>
  downloadAgent(kind: unknown): Promise<AgentDownloadResult>
}

/** Picks, verifies, and only then stores: a cancelled or refused pick leaves the registry as it was. */
async function findAgent(deps: AgentHandlerDeps, input: unknown): Promise<AgentFindResult> {
  const kind = parseInput(agentKindSchema, input, 'agent kind')
  const executablePath = await deps.pickExecutable(kind)
  if (executablePath === null) {
    return { outcome: 'cancelled' }
  }
  const probe = await deps.probeAgent(kind, executablePath)
  if (!probe.ok) {
    return { outcome: 'refused', code: probe.code, reason: probe.reason }
  }
  const agent = deps.agents.upsert({ kind, executablePath, version: probe.version, connectedVia: 'found' })
  return { outcome: 'connected', agent }
}

export function createAgentHandlers(deps: AgentHandlerDeps): AgentHandlers {
  return {
    listAgents: async () => deps.agents.list(),
    findAgent: (kind) => findAgent(deps, kind),
    addCustomAgent: (request) => deps.customAgents.add(request),
    updateCustomAgent: (request) => deps.customAgents.update(request),
    removeAgent: async (input) => {
      const { id } = connectedAgent(deps.agents, input)
      // The row goes first, so no chat can start the agent again while its processes are being ended.
      deps.agents.remove(id)
      await deps.endAgentSessions(id)
      return deps.agents.list()
    },
    downloadAgent: async (kind) => deps.installAgent(parseInput(downloadableAgentKindSchema, kind, 'downloadable agent kind'))
  }
}
