/**
 * Which agents a chat found signed out, and what the status the app shows says about them.
 *
 * An agent's CLI can lose its login while the app runs (it expires, or is revoked). A chat learns
 * of it when a turn fails for that reason, but the CLI's own status command, which is what
 * `agents:status` runs, reads only what is stored locally and may still say "signed in". So the app
 * keeps a flag per agent kind: set when a chat reports it, and cleared only when the person has
 * started the agent's sign-in (the Sign in button) and the CLI's status then says signed in. Until then
 * the status the app shows is `signed_out`, for the AGENTS section and every chat alike. A flag lives
 * until the app quits or the agent is signed in again; nothing is written to disk.
 */
import { AGENT_DEFINITIONS } from '../../shared/desktop/agentKinds'
import type { AgentAuthStatus, AgentKind } from '../../shared/desktop/api'

interface Flag {
  /** What the CLI said, as stored in the chat (claim tokens already masked); shown to chats that are refused. */
  message: string
  /** The person started the CLI's sign-in after the flag was set. */
  signInStarted: boolean
}

export interface SignInFlags {
  /** The CLI's words for a signed-out agent, or null when no chat found it signed out. */
  message(kind: AgentKind): string | null
  /** Records that a chat found the agent signed out; a sign-in started earlier no longer counts, since it did not hold. */
  markSignedOut(kind: AgentKind, message: string): void
  /** The person started the CLI's own sign-in; a flag now waits for a status that says signed in. */
  signInStarted(kind: AgentKind): void
  /**
   * The status to show for `kind`, given what the CLI's status command said. `cleared` is true when
   * this answer ended the flag (a sign-in was started and the CLI now says signed in).
   */
  reconcile(kind: AgentKind, status: AgentAuthStatus): { status: AgentAuthStatus; cleared: boolean }
}

export function createSignInFlags(): SignInFlags {
  const flags = new Map<AgentKind, Flag>()
  return {
    message: (kind) => flags.get(kind)?.message ?? null,
    markSignedOut(kind, message) {
      flags.set(kind, { message, signInStarted: false })
    },
    signInStarted(kind) {
      const flag = flags.get(kind)
      if (flag !== undefined) {
        flag.signInStarted = true
      }
    },
    reconcile(kind, status) {
      const flag = flags.get(kind)
      if (flag === undefined) {
        return { status, cleared: false }
      }
      if (flag.signInStarted && status.state === 'signed_in') {
        flags.delete(kind)
        return { status, cleared: true }
      }
      if (status.state === 'signed_out') {
        return { status, cleared: false }
      }
      const name = AGENT_DEFINITIONS[kind].displayName
      return { status: { state: 'signed_out', reason: `${name} asked to sign in again.` }, cleared: false }
    }
  }
}
