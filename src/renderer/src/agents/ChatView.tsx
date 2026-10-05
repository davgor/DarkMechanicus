import { useMemo } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { AgentAuthStatus, AgentKind } from '../../../shared/desktop/api'
import { ChatComposer } from './ChatComposer'
import { ChatContext, type ChatNavigation, type ThreadLanding } from './ChatContext'
import { ChatHeader } from './ChatHeader'
import { ChatTranscript } from './ChatTranscript'
import { agentName } from './agentText'
import { modelLabels } from './chatViewModel'
import { useAgentModels } from './useAgentModels'
import { useChatLinks } from './useChatLinks'
import { useChatSession } from './useChatSession'
import './chatThreads.css'
import './chatView.css'

interface ChatViewProps {
  chat: ChatRecord
  /** The sign-in prompt in the chat asked its agent's state itself: the shell shows what it found. */
  onAgentStatus(kind: AgentKind, status: AgentAuthStatus): void
  /** Where the markers and bound threads of the chat lead; without it they are shown but do not link. */
  navigation?: ChatNavigation
  /**
   * A thread to show open and scrolled into view, when another screen links to it (the shell's `openThread`).
   * A new object per request; the view takes it once and calls `onLanded`, so the shell can forget it.
   */
  landing?: ThreadLanding | null
  onLanded?(): void
}

function noop(): void {}

/**
 * The main area for an open chat: header, the transcript (stored items first, then what streams
 * in) and the composer. Opening, sending, stopping and switching the model go through
 * `window.dm.chats`; the view shows what the main process reports. The thread blocks and action
 * markers in the transcript get their links, bound threads and the thread to show from `ChatContext`.
 */
export function ChatView({ chat, onAgentStatus, navigation, landing = null, onLanded = noop }: ChatViewProps): JSX.Element {
  const session = useChatSession(chat)
  const links = useChatLinks({ chat, session, navigation: navigation ?? null, landing, onLanded })
  const models = useAgentModels(chat.agent)
  const offered = models.status === 'ready' ? models.models : null
  const labels = useMemo(() => modelLabels(offered ?? []), [offered])
  return (
    <ChatContext.Provider value={links}>
      <section className="chat-view">
        <ChatHeader
          chat={chat}
          model={session.model}
          models={models}
          running={session.running}
          switching={session.switching}
          onSwitchModel={(model) => void session.switchModel(model)}
        />
        <ChatTranscript
          phase={session.phase}
          entries={session.entries}
          labels={labels}
          running={session.running}
          openError={session.openError}
          folder={chat.folder}
          onAnswer={session.answerApproval}
          auth={session.auth}
          onSignedIn={session.signedIn}
          onRetryTurn={session.retryTurn}
          onAgentStatus={onAgentStatus}
          onRetry={session.reopen}
        />
        <ChatComposer
          ready={session.phase === 'ready'}
          signedOutOf={session.auth.agent === 'signed_out' ? agentName(chat.agent) : null}
          running={session.running}
          stopping={session.stopping}
          error={session.actionError}
          onSend={session.send}
          onStop={() => void session.stop()}
        />
      </section>
    </ChatContext.Provider>
  )
}
