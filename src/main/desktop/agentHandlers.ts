/**
 * The behavior behind the `agents:*` IPC channels, as a pure factory over injected dependencies (no
 * Electron imports). The renderer only ever names an agent kind: the executable to run comes from
 * the native file dialog in this process, never from an IPC payload, so a compromised renderer
 * cannot make main run a program of its choosing.
 */
import { z } from 'zod'
import { parseInput } from '../../core/schemas'
import { AGENT_KINDS } from '../../shared/desktop/agentKinds'
import type { AgentDownloadResult, AgentFindResult, AgentKind, AgentView } from '../../shared/desktop/api'
import type { AgentProbeResult } from './agentProbe'
import type { AgentRegistry } from './agentRegistry'

/** The only input any agent channel takes: one of the closed set of kinds, no paths, no options. */
export const agentKindSchema = z.enum(AGENT_KINDS)

export interface AgentHandlerDeps {
  agents: Pick<AgentRegistry, 'list' | 'upsert' | 'remove'>
  /** Native file dialog for the kind's executable; null when the person cancels. The only source of a path to run. */
  pickExecutable: (kind: AgentKind) => Promise<string | null>
  /** Runs the executable's version flag and says whether it is that kind's CLI (`probeAgent`, wired in main). */
  probeAgent: (kind: AgentKind, executablePath: string) => Promise<AgentProbeResult>
  /** Confirms, downloads, installs, probes and stores a kind's CLI (`createAgentInstaller`, wired in main). Owns the source URL, command and location. */
  installAgent: (kind: AgentKind) => Promise<AgentDownloadResult>
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface AgentHandlers {
  listAgents(): Promise<AgentView[]>
  findAgent(kind: unknown): Promise<AgentFindResult>
  removeAgent(kind: unknown): Promise<AgentView[]>
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
    removeAgent: async (kind) => {
      deps.agents.remove(parseInput(agentKindSchema, kind, 'agent kind'))
      return deps.agents.list()
    },
    downloadAgent: async (kind) => deps.installAgent(parseInput(agentKindSchema, kind, 'agent kind'))
  }
}
