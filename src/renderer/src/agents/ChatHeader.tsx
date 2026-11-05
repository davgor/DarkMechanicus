import type { ReactNode } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import { canSavePlans } from '../../../shared/agents/chat'
import { ROLE_LABELS } from './chatList'

interface ChatHeaderProps {
  chat: ChatRecord
  /** What to call the chat's agent: the connected agent's display name, or its fallback. */
  agentName: string
  /** What stands after the agent: the state of the chat's terminal. */
  fact: ReactNode
  /** A Skitarii chat's mascot: dresses the header in the app's Mechanicus style and takes the place of the CHAT eyebrow's agent line. */
  mascot?: ReactNode
}

const saveText = (chat: ChatRecord): string => (chat.allowSave && canSavePlans(chat.role) ? 'Allowed to save plans' : 'Does not save plans')

/**
 * What the chat is: title, agent, the fact the view puts after it (the terminal's state), role. The agent
 * is text only, since a chat keeps its agent for life; its model is the CLI's own `/model` to change.
 */
export function ChatHeader({ chat, agentName, fact, mascot }: ChatHeaderProps): JSX.Element {
  return (
    <header className={mascot === undefined ? 'chat-header' : 'chat-header is-skitarii'}>
      <span className="eyebrow">{mascot === undefined ? 'CHAT' : agentName}</span>
      <div className="chat-title-row">
        <h1 className="display chat-title">{chat.title}</h1>
      </div>
      {mascot}
      <ul className="chat-facts" aria-label="Chat details">
        {mascot === undefined ? <li>{agentName}</li> : null}
        <li className="chat-model">{fact}</li>
        <li>
          <span className="chat-chip">{ROLE_LABELS[chat.role]}</span>
        </li>
        <li>{saveText(chat)}</li>
      </ul>
    </header>
  )
}
