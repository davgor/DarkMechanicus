/**
 * The sentence Cursor answers with when its login went stale. A process that lost its login while it
 * ran answers a prompt with the assistant text "Please sign in to continue" and a normal end of turn
 * (Cursor staff confirmed this in https://forum.cursor.com/t/163787); not captured from a real CLI.
 * Only a turn whose whole answer is that sentence counts, so a model that happens to say it among
 * other things is not taken for a rejected login. An error answer that says the same is read by the
 * generic `isAuthRequired` (`acp/acpAuth.ts`).
 */

const SIGN_IN_PROMPT = /^\s*please sign in to continue[.!]?\s*$/i

/** True when `text` is nothing but the sentence Cursor answers with when its login went stale. */
export function isSignInPrompt(text: string): boolean {
  return SIGN_IN_PROMPT.test(text)
}
