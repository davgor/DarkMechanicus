import type { AgentAuthStatus, AgentId } from '../../../shared/desktop/api'
import type { Scheduler } from '../app/scheduler'
import { Button } from '../components/Button'
import type { TerminalKit } from './terminalView'
import { useSignInTerminal, type SignInPhase } from './useSignInTerminal'
import './terminalPane.css'

interface SignInTerminalProps {
  agent: AgentId
  /** What to call the agent: the connected agent's display name. */
  name: string
  kit: TerminalKit
  scheduler: Scheduler
  onStatus?(status: AgentAuthStatus): void
  onSignedIn?(): void
}

function phaseText(phase: SignInPhase, name: string): string {
  switch (phase.state) {
    case 'starting':
      return `Starting the ${name} sign-in…`
    case 'running':
      return `${name}'s own sign-in runs below. Follow its steps; the page it opens in your browser does the signing in.`
    case 'checking':
      return `The sign-in ended. Checking whether ${name} is signed in…`
    case 'signed_in':
      return `Signed in to ${name}.`
    default:
      return phase.message
  }
}

/**
 * The CLI's own login, running in a terminal in this window (`useSignInTerminal`): what the sign-in is doing, then the
 * terminal. Once it ends without signing in, or cannot start, **Sign in again** starts it once more.
 */
export function SignInTerminal({ agent, name, kit, scheduler, onStatus, onSignedIn }: SignInTerminalProps): JSX.Element {
  const { host, phase, focus, again } = useSignInTerminal({ agent, kit, scheduler, onStatus, onSignedIn })
  const retry = phase.state === 'ended' || phase.state === 'failed'
  return (
    <>
      <div className="terminal-ended">
        <p className={phase.state === 'failed' ? 'terminal-notice is-blocking' : 'terminal-notice'} role="status">
          {phaseText(phase, name)}
        </p>
        {retry ? (
          <div className="button-row">
            <Button variant="primary" size="sm" icon="refresh" onClick={again}>
              Sign in again
            </Button>
          </div>
        ) : null}
      </div>
      {/* The host stays laid out while the sign-in starts, so the emulator opens at the pane's real size. */}
      <div className={phase.state === 'failed' ? 'terminal-frame is-empty' : 'terminal-frame'} onClick={focus}>
        <div ref={host} className="terminal-host" data-testid="sign-in-terminal-host" />
      </div>
    </>
  )
}
