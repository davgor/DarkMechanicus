/**
 * What counts as an ACP agent saying "sign in again" in an error: the Agent Client Protocol's
 * "authentication required" code (-32000, https://agentclientprotocol.com/protocol/schema), an error
 * message that says so, or what a flavor reads as one in an error the agent words its own way. The code
 * and the words are not captured from a real CLI. Autonomous's own is: a signed-out a8s answers no request
 * at all, it stops at launch and says why on stderr (`autonomous.ts`, DM-307).
 */
import { AcpError } from '../acpClient'

/** The ACP error code for "authentication required". */
const ACP_AUTH_REQUIRED = -32000

const AUTH_WORDS = /\b(?:authentication required|not (?:logged|signed) in|not authenticated|please (?:sign|log) in)\b/i

/** A flavor's reading of an error: the sign-in sentence it carries, or null when it is not about the login. */
export type SignedOutReader = (error: AcpError) => string | null

/** True for an error answer that says the login is missing or no longer good. */
export function isAuthRequired(error: unknown): error is AcpError {
  return error instanceof AcpError && (error.code === ACP_AUTH_REQUIRED || AUTH_WORDS.test(error.message))
}

/** The words to show for an error that says the login is missing or no longer good, the flavor's first; null for any other error. */
export function signInRefusal(error: unknown, readSignedOut?: SignedOutReader): string | null {
  if (!(error instanceof AcpError)) {
    return null
  }
  return readSignedOut?.(error) ?? (isAuthRequired(error) ? error.message : null)
}
