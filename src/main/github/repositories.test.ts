/** The account's repository list for the clone dialog: five minutes of cache per account, nothing while signed out. */
import { describe, expect, it } from 'vitest'
import type { GithubRepository } from '../../shared/github/api'
import { GithubError } from './errors'
import { createRepositoryList, REPOSITORY_CACHE_MS, type RepositoryList } from './repositories'

function repository(name: string): GithubRepository {
  return { fullName: `octocat/${name}`, owner: 'octocat', name, private: false, fork: false, description: null, cloneUrl: `https://github.com/octocat/${name}.git`, pushedAt: null }
}

interface Rig {
  list: RepositoryList
  fetches: number
  account: { login: string } | null
  clock: number
  next: GithubRepository[] | Error
  /** Runs while GitHub is answering: a test switches the account here. */
  whileFetching(): void
}

function rig(): Rig {
  const r: Rig = {
    fetches: 0,
    account: { login: 'octocat' },
    clock: 1_000_000,
    next: [repository('Hello-World')],
    whileFetching: () => undefined,
    list: createRepositoryList({
      client: {
        listRepositories: async () => {
          r.fetches += 1
          r.whileFetching()
          if (r.next instanceof Error) {
            throw r.next
          }
          return r.next
        }
      },
      session: { getAccount: () => r.account },
      now: () => r.clock
    })
  }
  return r
}

describe('createRepositoryList: the cache', () => {
  it('answers from the cache for five minutes, then asks GitHub again', async () => {
    const r = rig()
    expect(await r.list.list(false)).toEqual([repository('Hello-World')])
    r.next = [repository('Spoon-Knife')]
    r.clock += REPOSITORY_CACHE_MS - 1
    expect(await r.list.list(false)).toEqual([repository('Hello-World')])
    expect(r.fetches).toBe(1)
    r.clock += 1
    expect(await r.list.list(false)).toEqual([repository('Spoon-Knife')])
    expect(r.fetches).toBe(2)
    expect(REPOSITORY_CACHE_MS).toBe(5 * 60 * 1000)
  })

  it('asks GitHub again on a refresh, and the fresh list is what is cached', async () => {
    const r = rig()
    await r.list.list(false)
    r.next = [repository('Spoon-Knife')]
    expect(await r.list.list(true)).toEqual([repository('Spoon-Knife')])
    expect(await r.list.list(false)).toEqual([repository('Spoon-Knife')])
    expect(r.fetches).toBe(2)
  })

  it('keeps one list per account: another account is asked for its own', async () => {
    const r = rig()
    await r.list.list(false)
    r.account = { login: 'hubot' }
    r.next = [repository('hubot-only')]
    expect(await r.list.list(false)).toEqual([repository('hubot-only')])
    expect(r.fetches).toBe(2)
  })

  it('caches no failure', async () => {
    const r = rig()
    r.next = new GithubError('network_unreachable')
    await expect(r.list.list(false)).rejects.toMatchObject({ code: 'network_unreachable' })
    r.next = [repository('Hello-World')]
    expect(await r.list.list(false)).toEqual([repository('Hello-World')])
  })
})

describe('createRepositoryList: signed out', () => {
  it('is auth_required without asking GitHub, even with a list cached for the account that signed out', async () => {
    const r = rig()
    await r.list.list(false)
    r.account = null
    await expect(r.list.list(false)).rejects.toMatchObject({ code: 'auth_required' })
    await expect(r.list.list(true)).rejects.toBeInstanceOf(GithubError)
    expect(r.fetches).toBe(1)
  })
})

describe('createRepositoryList: an account switch while GitHub answers', () => {
  it('returns that answer but caches none of it, not even for the account that started the call', async () => {
    const r = rig()
    r.whileFetching = () => {
      r.account = { login: 'hubot' }
    }
    expect(await r.list.list(false)).toEqual([repository('Hello-World')])
    r.whileFetching = () => undefined
    r.account = { login: 'octocat' }
    r.next = [repository('Spoon-Knife')]
    expect(await r.list.list(false)).toEqual([repository('Spoon-Knife')])
    expect(r.fetches).toBe(2)
  })
})
