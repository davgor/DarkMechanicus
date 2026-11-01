/**
 * How git authenticates a network operation. For an `https://github.com/…` remote while signed in, git gets
 * the account's login and token from an environment-based credential helper scoped to https://github.com,
 * after every other helper configured for that host (Git Credential Manager included) is cleared, so the token
 * is neither answered by nor stored in any other helper. Other hosts (a submodule, LFS) and every other case
 * use the machine's own credentials (its helpers, the keychain, the SSH agent). Nothing waits on a prompt:
 * the runner turns terminal, askpass and GCM prompts off, and ssh runs in batch mode unless the person set it up.
 *
 * The token is in the environment of everything git starts (hooks, LFS, ssh, remote helpers): local programs
 * the person runs anyway, whose output the runner scrubs. It never appears in an argument.
 */
import type { GithubSession } from '../github/session'

export type CredentialSession = Pick<GithubSession, 'getToken'> & { getAccount(): { login: string } | null }

interface GitCredentials {
  /** `-c` options to put before the git command; they name the environment variables, never the token. */
  args: string[]
  /** Merged into git's environment through `request.env`; never logged. */
  env: Record<string, string>
  /** Strings the runner scrubs from git's output: the token, and the Basic auth form a trace would print. */
  secrets: string[]
}

const GITHUB_HTTPS = /^https:\/\/github\.com\//i
/** The shell function git runs as the helper; it prints the variables, so the token never becomes an argument. */
const HELPER = '!f() { echo username="$DM_GITHUB_LOGIN"; echo password="$DM_GITHUB_TOKEN"; }; f'
/** Printable ASCII except space and backslash: nothing `echo` could reinterpret or a newline could inject. */
const SAFE_VALUE = /^[\x21-\x5b\x5d-\x7e]+$/

/** Whether git reaches this remote over HTTPS on github.com (the only place the account's token is ever sent). */
export function isGithubHttps(remoteUrl: string): boolean {
  return GITHUB_HTTPS.test(remoteUrl)
}

/**
 * The extra arguments and environment for an `https://github.com/…` remote while an account is signed in;
 * null otherwise (signed out, SSH, other hosts), and git then uses the machine's own credentials.
 */
export function credentialArgs(remoteUrl: string, session: CredentialSession): GitCredentials | null {
  if (!isGithubHttps(remoteUrl)) {
    return null
  }
  const login = session.getAccount()?.login
  const token = login === undefined ? null : session.getToken()
  if (login === undefined || token === null || !SAFE_VALUE.test(login) || !SAFE_VALUE.test(token)) {
    return null
  }
  return {
    // An empty value resets the helper list for a URL: every helper that matches https://github.com (global,
    // system, local, path-, user- or wildcard-scoped) is dropped, while other hosts keep theirs.
    args: ['-c', 'credential.https://github.com.helper=', '-c', `credential.https://github.com.helper=${HELPER}`],
    env: { DM_GITHUB_LOGIN: login, DM_GITHUB_TOKEN: token, GIT_TRACE_REDACT: '1' },
    secrets: [token, Buffer.from(`${login}:${token}`).toString('base64')]
  }
}

/**
 * `GIT_SSH_COMMAND` with `BatchMode=yes`, so ssh (for an SSH remote, or a submodule behind one) fails instead of
 * asking for a passphrase, a password or a new host key on a terminal; the agent and the keychain still work.
 * Left alone when the person chose their own ssh (`GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand`).
 */
export function sshPromptEnv(configuredSshCommand: string | null, env: NodeJS.ProcessEnv): Record<string, string> {
  const own = configuredSshCommand !== null || Boolean(env.GIT_SSH_COMMAND) || Boolean(env.GIT_SSH)
  return own ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }
}
