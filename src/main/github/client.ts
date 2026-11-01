/**
 * Calls to the GitHub REST API with the signed-in account's token. Later tickets add calls here. A 401
 * means the token was revoked: the account is signed out on this computer (`onUnauthorized`) and the
 * call fails with `auth_required`. Failures are GithubErrors with fixed messages, never GitHub's body.
 * Main's own calls use `createSessionClient`, bound to the stored account.
 */
import { z } from 'zod'
import { GithubError } from './errors'
import { readJson, send, type HttpFetch } from './http'
import type { GithubSession } from './session'

const API_ROOT = 'https://api.github.com'

const userSchema = z.object({ login: z.string().min(1), name: z.string().nullable().optional() })

export interface GithubUser {
  login: string
  name: string | null
  /** The `X-OAuth-Scopes` header: the scopes the token was granted. */
  scopes: string
}

interface GithubClientDeps {
  fetch: HttpFetch
  getToken(): string | null
  appVersion: string
  /** Called on a 401 with the token GitHub rejected, before the call fails with `auth_required`. */
  onUnauthorized(rejectedToken: string): void
}

export interface GithubClient {
  getUser(): Promise<GithubUser>
}

export function createGithubClient(deps: GithubClientDeps): GithubClient {
  async function get(path: string): Promise<{ body: unknown; scopes: string }> {
    const token = deps.getToken()
    if (token === null) {
      throw new GithubError('auth_required')
    }
    const response = await send(deps.fetch, `${API_ROOT}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `DarkMechanicus/${deps.appVersion}`
      }
    })
    if (response.status === 401) {
      deps.onUnauthorized(token)
      throw new GithubError('auth_required')
    }
    if (!response.ok) {
      throw new GithubError('github_failed', `GitHub answered ${response.status}.`)
    }
    return { body: await readJson(response), scopes: response.headers.get('x-oauth-scopes') ?? '' }
  }

  return {
    getUser: async () => {
      const { body, scopes } = await get('/user')
      const user = userSchema.safeParse(body)
      if (!user.success) {
        throw new GithubError('github_failed')
      }
      return { login: user.data.login, name: user.data.name ?? null, scopes }
    }
  }
}

/**
 * A client over the session's stored token. A 401 signs the account out on this computer, but only
 * while the rejected token is still the stored one: an answer for an older token that arrives after a
 * new sign-in leaves the new account alone.
 */
export function createSessionClient(
  session: Pick<GithubSession, 'getToken' | 'signOut'>,
  deps: { fetch: HttpFetch; appVersion: string }
): GithubClient {
  return createGithubClient({
    fetch: deps.fetch,
    appVersion: deps.appVersion,
    getToken: () => session.getToken(),
    onUnauthorized: (rejectedToken) => {
      if (session.getToken() === rejectedToken) {
        session.signOut()
      }
    }
  })
}
