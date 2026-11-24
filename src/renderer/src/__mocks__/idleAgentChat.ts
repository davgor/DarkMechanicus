/** GUI chats are unavailable in renderer tests that do not explicitly provide a chat backend. */
import type { AgentChatApi } from '../../../shared/agents/agentChat'

export function idleAgentChat(): AgentChatApi {
  const refused = { ok: false, error: { code: 'unsupported_capability', message: 'Agent chats are not part of this test.' } } as const
  return {
    start: async () => refused,
    send: async () => refused,
    interrupt: async () => refused,
    answer: async () => refused,
    setSurface: async () => refused,
    snapshot: async () => refused,
    onEvent: () => () => {}
  }
}
