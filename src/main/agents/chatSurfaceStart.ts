/**
 * Starts a newly created chat on its stored `surface`: a GUI chat through the one agent-chat session manager, with the
 * kickoff as its first user turn; any other chat in its terminal with the kickoff, as before. Resolves with why the
 * agent did not start, or null once it runs. Failures that are not DomainErrors are reported to `onError` too.
 */
import { DomainError } from '../../core/errors'
import type { ChatRecord } from '../../shared/agents/chat'
import type { AgentChatSessions } from '../agentChat/agentChatSessions'
import type { TerminalSessions } from '../terminals/terminalSessions'

interface ChatStarters {
  terminals: Pick<TerminalSessions, 'start'>
  /** The one GUI session manager (`wireAgentChats`); never a second one. */
  agentChats: Pick<AgentChatSessions, 'start'>
  onError?: (error: unknown) => void
}

async function startGui(deps: ChatStarters, chat: ChatRecord, kickoff: string): Promise<string | null> {
  const started = await deps.agentChats.start(chat, { firstMessage: kickoff })
  if ('code' in started) return 'The chat is running in a terminal.'
  if (started.status === 'signed_out') return 'The agent is signed out. Sign in from Agents, then start the chat again.'
  if (started.status === 'failed' || started.status === 'exited') return 'The agent process did not start.'
  return null
}

async function startTerminal(deps: ChatStarters, chat: ChatRecord, kickoff: string): Promise<string | null> {
  const started = await deps.terminals.start(chat, { kickoff })
  return started.state === 'running' ? null : started.message
}

export async function startChatOnSurface(deps: ChatStarters, chat: ChatRecord, kickoff: string): Promise<string | null> {
  try {
    return chat.surface === 'gui' ? await startGui(deps, chat, kickoff) : await startTerminal(deps, chat, kickoff)
  } catch (error) {
    if (!(error instanceof DomainError)) deps.onError?.(error)
    return error instanceof Error ? error.message : String(error)
  }
}
