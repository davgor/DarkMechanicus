/**
 * What `agent acp` does when the person's Cursor login is gone, as far as it is documented. NOT
 * captured from a running Cursor CLI (it is not installed where this was written, and no real
 * expired session could be made). The shapes and where each comes from:
 *
 * - A process that started signed in and lost its login while it was running answers the next
 *   `session/prompt` with a normal `agent_message_chunk` saying "Please sign in to continue" and then
 *   `stopReason: "end_turn"`: a Cursor staff member confirmed that the ACP layer turns the auth error
 *   into ordinary assistant text (https://forum.cursor.com/t/cursor-agent-acp-live-process-returns-
 *   sign-in-prompt-as-assistant-content-after-auth-state-goes-stale/163787, CLI 2026.06.19). This is
 *   the only wording Cursor documents for it, so it is the only text the adapter takes for a sign-in
 *   prompt.
 * - A request the agent refuses for want of a login is the Agent Client Protocol's own error:
 *   JSON-RPC code -32000, "Authentication required" (https://agentclientprotocol.com/protocol/schema:
 *   `authenticate` and `session/new` "may return an `auth_required` error"). Cursor's page
 *   (https://cursor.com/docs/cli/acp) says which method signs in (`authenticate`, `cursor_login`) but
 *   not what a refusal looks like, so the same code is assumed on `authenticate`, `session/new`,
 *   `session/load` and `session/prompt`, with the spec's words.
 *
 * Not shipped.
 */
import { ACP_DM_SERVER, FOLDER, handshake, loadSession, newSession, prompt, say, turnEnd } from './cursorRecordings'
import { agent, client, type Frame } from './replayAcpAgent'

export const SESSION = 'sess_1'

/** The text Cursor puts in the assistant message when its login went stale (see above). */
export const SIGN_IN_PROMPT = 'Please sign in to continue'

/** The ACP error code and words for "authentication required". */
export const AUTH_REQUIRED = { code: -32000, message: 'Authentication required' }

const refuse = (id: number): Frame => agent({ id, error: AUTH_REQUIRED })

/** A process that was signed in, whose login then went stale: the prompt is answered with the sign-in text. */
export function staleProcess(id = 3): Frame[] {
  return [...handshake(), ...newSession(id, SESSION), prompt(id + 1, SESSION, 'hello'), say(SESSION, SIGN_IN_PROMPT), turnEnd(id + 1)]
}

/** `authenticate` is refused: the handshake never gets past it. */
export function authenticateRefused(): Frame[] {
  return [...handshake().slice(0, 2), client({ id: 2, method: 'authenticate', params: { methodId: 'cursor_login' } }), refuse(2)]
}

/** `session/new` is refused after a good handshake. */
export function newSessionRefused(): Frame[] {
  return [
    ...handshake(),
    client({ id: 3, method: 'session/new', params: { cwd: FOLDER, mcpServers: [ACP_DM_SERVER] } }),
    refuse(3)
  ]
}

/** `session/load` is refused after a good handshake. */
export function loadRefused(): Frame[] {
  return [
    ...handshake(),
    client({ id: 3, method: 'session/load', params: { sessionId: SESSION, cwd: FOLDER, mcpServers: [ACP_DM_SERVER] } }),
    refuse(3)
  ]
}

/** A process that is signed in when the session opens, and refuses the prompt. */
export function promptRefused(): Frame[] {
  return [...handshake(), ...newSession(3, SESSION), prompt(4, SESSION, 'hello'), refuse(4)]
}

/** The next process after the person signed in: it loads the stored session and answers. */
export function signedInAgain(): Frame[] {
  return [...handshake(), ...loadSession(3, SESSION), prompt(4, SESSION, 'hello again'), say(SESSION, 'Back in.'), turnEnd(4)]
}
