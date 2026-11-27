import type { AgentAuthStatus, AgentId, AgentView } from '../desktop/api'
import { GUI_PROTOCOL_KINDS } from './agentChat'
import type { ChatRecord } from './chat'

/** Installed agents only; an explicit choice is never replaced by this default. */
export function pickChatAgent(
  agents: readonly AgentView[],
  auth: Readonly<Partial<Record<AgentId, AgentAuthStatus>>>
): { agentId: AgentId; surface: NonNullable<ChatRecord['surface']> } | null {
  const signedIn = (agent: AgentView): boolean => auth[agent.id]?.state === 'signed_in'
  const omp = agents.find(agent => agent.kind === 'omp' && signedIn(agent))
  if (omp !== undefined) return { agentId: omp.id, surface: 'gui' }
  const gui = agents.find(agent => GUI_PROTOCOL_KINDS.some(kind => kind === agent.kind) && signedIn(agent))
  if (gui !== undefined) return { agentId: gui.id, surface: 'gui' }
  const terminal = agents.find(signedIn)
  return terminal === undefined ? null : { agentId: terminal.id, surface: 'terminal' }
}
