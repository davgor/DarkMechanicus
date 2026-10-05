import { useMemo } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { AgentAuthStatus, AgentKind } from '../../../shared/desktop/api'
import { ChatComposer } from './ChatComposer'
import { ChatHeader } from './ChatHeader'
import { ChatTranscript } from './ChatTranscript'
import { agentName } from './agentText'
import { modelLabels } from './chatViewModel'
import { useAgentModels } from './useAgentModels'
import { useChatSession } from './useChatSession'
import './chatView.css'

interface ChatViewProps {
  chat: ChatRecord
  /** The sign-in prompt in the chat asked its agent's state itself: the shell shows what it found. */
  onAgentStatus(kind: AgentKind, status: AgentAuthStatus): void
}

/**
 * The main area for an open chat: header, the transcript (stored items first, then what streams
 * in) and the composer. Opening, sending, stopping and switching the model go through
 * `window.dm.chats`; the view shows what the main process reports.
 */
export function ChatView({ chat, onAgentStatus }: ChatViewProps): JSX.Element {
  const session = useChatSession(chat)
  const models = useAgentModels(chat.agent)
  const offered = models.status === 'ready' ? models.models : null
  const labels = useMemo(() => modelLabels(offered ?? []), [offered])
  return (
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
  )
}
