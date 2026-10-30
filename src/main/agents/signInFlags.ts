/**
 * Which agents a chat found signed out, and what the status the app shows says about them.
 *
 * An agent's CLI can lose its login while the app runs (it expires, or is revoked). A chat learns
 * of it when a turn fails for that reason, and the CLI's own status command, which is what
 * `agents:status` runs, may not say so yet. So the app keeps a flag per agent id: set when a chat
 * reports it, and cleared by the next status check that says signed in, however the person signed in
 * (the app's Sign in button, or the CLI's own login in a terminal of their own). Until then the status
 * the app shows is `signed_out`, for the AGENTS section and every chat alike. A flag lives until the
 * app quits or the agent is signed in again; nothing is written to disk.
 */
import type { AgentAuthStatus, AgentId } from '../../shared/desktop/api'

export interface SignInFlags {
  /** The CLI's words for a signed-out agent, or null when no chat found it signed out. */
  message(id: AgentId): string | null
  /** Records that a chat found the agent signed out; a sign-in that came earlier no longer counts, since it did not hold. */
  markSignedOut(id: AgentId, message: string): void
  /**
   * The status to show for agent `id`, given what the CLI's status command said. `cleared` is true when
   * this answer ended the flag (the CLI now says signed in).
   */
  reconcile(id: AgentId, status: AgentAuthStatus): { status: AgentAuthStatus; cleared: boolean }
}

/** `nameOf` gives the agent's display name for the status it corrects. */
export function createSignInFlags(nameOf: (id: AgentId) => string): SignInFlags {
  /** What the CLI said, as stored in the chat (claim tokens already masked); shown to chats that are refused. */
  const flags = new Map<AgentId, string>()
  return {
    message: (id) => flags.get(id) ?? null,
    markSignedOut(id, message) {
      flags.set(id, message)
    },
    reconcile(id, status) {
      if (!flags.has(id)) {
        return { status, cleared: false }
      }
      if (status.state === 'signed_in') {
        flags.delete(id)
        return { status, cleared: true }
      }
      if (status.state === 'signed_out') {
        return { status, cleared: false }
      }
      return { status: { state: 'signed_out', reason: `${nameOf(id)} asked to sign in again.` }, cleared: false }
    }
  }
}
