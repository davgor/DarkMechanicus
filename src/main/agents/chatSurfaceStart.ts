/**
 * The one launch path of a chat on its stored `surface`: a GUI chat through the one agent-chat session manager, any
 * other chat in its terminal. `launchChatOnSurface` starts a chat with its kickoff (the GUI's first user turn) and says
 * how that went; `startChatOnSurface` answers only why the agent did not start, or null once it runs, and
 * `resumeChatOnSurface` wakes an existing chat with no kickoff (peer and board delivery). Failures that are not
 * DomainErrors are reported to `onError` too.
 */
import { DomainError } from '../../core/errors'
import type { ChatRecord } from '../../shared/agents/chat'
import type { AgentChatSessions, StartResult } from '../agentChat/agentChatSessions'
import type { TerminalSessions, TerminalStart } from '../terminals/terminalSessions'
import { resumeContextChat } from './agentContextDelivery'

interface ChatStarters {
  terminals: Pick<TerminalSessions, 'start'>
  /** The one GUI session manager (`wireAgentChats`); never a second one. */
  agentChats: Pick<AgentChatSessions, 'start'>
  onError?: (error: unknown) => void
}

/** How a launch went: running, refused because the agent is signed out (another agent may be tried), or failed. */
type ChatLaunch = { state: 'running' } | { state: 'signed_out' | 'failed'; message: string }

const SIGNED_OUT = 'The agent is signed out. Sign in from Agents, then start the chat again.'

function guiLaunch(started: StartResult): ChatLaunch {
  if ('code' in started) return { state: 'failed', message: 'The chat is running in a terminal.' }
  if (started.status === 'signed_out') return { state: 'signed_out', message: SIGNED_OUT }
  if (started.status === 'failed' || started.status === 'exited') return { state: 'failed', message: 'The agent process did not start.' }
  return { state: 'running' }
}

/** A terminal start's or paste's answer as a launch. */
export function terminalLaunch(started: TerminalStart): ChatLaunch {
  if (started.state === 'running') return { state: 'running' }
  return { state: started.state === 'signed_out' ? 'signed_out' : 'failed', message: started.message }
}

function launchFailure(deps: Pick<ChatStarters, 'onError'>, error: unknown): ChatLaunch {
  if (!(error instanceof DomainError)) deps.onError?.(error)
  return { state: 'failed', message: error instanceof Error ? error.message : String(error) }
}

export async function launchChatOnSurface(deps: ChatStarters, chat: ChatRecord, kickoff: string): Promise<ChatLaunch> {
  try {
    return chat.surface === 'gui' ? guiLaunch(await deps.agentChats.start(chat, { firstMessage: kickoff })) : terminalLaunch(await deps.terminals.start(chat, { kickoff }))
  } catch (error) {
    return launchFailure(deps, error)
  }
}

export async function startChatOnSurface(deps: ChatStarters, chat: ChatRecord, kickoff: string): Promise<string | null> {
  const launched = await launchChatOnSurface(deps, chat, kickoff)
  return launched.state === 'running' ? null : launched.message
}

interface ChatResumers {
  terminals: Pick<TerminalSessions, 'attach' | 'detach'>
  agentChats: Pick<AgentChatSessions, 'start'>
}

/**
 * Same-chat background activation on the stored surface, with no kickoff: a GUI chat's process started (a running one
 * is left as it is), a terminal chat attached as `resumeContextChat` does. Null once the agent runs, else why not.
 * Refusals throw, as the terminal attach's do, for the caller to record.
 */
export async function resumeChatOnSurface(deps: ChatResumers, chat: ChatRecord): Promise<string | null> {
  if (chat.surface !== 'gui') return resumeContextChat(deps.terminals, chat)
  const launched = guiLaunch(await deps.agentChats.start(chat))
  return launched.state === 'running' ? null : launched.message
}
