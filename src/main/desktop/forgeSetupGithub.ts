import { z } from 'zod'
import { discoverForgeSetup, type ForgeSetupDescriptorReader } from '../../core/repo/forgeSetupDetection'
import { githubRemote } from '../../core/repo/forgeManifest'
import type { CredentialSession } from '../git/credentials'

type Fetch = (url: string, options: RequestInit) => Promise<Response>
type Options = Parameters<ForgeSetupDescriptorReader['head']>[1]
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const head = z.array(z.object({ sha, commit: z.object({ tree: z.object({ sha }) }) })).max(1)
const tree = z.object({
  tree: z.array(z.object({ path: z.string().max(4096), mode: z.string(), type: z.string(), sha, size: z.number().int().nonnegative().optional() })),
  truncated: z.boolean()
})

function endpoint(repository: string): string {
  const path = new URL(githubRemote(repository)).pathname.slice(1, -4)
  return 'https://api.github.com/repos/' + path.split('/').map(encodeURIComponent).join('/')
}

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  const stream = response.body
  if (stream === null) throw new Error('GitHub returned no descriptor body.')
  if (Number(response.headers.get('content-length')) > limit) {
    void stream.cancel().catch(() => undefined)
    throw new Error('The descriptor response exceeds its byte limit.')
  }
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return Buffer.concat(parts, bytes)
      bytes += value.byteLength
      if (bytes > limit) {
        void reader.cancel().catch(() => undefined)
        throw new Error('The descriptor response exceeds its byte limit.')
      }
      parts.push(value)
    }
  } finally { reader.releaseLock() }
}

function readerFor(session: CredentialSession, fetch: Fetch): ForgeSetupDescriptorReader {
  const login = session.getAccount()?.login
  const token = session.getToken()
  function current(): void {
    if (session.getAccount()?.login !== login || session.getToken() !== token) throw new Error('The GitHub account changed during setup discovery.')
  }
  async function request(repository: string, path: string, options: Options, accept = 'application/vnd.github+json') {
    current()
    const response = await fetch(endpoint(repository) + path, {
      method: 'GET', redirect: 'error', signal: options.signal,
      headers: {
        Accept: accept, 'X-GitHub-Api-Version': '2022-11-28',
        ...(token === null ? {} : { Authorization: 'Bearer ' + token })
      }
    })
    current()
    return response
  }
  const json = async (response: Response, options: Options) => {
    if (!response.ok) throw new Error('GitHub could not read the repository descriptor.')
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBody(response, options.maxBytes)))
    current()
    return value
  }
  return {
    async head(repository, options) {
      // A one-item list defaults to the repository's default branch; retain only this commit and tree.
      const response = await request(repository, '/commits?per_page=1', options)
      if (response.status === 404 || response.status === 409) return null
      const [first] = head.parse(await json(response, options))
      return first === undefined ? null : { commit: first.sha, tree: first.commit.tree.sha }
    },
    async tree(repository, digest, options) {
      const response = await request(repository, '/git/trees/' + sha.parse(digest), options)
      const result = tree.parse(await json(response, options))
      if (result.tree.length > (options.maxEntries ?? 0)) return { entries: [], truncated: true }
      return { entries: result.tree, truncated: result.truncated }
    },
    async blob(repository, digest, options) {
      const response = await request(repository, '/git/blobs/' + sha.parse(digest), options, 'application/vnd.github.raw+json')
      if (!response.ok) throw new Error('GitHub could not read the descriptor file.')
      const bytes = await boundedBody(response, options.maxBytes)
      current()
      return bytes
    }
  }
}

export function discoverGithubForgeSetup(repository: string, session: CredentialSession, fetch: Fetch) {
  return discoverForgeSetup(repository, readerFor(session, fetch), AbortSignal.timeout(12_000))
}
