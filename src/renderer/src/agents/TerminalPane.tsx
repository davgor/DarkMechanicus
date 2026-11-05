import { useState } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { AgentAuthStatus } from '../../../shared/desktop/api'
import type { Scheduler } from '../app/scheduler'
import { Button } from '../components/Button'
import { StatePill, type PillState } from '../components/StatePill'
import { ChatHeader } from './ChatHeader'
import { EarlierConversation } from './EarlierConversation'
import { SignInTerminal } from './SignInTerminal'
import type { TerminalKit } from './terminalView'
import { useTerminal, type TerminalPhase } from './useTerminal'
import './chatView.css'
import './terminalPane.css'

interface TerminalPaneProps {
  /** The tracked folder the chat belongs to. */
  folder: string
  chat: ChatRecord
  /** What to call the chat's agent: the connected agent's display name, or its fallback. */
  agentName: string
  kit: TerminalKit
  scheduler: Scheduler
  /** The agent's status, as the sign-in card checked it once its login ended. */
  onAgentStatus?(status: AgentAuthStatus): void
}

interface SignInCardProps {
  chat: ChatRecord
  agentName: string
  /** Why the chat did not start: its CLI's status said signed out. */
  message: string
  kit: TerminalKit
  scheduler: Scheduler
  onAgentStatus?(status: AgentAuthStatus): void
  /** The status says signed in once the login ended: the chat starts. */
  onSignedIn(): void
}

/**
 * The sign-in card of a chat whose agent is signed out: why, and **Sign in**, which runs the CLI's own login in a
 * terminal here in the pane (in the home folder, with no grant). Once it ends the status is checked again, and the
 * chat starts when it says signed in.
 */
function SignInCard({ chat, agentName, message, kit, scheduler, onAgentStatus, onSignedIn }: SignInCardProps): JSX.Element {
  const [signingIn, setSigningIn] = useState(false)
  if (signingIn) {
    return <SignInTerminal agent={chat.agent} name={agentName} kit={kit} scheduler={scheduler} onStatus={onAgentStatus} onSignedIn={onSignedIn} />
  }
  return (
    <div className="terminal-sign-in" role="group" aria-label={`Sign in to ${agentName}`}>
      <p className="terminal-notice is-blocking" role="status">
        {message}
      </p>
      <div className="button-row">
        <Button variant="primary" size="sm" onClick={() => setSigningIn(true)}>
          Sign in
        </Button>
      </div>
    </div>
  )
}

/** How the header shows each phase: the pill's color, and its text. */
const PHASE_PILLS: Record<TerminalPhase['state'], { state: PillState; label: string }> = {
  checking: { state: 'waiting', label: 'Checking' },
  running: { state: 'running', label: 'Running' },
  exited: { state: 'completed', label: 'Exited' },
  stopped: { state: 'paused', label: 'Stopped' },
  signed_out: { state: 'blocked', label: 'Signed out' },
  refused: { state: 'blocked', label: 'Refused' },
  failed: { state: 'failed', label: 'Failed' }
}

/** Why the terminal is not running, in main's words: blocking when the CLI did not start. */
function PhaseNotice({ message, blocking }: { message: string; blocking: boolean }): JSX.Element {
  return (
    <p className={blocking ? 'terminal-notice is-blocking' : 'terminal-notice'} role="status">
      {message}
    </p>
  )
}

interface EndedProps {
  notice: JSX.Element | null
  /** The ended CLI ran a resumed session, so a fresh one is offered too. */
  resumed: boolean
  startAgain(options: { newSession: boolean }): void
}

/** A CLI that exited or that main stopped: why, **Start again** on its session, and **New session** after a resumed one. */
function Ended({ notice, resumed, startAgain }: EndedProps): JSX.Element {
  return (
    <div className="terminal-ended">
      {notice}
      <div className="button-row">
        <Button variant="primary" size="sm" icon="refresh" onClick={() => startAgain({ newSession: false })}>
          Start again
        </Button>
        {resumed ? (
          <Button size="sm" onClick={() => startAgain({ newSession: true })}>
            New session
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * An open chat in the main area (`docs/design/chat-shells.md`, "In the app's window"): the chat's header, with
 * the terminal's state where the model was, then its terminal filling the rest of `app-main`, in this window.
 * Opening the chat or clicking the pane focuses the terminal, and every key then goes to the CLI; the app menu's
 * accelerators (Cmd+C/Cmd+V through the Edit role, Cmd+W, Cmd+Q) are handled before the page. A chat whose CLI
 * does not start shows why instead; one whose agent is signed out shows the sign-in card, whose login runs in this
 * pane and starts the chat once the status says signed in. Once the CLI has exited, or main stopped it (idle, a
 * moved folder), its last screen stays with the exit, and **Start again** starts the chat's CLI again on its session;
 * after a resumed session (which the CLI may have refused, in its own words on that screen) **New session** starts a
 * fresh one. A chat that stored a transcript before chats became terminals shows **Earlier conversation** above the
 * terminal, which opens that transcript read-only (`EarlierConversation.tsx`).
 */
export function TerminalPane({ folder, chat, agentName, kit, scheduler, onAgentStatus }: TerminalPaneProps): JSX.Element {
  const { host, phase, background, focus, startAgain } = useTerminal({ folder, chatId: chat.id, agent: chat.agent, kit, scheduler })
  const pill = PHASE_PILLS[phase.state]
  // The host stays laid out while the attach is answered, so the emulator opens at the pane's real size.
  const notStarted = phase.state === 'signed_out' || phase.state === 'refused' || phase.state === 'failed'
  const ended = phase.state === 'exited' || phase.state === 'stopped' ? phase : null
  const notice = 'message' in phase ? <PhaseNotice message={phase.message} blocking={notStarted} /> : null
  return (
    <section className="terminal-pane" aria-label={`Terminal of ${chat.title}`}>
      <ChatHeader
        chat={chat}
        agentName={agentName}
        fact={
          <>
            <span className="chat-fact-label">Terminal</span>
            <StatePill state={pill.state} label={pill.label} />
          </>
        }
      />
      <EarlierConversation folder={folder} chat={chat} agentName={agentName} />
      {phase.state === 'signed_out' ? (
        <SignInCard
          chat={chat}
          agentName={agentName}
          message={phase.message}
          kit={kit}
          scheduler={scheduler}
          onAgentStatus={onAgentStatus}
          onSignedIn={() => startAgain({ newSession: false })}
        />
      ) : ended === null ? (
        notice
      ) : (
        <Ended notice={notice} resumed={ended.resumed} startAgain={startAgain} />
      )}
      <div
        className={notStarted ? 'terminal-frame is-empty' : 'terminal-frame'}
        style={background === null ? undefined : { background }}
        onClick={focus}
      >
        <div ref={host} className="terminal-host" data-testid="terminal-host" />
      </div>
    </section>
  )
}
