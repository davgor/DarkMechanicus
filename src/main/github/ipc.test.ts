import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import type { GithubHandlers } from './handlers'
import { createGithubBroadcaster, registerGithubIpc } from './ipc'

type Listener = Parameters<IpcMain['handle']>[1]
const EVENT = {} as IpcMainInvokeEvent

function createFakeIpcMain(): { handle(channel: string, listener: Listener): void; channels(): string[]; invoke(channel: string, ...args: unknown[]): unknown } {
  const listeners = new Map<string, Listener>()
  return {
    handle(channel, listener) {
      listeners.set(channel, listener)
    },
    channels: () => [...listeners.keys()].sort(),
    invoke: (channel, ...args) => listeners.get(channel)?.(EVENT, ...args)
  }
}

describe('registerGithubIpc', () => {
  it('registers exactly the github channels; only listRepositories gets an argument from the renderer, its first one', async () => {
    const calls: unknown[][] = []
    const handlers: GithubHandlers = {
      getAccount: async (...args: unknown[]) => {
        calls.push(['getAccount', ...args])
        return { ok: true, data: null }
      },
      signIn: async (...args: unknown[]) => {
        calls.push(['signIn', ...args])
        return { ok: true, data: { login: 'octocat', name: null } }
      },
      signOut: async (...args: unknown[]) => {
        calls.push(['signOut', ...args])
        return { ok: true, data: null }
      },
      listRepositories: async (...args: unknown[]) => {
        calls.push(['listRepositories', ...args])
        return { ok: true, data: [] }
      }
    }
    const ipc = createFakeIpcMain()
    registerGithubIpc(ipc, handlers)
    expect(ipc.channels()).toEqual(['github:getAccount', 'github:listRepositories', 'github:signIn', 'github:signOut'])
    for (const channel of ipc.channels()) {
      await ipc.invoke(channel, 'injected', { token: 'x' })
    }
    expect(calls).toEqual([['getAccount'], ['listRepositories', 'injected'], ['signIn'], ['signOut']])
  })
})

describe('createGithubBroadcaster', () => {
  it('sends account changes to every live window and skips destroyed ones', () => {
    const sent: Array<[string, string, unknown]> = []
    const window = (name: string, destroyed: boolean) => ({
      isDestroyed: () => destroyed,
      webContents: { isDestroyed: () => destroyed, send: (channel: string, payload: unknown) => sent.push([name, channel, payload]) }
    })
    const broadcast = createGithubBroadcaster(() => [window('one', false), window('two', true)])
    broadcast.accountChanged({ login: 'octocat', name: null })
    broadcast.accountChanged(null)
    expect(sent).toEqual([
      ['one', 'github:accountChanged', { login: 'octocat', name: null }],
      ['one', 'github:accountChanged', null]
    ])
  })

  it('sends only the login and name, whatever else the account object carries', () => {
    const sent: unknown[] = []
    const broadcast = createGithubBroadcaster(() => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (_channel: string, payload: unknown) => sent.push(payload) } }
    ])
    broadcast.accountChanged({ login: 'octocat', name: 'O', token: 'gho_FAKE', scopes: 'repo' } as never)
    expect(sent).toEqual([{ login: 'octocat', name: 'O' }])
  })
})
