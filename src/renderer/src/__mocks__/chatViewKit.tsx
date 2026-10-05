/** Shared setup for the chat view's component tests: one chat, its stored items and a mounted view over a fake `window.dm`. */
import { render, screen, within } from '@testing-library/react'
import type { ChatItem, ChatRecord } from '../../../shared/agents/chat'
import type { ThreadBinding } from '../../../shared/agents/chatApi'
import type { ThreadLanding, TicketLink } from '../agents/ChatContext'
import { ChatView } from '../agents/ChatView'
import type { AgentAuthStatus, AgentKind } from '../../../shared/desktop/api'
import type { DomainErrorShape } from '../../../shared/domain/errors'
import type { Deferred } from './deferred'
import { FakeDm } from './fakeDm'
import { chatRecord } from './fixtures'
import { settle } from './settle'

export const CHAT = chatRecord({ id: 'chat_1', folder: '/a', title: 'Fix the build', agent: 'claude', model: 'opus', role: 'orchestrator', allowSave: true })

/** What `window.dm.chats` is asked for to name `CHAT`. */
export const REF = { folder: '/a', chatId: 'chat_1' }

const AT = '2026-03-01T10:00:00.000Z'

export const userMessage = (id: string, text: string): ChatItem => ({ id, at: AT, kind: 'user_message', text })
export const assistantText = (id: string, text: string): ChatItem => ({ id, at: AT, kind: 'assistant_text', text })

export function toolCall(id: string, patch: Partial<Extract<ChatItem, { kind: 'tool_call' }>> = {}): ChatItem {
  return { id, at: AT, kind: 'tool_call', name: 'Bash', input: { command: 'npm test' }, status: 'completed', resultSummary: 'Exit code 0', ...patch }
}

export function approvalRequest(requestId: string, patch: Partial<Extract<ChatItem, { kind: 'approval_request' }>> = {}): ChatItem {
  return { id: `item_${requestId}`, at: AT, kind: 'approval_request', requestId, category: 'command', tool: 'Bash', summary: 'Run npm install', input: { command: 'npm install' }, ...patch }
}

export function approvalDecision(requestId: string, decision: 'allow_once' | 'allow_chat' | 'deny' | 'cancelled', automatic?: boolean): ChatItem {
  return { id: `item_answer_${requestId}`, at: AT, kind: 'approval_decision', requestId, decision, ...(automatic === undefined ? {} : { automatic }) }
}

interface MountOptions {
  chat?: ChatRecord
  /** The turn is already running when the chat is opened. */
  running?: boolean
  /** Makes `open` wait: the returned `gate` lets it answer. */
  holdOpen?: boolean
  /** Makes `open` fail with this error until a test clears `dm.chats.failures.open`. */
  openFails?: DomainErrorShape
  /** Makes the agent's model list fail with this error. */
  modelsFail?: DomainErrorShape
  /** What the chat's agent says about its sign-in when asked; left out, the agent's state is unknown. */
  agentStatus?: AgentAuthStatus
  /** Makes the agent's status wait: the returned `statusGate` lets it answer. */
  holdAgentStatus?: boolean
  /** The thread bindings the main process answers for the chat. */
  bindings?: ThreadBinding[]
  /** A thread to open and scroll to, as the shell asks when another screen links to it. */
  landing?: ThreadLanding
  /** Leaves the chat's links unwired, as in a view that has nowhere to go. */
  noNavigation?: boolean
}

export interface Mounted {
  dm: FakeDm
  /** Lets a held `open` answer; null unless `holdOpen` was set. */
  gate: Deferred | null
  /** Lets a held agent status answer; null unless `holdAgentStatus` was set. */
  statusGate: Deferred | null
  /** The statuses the chat's sign-in prompt reported to the shell, oldest first. */
  reported: [AgentKind, AgentAuthStatus][]
  /** What the chat's links asked the shell to open, oldest first. */
  links: { tickets: TicketLink[]; epics: string[]; landed: number }
}

/** Fills the fake desktop with the chat, its stored items and what the options say the main process answers. */
function seedDesktop(dm: FakeDm, chat: ChatRecord, items: ChatItem[], options: MountOptions): void {
  dm.chats.chats = [chat]
  dm.chats.transcripts[chat.id] = items
  if (options.running === true) {
    dm.chats.running.add(chat.id)
  }
  dm.chats.modelLists = {
    claude: [
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' }
    ]
  }
  if (options.modelsFail !== undefined) {
    dm.chats.modelFailures[chat.agent] = options.modelsFail
  }
  if (options.agentStatus !== undefined) {
    dm.agentStatuses[chat.agent] = options.agentStatus
  }
  if (options.openFails !== undefined) {
    dm.chats.failures.open = options.openFails
  }
  if (options.bindings !== undefined) {
    dm.chats.bindings[chat.id] = options.bindings
  }
}

/** Mounts the chat view over a fake desktop that has `chat` with `items` stored, and lets its first requests finish. */
export async function mountChatView(items: ChatItem[] = [], options: MountOptions = {}): Promise<Mounted> {
  const chat = options.chat ?? CHAT
  const dm = new FakeDm()
  window.dm = dm
  seedDesktop(dm, chat, items, options)
  const gate = options.holdOpen === true ? dm.chats.hold('open') : null
  const statusGate = options.holdAgentStatus === true ? dm.holdAgent('agentStatus') : null
  const reported: [AgentKind, AgentAuthStatus][] = []
  const links: Mounted['links'] = { tickets: [], epics: [], landed: 0 }
  const navigation = options.noNavigation === true ? undefined : { openTicket: (link: TicketLink) => links.tickets.push(link), openEpic: (epicId: string) => links.epics.push(epicId) }
  render(
    <ChatView
      chat={chat}
      onAgentStatus={(kind, status) => reported.push([kind, status])}
      {...(navigation === undefined ? {} : { navigation })}
      landing={options.landing ?? null}
      onLanded={() => (links.landed += 1)}
    />
  )
  await settle()
  return { dm, gate, statusGate, reported, links }
}

export const transcript = (): ReturnType<typeof within> => within(screen.getByRole('log', { name: 'Transcript' }))

export const composer = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Message' })
