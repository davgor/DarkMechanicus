import { useRef, useState, type ReactNode } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import { canSavePlans } from '../../../shared/agents/chat'
import { GUI_PROTOCOL_KINDS } from '../../../shared/agents/agentChat'
import type { AgentView } from '../../../shared/desktop/api'
import { ROLE_LABELS } from './chatList'

interface ChatHeaderProps {
  chat: ChatRecord
  /** What to call the chat's agent: the connected agent's display name, or its fallback. */
  agentName: string
  /** What stands after the agent: the state of the chat's terminal. */
  fact: ReactNode
  /** The title the chat's terminal set (OSC 0): shown as a line under the chat's own title; nothing when empty or absent. */
  terminalTitle?: string
  /** A Skitarii chat's mascot: dresses the header in the app's Mechanicus style and takes the place of the CHAT eyebrow's agent line. */
  mascot?: ReactNode
  /** Chat-scoped actions beside the title (a Skitarii chat's **Messages**); they never stand in for the terminal. */
  actions?: ReactNode
  surfaceTarget?: { folder: string | null; agentKind: AgentView['kind'] | undefined }
}

const saveText = (chat: ChatRecord): string => (chat.allowSave && canSavePlans(chat.role) ? 'Allowed to save plans' : 'Does not save plans')

/**
 * What the chat is: title, agent, the fact the view puts after it (the terminal's state), role. The agent
 * is text only, since a chat keeps its agent for life; its model is the CLI's own `/model` to change.
 */
export function ChatHeader({ chat, agentName, fact, terminalTitle, mascot, actions, surfaceTarget }: ChatHeaderProps): JSX.Element {
  const [notice, setNotice] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const locked = useRef(false)
  const guiAvailable = surfaceTarget !== undefined && GUI_PROTOCOL_KINDS.some(kind => kind === surfaceTarget.agentKind)
  async function openGui(): Promise<void> {
    if (!guiAvailable || locked.current || surfaceTarget === undefined) return
    locked.current = true
    setSwitching(true)
    setNotice(null)
    try {
      const result = await window.dm.agentChat.setSurface({ folder: surfaceTarget.folder, chatId: chat.id, surface: 'gui' })
      if (!result.ok) setNotice(result.error.message)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not switch to GUI.')
    } finally {
      locked.current = false
      setSwitching(false)
    }
  }
  return (
    <header className={mascot === undefined ? 'chat-header' : 'chat-header is-skitarii'}>
      <span className="eyebrow">{mascot === undefined ? 'CHAT' : agentName}</span>
      <div className="chat-title-row">
        <h1 className="display chat-title">{chat.title}</h1>
        {actions}
        {guiAvailable && <button className="btn btn-sm" type="button" disabled={switching} onClick={() => { void openGui() }}>GUI</button>}
      </div>
      {terminalTitle === undefined || terminalTitle === '' ? null : (
        <p className="chat-terminal-title" data-testid="chat-terminal-title" title={terminalTitle}>
          {terminalTitle}
        </p>
      )}
      {mascot}
      <ul className="chat-facts" aria-label="Chat details">
        {mascot === undefined ? <li>{agentName}</li> : null}
        <li className="chat-model">{fact}</li>
        <li>
          <span className="chat-chip">{ROLE_LABELS[chat.role]}</span>
        </li>
        <li>{saveText(chat)}</li>
      </ul>
      {notice !== null && <p className="note" role="alert">{notice}</p>}
    </header>
  )
}
