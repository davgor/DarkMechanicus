/**
 * What counts as an ACP agent saying "sign in again" in an error answer: the Agent Client Protocol's
 * "authentication required" code (-32000, https://agentclientprotocol.com/protocol/schema), or, for an
 * agent that words it its own way, an error message that says so. Not captured from a real CLI.
 */
import { AcpError } from '../acpClient'

/** The ACP error code for "authentication required". */
const ACP_AUTH_REQUIRED = -32000

const AUTH_WORDS = /\b(?:authentication required|not (?:logged|signed) in|not authenticated|please (?:sign|log) in)\b/i

/** True for an error answer that says the login is missing or no longer good. */
export function isAuthRequired(error: unknown): error is AcpError {
  return error instanceof AcpError && (error.code === ACP_AUTH_REQUIRED || AUTH_WORDS.test(error.message))
}
