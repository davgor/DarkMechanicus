/**
 * The behavior behind the `github:*` IPC channels, as a pure factory over injected dependencies (no
 * Electron imports). Sign-in imports the GitHub CLI's github.com token, checks it with `GET /user`
 * (it needs the `repo` scope) and stores the account encrypted. The token stays in main: results and
 * broadcasts carry the login, name, code, fixed message and a scrubbed detail only, and an unexpected
 * error is logged with the token scrubbed. The account's repository list comes from `listRepositories`.
 * Nothing throws.
 */
import { z } from 'zod'
import type { GitResult } from '../../shared/git/api'
import type { GithubAccountView, GithubRepository } from '../../shared/github/api'
import type { GithubUser } from './client'
import { GithubError, redactSecrets, type GithubFailureCode } from './errors'
import type { GithubSession } from './session'

interface GithubHandlerDeps {
  session: GithubSession
  /** The GitHub CLI's github.com token (`GhCli.readGhToken`). */
  readGhToken(signal: AbortSignal): Promise<string>
  /** The account a fresh token belongs to (`GET /user` with that token); a 401 is `auth_required`. */
  fetchUser(token: string): Promise<GithubUser>
  /** Told about failures that are not GithubErrors (bugs, I/O), already scrubbed of secrets, so main can log them. */
  onUnexpectedError(error: unknown): void
  /** The account's repositories (`RepositoryList.list`): cached unless `refresh`, `auth_required` while signed out. */
  listRepositories(refresh: boolean): Promise<GithubRepository[]>
}

/** Only `listRepositories` takes an argument, `{ refresh?: boolean }`, checked here; nothing else from the renderer reaches these handlers. */
export interface GithubHandlers {
  getAccount(): Promise<GitResult<GithubAccountView | null>>
  signIn(): Promise<GitResult<GithubAccountView>>
  signOut(): Promise<GitResult<null>>
  listRepositories(request: unknown): Promise<GitResult<GithubRepository[]>>
}

interface Failure {
  code: GithubFailureCode
  message: string
  detail?: string
}

type ErrorSink = Pick<GithubHandlerDeps, 'onUnexpectedError'>

const UNEXPECTED: Failure = { code: 'github_failed', message: 'GitHub sign-in failed unexpectedly.' }
const LIST_UNEXPECTED: Failure = { code: 'github_failed', message: 'Listing your GitHub repositories failed unexpectedly.' }
const listRequestSchema = z.strictObject({ refresh: z.boolean().optional() }).optional()

/** A failure as the renderer may see it: a GithubError's code, fixed message and scrubbed detail, or a generic one after logging. */
function failureOf(error: unknown, secrets: readonly string[], sink: ErrorSink, unexpected: Failure): Failure {
  if (error instanceof GithubError) {
    return error.detail === undefined ? { code: error.code, message: error.message } : { code: error.code, message: error.message, detail: error.detail }
  }
  try {
    sink.onUnexpectedError(redactSecrets(error, secrets))
  } catch {
    // A failing logger must not turn a result into a thrown error.
  }
  return unexpected
}

async function guarded<T>(work: () => Promise<T> | T, sink: ErrorSink, secrets: readonly string[] = [], unexpected = UNEXPECTED): Promise<GitResult<T>> {
  try {
    return { ok: true, data: await work() }
  } catch (error) {
    return { ok: false, error: failureOf(error, secrets, sink, unexpected) }
  }
}

/** Whether an `X-OAuth-Scopes` value (`"repo, read:org"`) grants `repo`. */
function hasRepoScope(scopes: string): boolean {
  return scopes.split(',').some((scope) => scope.trim() === 'repo')
}

/** `GET /user` with a token that is not stored yet: a 401 means GitHub refused it (`auth_failed`). */
async function checkedUser(deps: GithubHandlerDeps, token: string): Promise<GithubUser> {
  const user = await deps.fetchUser(token).catch((error: unknown) => {
    throw error instanceof GithubError && error.code === 'auth_required' ? new GithubError('auth_failed') : error
  })
  if (!hasRepoScope(user.scopes)) {
    throw new GithubError('gh_missing_scope')
  }
  return user
}

/**
 * One sign-in at a time: a call while one runs gets the same promise. Signing out aborts the running
 * attempt, which then ends `cancelled` and stores nothing.
 */
function createSignIn(deps: GithubHandlerDeps): { signIn(): Promise<GitResult<GithubAccountView>>; abort(): void } {
  const { session } = deps
  let running: { attempt: AbortController; result: Promise<GitResult<GithubAccountView>> } | null = null

  async function attemptSignIn(attempt: AbortController): Promise<GitResult<GithubAccountView>> {
    const secrets: string[] = []
    return guarded(
      async () => {
        if (!session.canStoreToken()) {
          throw new GithubError('secure_storage_unavailable')
        }
        const token = await deps.readGhToken(attempt.signal)
        secrets.push(token)
        const user = await checkedUser(deps, token)
        if (attempt.signal.aborted) {
          throw new GithubError('cancelled')
        }
        session.signIn(user, token)
        return { login: user.login, name: user.name }
      },
      deps,
      secrets
    )
  }

  return {
    signIn: () => {
      if (running === null) {
        const attempt = new AbortController()
        const result = attemptSignIn(attempt).finally(() => {
          if (running?.attempt === attempt) {
            running = null
          }
        })
        running = { attempt, result }
      }
      return running.result
    },
    abort: () => {
      running?.attempt.abort()
      running = null
    }
  }
}

export function createGithubHandlers(deps: GithubHandlerDeps): GithubHandlers {
  const { session } = deps
  const signIn = createSignIn(deps)
  return {
    getAccount: () =>
      guarded(() => {
        const account = session.getAccount()
        return account === null ? null : { login: account.login, name: account.name }
      }, deps),
    signIn: signIn.signIn,
    signOut: () =>
      guarded(() => {
        signIn.abort()
        session.signOut()
        return null
      }, deps),
    listRepositories: async (request) => {
      const parsed = listRequestSchema.safeParse(request)
      if (!parsed.success) {
        return { ok: false, error: { code: 'invalid_input', message: 'The repository list request is not valid.' } }
      }
      return guarded(() => deps.listRepositories(parsed.data?.refresh === true), deps, [], LIST_UNEXPECTED)
    }
  }
}
