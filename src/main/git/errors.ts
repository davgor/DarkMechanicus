/** Main-process git failures: a stable code for the renderer plus the tail of git's own message. */
import type { GitErrorCode } from '../../shared/git/errors'

const DETAIL_CHARS = 2000

export class GitError extends Error {
  readonly code: GitErrorCode
  readonly detail: string

  constructor(code: GitErrorCode, detail: string, message?: string) {
    super(message ?? `git failed (${code})${detail === '' ? '' : `: ${detail}`}`)
    this.name = 'GitError'
    this.code = code
    this.detail = detail
  }
}

export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Every stderr (or stdout, where git prints it there) pattern, in one table. The first matching row wins,
 * so the more specific rows come first. Git runs with `LC_ALL=C`, so the messages are English.
 */
const FAILURE_PATTERNS: ReadonlyArray<readonly [GitErrorCode, RegExp]> = [
  ['index_locked', /Unable to create '.*\.lock': File exists|index\.lock/i],
  ['not_repository', /not a git repository/i],
  ['auth_required', /terminal prompts disabled|could not read (Username|Password)/i],
  ['auth_failed', /Authentication failed|Permission denied \(publickey|Invalid username or password|returned error: 40[13]|HTTP Basic: Access denied/i],
  ['rejected_non_fast_forward', /non-fast-forward|\(fetch first\)|Updates were rejected because/i],
  ['operation_in_progress', /You have not concluded your merge|MERGE_HEAD exists|(rebase|cherry-pick|revert|am) .*in progress|already in progress|You are in the middle of|unresolved conflict|you have unmerged files/i],
  ['merge_conflicts', /CONFLICT \(|Automatic merge failed|fix conflicts|Merge conflict in/i],
  ['local_changes_would_be_overwritten', /local changes to the following files would be overwritten|would be overwritten by (merge|checkout)/i],
  ['nothing_to_commit', /nothing (added )?to commit|no changes added to commit/i],
  ['branch_exists', /a branch named '.*' already exists/i],
  ['branch_not_fully_merged', /not fully merged/i],
  ['remote_not_found', /No such remote|does not appear to be a git repository|repository '.*' not found|Could not read from remote repository/i],
  ['network_unreachable', /Could not resolve host|Failed to connect|Connection (timed out|refused|reset)|unable to access|Network is unreachable/i]
]

/** The stderr tail kept as `detail`. */
export function stderrTail(stderr: string): string {
  return stderr.length > DETAIL_CHARS ? stderr.slice(stderr.length - DETAIL_CHARS) : stderr
}

/** Turns a failed git result into a GitError; anything not in the table is `git_failed`. */
export function classifyGitFailure(result: GitRunResult, args: readonly string[]): GitError {
  const text = `${result.stderr}\n${result.stdout}`
  const row = FAILURE_PATTERNS.find(([, pattern]) => pattern.test(text))
  const code: GitErrorCode = row ? row[0] : 'git_failed'
  const name = args.find((arg) => !arg.startsWith('-')) ?? 'git'
  return new GitError(code, stderrTail(result.stderr), `git ${name} failed with exit code ${result.code} (${code})`)
}

/** A request git could not or must not carry out as asked (bad input, a refused operation). Reported as `invalid_input`. */
export class GitInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitInputError'
  }
}
