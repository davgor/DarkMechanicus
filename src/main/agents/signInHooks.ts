/**
 * Joins the two places that know whether an agent is signed in: the AGENTS section's `agents:status`,
 * which uses the CLI's own command, and the chats, which find out when a turn fails because the login
 * expired. The CLI's status command reads only what is stored locally, so it can say "signed in" for a
 * login that no longer works; the session manager keeps what the chats found (see `signInFlags.ts`)
 * and corrects the status with it, so every place shows the same state. A status check that says
 * signed in ends what a chat found, whether the person signed in from the app or from a terminal.
 */
import type { AgentAuthHooks } from '../desktop/agentAuth'
import type { SessionManager } from './sessionManager'

/** The hooks the desktop handlers run, with every status check corrected by what chats found. Signing in is the hooks' own. */
export function trackChatSignIn(hooks: AgentAuthHooks, sessions: Pick<SessionManager, 'reconcileAuthStatus'>): AgentAuthHooks {
  return {
    ...hooks,
    checkAuth: async (kind, executablePath) => sessions.reconcileAuthStatus(kind, await hooks.checkAuth(kind, executablePath))
  }
}
