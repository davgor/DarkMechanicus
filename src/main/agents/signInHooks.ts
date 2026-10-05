/**
 * Joins the two places that know whether an agent is signed in: the AGENTS section's `agents:status`
 * and `agents:signIn`, which use the CLI's own commands, and the chats, which find out when a turn
 * fails because the login expired. The CLI's status command reads only what is stored locally, so it
 * can say "signed in" for a login that no longer works; the session manager keeps what the chats
 * found (see `signInFlags.ts`) and corrects the status with it, so every place shows the same state.
 */
import type { AgentAuthHooks } from '../desktop/agentAuth'
import type { SessionManager } from './sessionManager'

/** The hooks the desktop handlers run, with the status corrected by what chats found and a started sign-in noted for them. */
export function trackChatSignIn(hooks: AgentAuthHooks, sessions: Pick<SessionManager, 'reconcileAuthStatus' | 'signInStarted'>): AgentAuthHooks {
  return {
    checkAuth: async (kind, executablePath) => sessions.reconcileAuthStatus(kind, await hooks.checkAuth(kind, executablePath)),
    signIn: async (kind, executablePath) => {
      const result = await hooks.signIn(kind, executablePath)
      if (result.outcome === 'started') {
        sessions.signInStarted(kind)
      }
      return result
    }
  }
}
