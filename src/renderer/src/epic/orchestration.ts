/**
 * What the epic workspace needs from the shell to start a run with an agent and to show which chat
 * is orchestrating it: the connected agents (only signed-in ones can be chosen), the folder's chats,
 * and the shell's navigation. The workspace stays on the epic; the shell opens the chat or the
 * add-agent pane only when the person follows a link.
 */
import type { ChatRecord } from '../../../shared/agents/chat'
import type { StartOrchestratorResult } from '../../../shared/agents/chatApi'
import type { AgentAuthStatus, AgentKind, AgentView } from '../../../shared/desktop/api'
import type { RunView } from '../../../shared/domain/views'
import type { AgentStatuses } from '../agents/useAgents'

/** The agent and model that will orchestrate a run; a null model is the agent's default. */
export interface StartRunChoice {
  agent: AgentKind
  model: string | null
}

/** Queues the run and starts the chosen agent as its orchestrator; throws a `CommandError` when nothing was queued. */
export type StartOrchestrator = (choice: StartRunChoice) => Promise<StartOrchestratorResult>

export interface OrchestrationHost {
  /** The connected agents with their sign-in states, as the Agents screens show them. */
  agents: readonly AgentView[]
  statuses: AgentStatuses
  /** The folder's chats; the one orchestrating a run is the one that recorded the run's id. */
  chats: readonly ChatRecord[]
  /** A chat was created for a run: the shell fetches the folder's chats again. */
  onChatsChanged(): void
  /** Opens the add-agent pane. */
  onAddAgent(): void
  /** A sign-in prompt asked an agent's state itself: the shell shows what it found. */
  onAgentStatus(kind: AgentKind, status: AgentAuthStatus): void
  onOpenChat(chatId: string): void
}

/** The chat Dark Mechanicus started to orchestrate the run, if there is one. */
export function orchestratingChat(chats: readonly ChatRecord[], run: RunView): ChatRecord | null {
  return chats.find((chat) => chat.runId === run.id) ?? null
}
