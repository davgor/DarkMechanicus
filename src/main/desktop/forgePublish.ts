import { z } from 'zod'
import type { CredentialSession } from '../git/credentials'
import { readJson, send, type HttpFetch } from '../github/http'
import { githubRemote } from './forgeManifest'

/** Create the private ticket store in the signed-in account before cloning its initial branch. */
export async function publishForgeRepository(name: string, token: string | null, request: (url: string, options: RequestInit) => Promise<Response>): Promise<void> {
  if (!token) throw new Error('Sign into GitHub to publish a Forge World.')
  const response = await request('https://api.github.com/user/repos', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, private: true, auto_init: true })
  })
  if (!response.ok) throw new Error('GitHub could not create this private repository (' + response.status + ').')
}

const API = 'https://api.github.com'
export const forgeProvisionAccount = z.strictObject({ login: z.string().regex(/^[a-z0-9-]+$/i), id: z.number().int().positive() })
export type ForgeProvisionAccount = z.infer<typeof forgeProvisionAccount>
const repositoryName = z.string().min(1).max(100)
const visibility = z.enum(['private', 'public'])
export const forgePublishedRepository = z.strictObject({
  id: z.number().int().positive(),
  owner: z.string().regex(/^[a-z0-9-]+$/i),
  ownerId: z.number().int().positive(),
  name: repositoryName,
  visibility,
  url: z.string().refine(url => {
    try { return githubRemote(url) === url } catch { return false }
  }),
  provenance: z.string().nullable()
})
export type ForgePublishedRepository = z.infer<typeof forgePublishedRepository>

const githubRepository = z.object({
  id: z.number().int().positive(), name: repositoryName,
  owner: z.object({ login: z.string(), id: z.number().int().positive() }),
  private: z.boolean(), clone_url: z.string(), description: z.string().nullable()
})

function publishReceipt(raw: unknown): ForgePublishedRepository {
  const repo = githubRepository.safeParse(raw)
  if (!repo.success) throw new Error('GitHub did not return a valid repository receipt.')
  const value = repo.data
  return forgePublishedRepository.parse({
    id: value.id, owner: value.owner.login, ownerId: value.owner.id, name: value.name,
    visibility: value.private ? 'private' : 'public', url: githubRemote(value.clone_url), provenance: value.description
  })
}

export class ForgeCreationRefused extends Error {}

export interface ForgeRepositoryPublisher {
  account(): Promise<ForgeProvisionAccount>
  findRemote(account: ForgeProvisionAccount, name: string): Promise<ForgePublishedRepository | null>
  createRemote(input: { account: ForgeProvisionAccount; name: string; visibility: 'private' | 'public'; provenance: string }): Promise<ForgePublishedRepository>
}

export function sameForgeAccount(first: ForgeProvisionAccount, second: ForgeProvisionAccount): boolean {
  return first.id === second.id && first.login.toLowerCase() === second.login.toLowerCase()
}

function makeRequest(fetch: HttpFetch, token: string, path: string, body?: Record<string, unknown>) {
  return send(fetch, API + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
}

export function createForgeRepositoryPublisher(session: CredentialSession, fetch: HttpFetch): ForgeRepositoryPublisher & {
  inspectRemote(account: ForgeProvisionAccount, url: string): Promise<ForgePublishedRepository | null>
} {
  async function credentials(expected?: ForgeProvisionAccount) {
    const login = session.getAccount()?.login
    const token = session.getToken()
    if (!login || !token) throw new Error('Sign into GitHub to create a Forge World or code repository.')
    const response = await makeRequest(fetch, token, '/user')
    if (!response.ok) throw new Error('GitHub could not verify the signed-in account (' + response.status + ').')
    const account = verifiedAccount(await readJson(response), login, expected)
    if (session.getAccount()?.login !== login || session.getToken() !== token) {
      throw new Error('The GitHub account changed. Sign back into the account that started this operation.')
    }
    return { token, account }
  }
  async function inspectRemote(account: ForgeProvisionAccount, url: string) {
    const path = new URL(githubRemote(url)).pathname.slice(1, -4)
    const { token } = await credentials(account)
    const response = await makeRequest(fetch, token, '/repos/' + path.split('/').map(encodeURIComponent).join('/'))
    if (response.status === 404) return null
    if (!response.ok) throw new Error('GitHub could not verify the repository (' + response.status + ').')
    const receipt = publishReceipt(await readJson(response))
    if (receipt.url.toLowerCase() !== url.toLowerCase()) throw new Error('GitHub returned a different repository.')
    return receipt
  }
  return {
    account: async () => (await credentials()).account,
    inspectRemote,
    findRemote: (account, name) => inspectRemote(account, 'https://github.com/' + account.login + '/' + name + '.git'),
    async createRemote({ account, name, visibility, provenance }) {
      const { token } = await credentials(account).catch(() => {
        throw new ForgeCreationRefused('GitHub account verification stopped before sending the creation request.')
      })
      const response = await makeRequest(fetch, token, '/user/repos', {
        name, description: provenance, private: visibility === 'private', auto_init: false
      })
      if ([400, 401, 403, 404, 422].includes(response.status)) {
        throw new ForgeCreationRefused('GitHub refused repository creation (' + response.status + ').')
      }
      if (response.status !== 201) throw new Error('GitHub has not confirmed repository creation.')
      return publishReceipt(await readJson(response))
    }
  }
}

function verifiedAccount(raw: unknown, login: string, expected?: ForgeProvisionAccount): ForgeProvisionAccount {
  const { login: remote, id } = z.object({ login: z.string(), id: z.number() }).parse(raw)
  const account = forgeProvisionAccount.parse({ login: remote, id })
  if (account.login.toLowerCase() !== login.toLowerCase() || (expected !== undefined && !sameForgeAccount(expected, account))) {
    throw new Error('The GitHub account changed. Sign back into the account that started this operation.')
  }
  return account
}
