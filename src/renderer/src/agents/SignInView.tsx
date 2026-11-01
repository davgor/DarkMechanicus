import type { Scheduler } from '../app/scheduler'
import { Button } from '../components/Button'
import type { SignInRequest } from './signInContext'
import { SignInTerminal } from './SignInTerminal'
import type { TerminalKit } from './terminalView'
import './chatView.css'
import './terminalPane.css'

interface SignInViewProps {
  request: SignInRequest
  kit: TerminalKit
  scheduler: Scheduler
  /** Leaves the view for the screen Sign in was pressed on; the sign-in stops with it. */
  onBack(): void
}

/**
 * An agent's sign-in, in `app-main` (`docs/design/chat-shells.md`, "Sign-in detection"): what every Sign in button
 * outside a chat opens (the agent page, the add-agent pane, the run bar, the Agents section, the new-chat and Start
 * run dialogs). The CLI's own login runs in the terminal below, in this window; **Back** returns to where it was
 * opened from.
 */
export function SignInView({ request, kit, scheduler, onBack }: SignInViewProps): JSX.Element {
  const title = `Sign in to ${request.name}`
  return (
    <section className="terminal-pane" aria-label={title}>
      <header className="chat-header">
        <div>
          <Button size="sm" onClick={onBack}>
            Back
          </Button>
        </div>
        <span className="eyebrow">SIGN IN</span>
        <h1 className="display chat-title">{title}</h1>
      </header>
      <SignInTerminal
        agent={request.agent}
        name={request.name}
        kit={kit}
        scheduler={scheduler}
        onStatus={request.onStatus}
        onSignedIn={request.onSignedIn}
      />
    </section>
  )
}
