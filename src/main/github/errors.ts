/**
 * Failures of GitHub sign-in and API calls. Every message is fixed text written here: none is built
 * from a request, a response or a caught error, so neither can carry the token into a result, a
 * broadcast or a log line. A `detail` (the tail of the GitHub CLI's stderr) is scrubbed of anything
 * token-like before it is set.
 */
import type { GitErrorCode } from '../../shared/git/errors'
import type { GithubErrorCode } from '../../shared/github/errors'

export type GithubFailureCode =
  | GithubErrorCode
  | Extract<GitErrorCode, 'auth_required' | 'auth_failed' | 'cancelled' | 'network_unreachable'>

const MESSAGES: Record<GithubFailureCode, string> = {
  gh_not_installed: 'The GitHub CLI (gh) is not installed. Install it from https://cli.github.com, run `gh auth login`, then try again.',
  gh_not_signed_in:
    'The GitHub CLI is not signed in to github.com, or is older than 2.17. Run `gh auth login -h github.com` (update gh first if needed), then try again.',
  gh_missing_scope:
    "The GitHub CLI's login cannot reach your repositories (it lacks the repo scope). Run `gh auth refresh -h github.com -s repo,workflow`, then try again.",
  secure_storage_unavailable: 'This computer has no secure storage to encrypt the GitHub token, so Dark Mechanicus will not sign in.',
  github_failed: 'GitHub answered unexpectedly.',
  auth_required: 'Sign in to GitHub again: the sign-in is missing or no longer valid.',
  auth_failed: "GitHub refused the GitHub CLI's token. Run `gh auth login -h github.com`, then try again.",
  cancelled: 'Sign-in was cancelled.',
  network_unreachable: 'Could not reach GitHub. Check the connection and try again.'
}

export class GithubError extends Error {
  constructor(
    readonly code: GithubFailureCode,
    message: string = MESSAGES[code],
    /** Already scrubbed of secrets by whoever sets it. */
    readonly detail?: string
  ) {
    super(message)
    this.name = 'GithubError'
  }
}

/** `text` with every (non-empty) secret replaced by `[redacted]`. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce((result, secret) => (secret === '' ? result : result.split(secret).join('[redacted]')), text)
}

/** How many causes deep a redacted copy goes; a cause chain may loop. */
const MAX_CAUSE_DEPTH = 3

function redactedCopy(error: unknown, secrets: readonly string[], depth: number): Error {
  const source = error instanceof Error ? error : new Error(String(error))
  const copy = new Error(scrubSecrets(source.message, secrets))
  copy.name = source.name
  copy.stack = scrubSecrets(source.stack ?? '', secrets)
  if (source.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    copy.cause = redactedCopy(source.cause, secrets, depth + 1)
  }
  return copy
}

/**
 * A copy of `error` that is safe to log: its message and stack (and those of a few causes) with each
 * secret replaced. Only these texts survive; other properties a library attached (a request, its
 * headers) are dropped.
 */
export function redactSecrets(error: unknown, secrets: readonly string[]): Error {
  return redactedCopy(error, secrets, 0)
}
