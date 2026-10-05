/**
 * The states of the person's account that Claude Code reports as an assistant message's `error`, and that
 * signing in again cannot fix. The names are the Agent SDK's own (`SDKAssistantMessageError` in
 * @anthropic-ai/claude-agent-sdk 0.3.289), and the keys below are typed by them, so a name the SDK drops or
 * renames fails the typecheck. The chat contract names the problems by what they are (`ERROR_PROBLEMS`), not
 * by Claude's words.
 */
import type { SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk'
import type { ErrorProblem } from '../../../shared/agents/chat'

const PROBLEMS = new Map<SDKAssistantMessageError, ErrorProblem>([
  ['oauth_org_not_allowed', 'organization_not_allowed'],
  ['account_on_hold', 'account_on_hold'],
  ['verification_required', 'verification_required']
])

/** What the notice says when the CLI gave no words of its own. */
const FALLBACK_WORDS: Readonly<Record<ErrorProblem, string>> = {
  organization_not_allowed: 'Claude Code says the organization of this account does not allow it to be used here.',
  account_on_hold: 'Claude Code says this account is on hold.',
  verification_required: 'Claude Code says this account has to be verified first.'
}

/** The problem an assistant message's `error` names, or undefined for any other error (a lost sign-in, a rate limit, a failed request). */
export function accountProblemOf(error: SDKAssistantMessageError): ErrorProblem | undefined {
  return PROBLEMS.get(error)
}

/** The notice's words: the CLI's own when it gave some, else a sentence for the problem. */
export function accountWords(problem: ErrorProblem, cliWords: string): string {
  return cliWords === '' ? FALLBACK_WORDS[problem] : cliWords
}
