/**
 * The shell side of starting a run with an agent, for epic workspace tests: connected agents and
 * their sign-in states, the folder's chats, and the navigation the workspace asks for, recorded so
 * a test can see what was opened. Test support only.
 */
import type { ChatRecord } from '../../../../shared/agents/chat'
import type { AgentAuthStatus, AgentKind, AgentView } from '../../../../shared/desktop/api'
import { agentView } from '../../__mocks__/fixtures'
import type { OrchestrationHost } from '../orchestration'

export interface FakeOrchestration extends OrchestrationHost {
  /** Times the add-agent pane was asked for. */
  added: { count: number }
  /** The statuses a sign-in prompt reported, oldest first. */
  reportedStatuses: [AgentKind, AgentAuthStatus][]
  /** The chats that were opened. */
  openedChats: string[]
  /** Times the shell was told to fetch the folder's chats again. */
  chatsChanged: { count: number }
}

const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'Signed in as a test user.' }

/** A connected, signed-in agent of `kind`. */
export function readyAgent(kind: AgentKind): { agent: AgentView; status: AgentAuthStatus } {
  return { agent: agentView({ kind, executablePath: `/bin/${kind}`, version: '1.0.0' }), status: SIGNED_IN }
}

export function fakeOrchestration(patch: Partial<OrchestrationHost> = {}): FakeOrchestration {
  const added = { count: 0 }
  const reportedStatuses: [AgentKind, AgentAuthStatus][] = []
  const openedChats: string[] = []
  const chatsChanged = { count: 0 }
  const chats: readonly ChatRecord[] = []
  return {
    agents: [],
    statuses: {},
    chats,
    onChatsChanged: () => {
      chatsChanged.count += 1
    },
    onAddAgent: () => {
      added.count += 1
    },
    onAgentStatus: (kind, status) => reportedStatuses.push([kind, status]),
    onOpenChat: (chatId) => openedChats.push(chatId),
    ...patch,
    added,
    reportedStatuses,
    openedChats,
    chatsChanged
  }
}
