/**
 * How a Sign in button anywhere in the app opens the agent's sign-in view (`docs/design/chat-shells.md`, "Sign-in
 * detection"): the shell provides `openSignIn`, which shows the sign-in terminal in `app-main` with a Back control,
 * in place of the screen the button was on (kept, hidden, so Back returns to it as it was).
 */
import { createContext } from 'react'
import type { AgentAuthStatus, AgentId } from '../../../shared/desktop/api'

export interface SignInRequest {
  /** The agent's id: the only thing the sign-in and the status check send. */
  agent: AgentId
  /** What to call the agent: the connected agent's display name. */
  name: string
  /** The status checked once the CLI's login has ended, for the screen that holds the agent's state. */
  onStatus?(status: AgentAuthStatus): void
  /** That status says signed in. */
  onSignedIn?(): void
}

/** Opens the sign-in view; null where no shell provides one, so Sign in cannot be pressed. */
export const SignInContext = createContext<((request: SignInRequest) => void) | null>(null)
