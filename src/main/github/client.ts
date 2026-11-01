/**
 * Calls to the GitHub REST API with the signed-in account's token. Later tickets add calls here. A 401
 * means the token was revoked: the account is signed out on this computer (`onUnauthorized`) and the
 * call fails with `auth_required`. Failures are GithubErrors with fixed messages, never GitHub's body.
 * Main's own calls use `createSessionClient`, bound to the stored account.
 */
import { z } from 'zod'
import type { GithubRepository } from '../../shared/github/api'
import { GithubError } from './errors'
import { readJson, send, type HttpFetch } from './http'
import type { GithubSession } from './session'

const API_ROOT = 'https://api.github.com'

const userSchema = z.object({ login: z.string().min(1), name: z.string().nullable().optional() })

/** The fields of GitHub's pull request answer that main uses; the `html_url` is not one of them (main builds the URL). */
const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  draft: z.boolean().optional(),
  updated_at: z.string(),
  base: z.object({ ref: z.string() }),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() })
})

export type GithubPullRequest = z.infer<typeof pullRequestSchema>

/** GitHub's largest page of pull requests. */
export const PULL_REQUEST_PAGE_SIZE = 100

/** The account's repositories as owner, collaborator and organization member, most recently pushed first. */
const REPOSITORIES_PATH = '/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=pushed'
const MAX_REPOSITORIES = 1000
const MAX_REPOSITORY_PAGES = 10

const repositorySchema = z.object({
  full_name: z.string().min(1),
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
  private: z.boolean(),
  fork: z.boolean(),
  description: z.string().nullable(),
  clone_url: z.string().min(1),
  pushed_at: z.string().nullable()
})

interface ApiAnswer {
  body: unknown
  scopes: string
  /** The `Link` header, which names the next page of a list. */
  link: string | null
}

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
  /** Up to 1,000 of the account's repositories, following `Link: rel="next"` a page of 100 at a time. */
  listRepositories(): Promise<GithubRepository[]>
  getUser(): Promise<GithubUser>
  /** One page (from 1) of the repository's open pull requests, `PULL_REQUEST_PAGE_SIZE` at most. */
  listOpenPullRequests(owner: string, repo: string, page: number): Promise<GithubPullRequest[]>
}

/** The `rel="next"` page of a `Link` header as a path on the API, or null on the last page. */
function nextPath(link: string | null): string | null {
  const next = [...(link ?? '').matchAll(/<([^>]*)>\s*;\s*rel="([^"]*)"/g)].find((match) => match[2].split(' ').includes('next'))
  if (next === undefined) {
    return null
  }
  let url: URL
  try {
    url = new URL(next[1])
  } catch {
    throw new GithubError('github_failed')
  }
  // The token goes to the API only: a next page anywhere else is GitHub answering unexpectedly, and is not followed.
  if (url.origin !== API_ROOT) {
    throw new GithubError('github_failed')
  }
  return `${url.pathname}${url.search}`
}

function toRepository(item: unknown): GithubRepository[] {
  const parsed = repositorySchema.safeParse(item)
  if (!parsed.success) {
    return []
  }
  const repo = parsed.data
  return [
    {
      fullName: repo.full_name,
      owner: repo.owner.login,
      name: repo.name,
      private: repo.private,
      fork: repo.fork,
      description: repo.description,
      cloneUrl: repo.clone_url,
      pushedAt: repo.pushed_at
    }
  ]
}

/** Every page of the account's repositories, up to 1,000 of them; an entry that does not read as one is left out. */
async function listAccountRepositories(get: (path: string) => Promise<ApiAnswer>): Promise<GithubRepository[]> {
  const repositories: GithubRepository[] = []
  let path: string | null = REPOSITORIES_PATH
  for (let page = 0; path !== null && page < MAX_REPOSITORY_PAGES && repositories.length < MAX_REPOSITORIES; page += 1) {
    const answer = await get(path)
    if (!Array.isArray(answer.body)) {
      throw new GithubError('github_failed')
    }
    repositories.push(...answer.body.flatMap(toRepository))
    path = nextPath(answer.link)
  }
  return repositories.slice(0, MAX_REPOSITORIES)
}

export function createGithubClient(deps: GithubClientDeps): GithubClient {
  async function get(path: string): Promise<ApiAnswer> {
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
    return { body: await readJson(response), scopes: response.headers.get('x-oauth-scopes') ?? '', link: response.headers.get('link') }
  }

  return {
    listRepositories: () => listAccountRepositories(get),
    getUser: async () => {
      const { body, scopes } = await get('/user')
      const user = userSchema.safeParse(body)
      if (!user.success) {
        throw new GithubError('github_failed')
      }
      return { login: user.data.login, name: user.data.name ?? null, scopes }
    },
    listOpenPullRequests: async (owner, repo, page) => {
      const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`
      const { body } = await get(`${path}?state=open&per_page=${PULL_REQUEST_PAGE_SIZE}&page=${page}`)
      const pulls = z.array(pullRequestSchema).safeParse(body)
      if (!pulls.success) {
        throw new GithubError('github_failed')
      }
      return pulls.data
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
