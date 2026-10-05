/**
 * What counts as Cursor saying "sign in again". Two shapes, neither captured from a real CLI:
 *
 * - An error answer from `agent acp`: the Agent Client Protocol's "authentication required" code
 *   (-32000, https://agentclientprotocol.com/protocol/schema), or, for a Cursor that words it its own
 *   way, an error message that says so.
 * - A process that lost its login while it ran answers a prompt with the assistant text "Please sign
 *   in to continue" and a normal end of turn (Cursor staff confirmed this in
 *   https://forum.cursor.com/t/163787). Only a turn whose whole answer is that sentence counts, so a
 *   model that happens to say it among other things is not taken for a rejected login.
 */
import { AcpError } from './acpClient'

/** The ACP error code for "authentication required". */
const ACP_AUTH_REQUIRED = -32000

const AUTH_WORDS = /\b(?:authentication required|not (?:logged|signed) in|not authenticated|please (?:sign|log) in)\b/i

const SIGN_IN_PROMPT = /^\s*please sign in to continue[.!]?\s*$/i

/** True for an error answer that says the login is missing or no longer good. */
export function isAuthRequired(error: unknown): error is AcpError {
  return error instanceof AcpError && (error.code === ACP_AUTH_REQUIRED || AUTH_WORDS.test(error.message))
}

/** True when `text` is nothing but the sentence Cursor answers with when its login went stale. */
export function isSignInPrompt(text: string): boolean {
  return SIGN_IN_PROMPT.test(text)
}
