import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import type { GitProgressEvent } from '../../shared/git/api'
import type { GitHandlers } from './handlers'
import { createProgressBroadcaster, registerGitIpc } from './ipc'

type Listener = Parameters<IpcMain['handle']>[1]
const EVENT = {} as IpcMainInvokeEvent

function createFakeIpcMain(): {
  handle(channel: string, listener: Listener): void
  channels(): string[]
  invoke(channel: string, ...args: unknown[]): unknown
} {
  const listeners = new Map<string, Listener>()
  return {
    handle(channel, listener) {
      if (listeners.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      listeners.set(channel, listener)
    },
    channels: () => [...listeners.keys()].sort(),
    invoke: (channel, ...args) => listeners.get(channel)?.(EVENT, ...args)
  }
}

function recordingHandlers(): { handlers: GitHandlers; calls: unknown[][] } {
  const calls: unknown[][] = []
  const handlers: GitHandlers = {
    getState: async (folder) => {
      calls.push(['getState', folder])
      return { ok: true, data: { kind: 'not_repository' } }
    },
    getWorkingDiff: async (folder, request) => {
      calls.push(['getWorkingDiff', folder, request])
      return { ok: false, error: { code: 'invalid_input', message: 'x' } }
    },
    initRepository: async (folder) => {
      calls.push(['initRepository', folder])
      return { ok: true, data: { kind: 'git_missing' } }
    },
    commit: async (folder, request) => {
      calls.push(['commit', folder, request])
      return { ok: true, data: { oid: 'abc' } }
    },
    undoLastCommit: async (folder) => {
      calls.push(['undoLastCommit', folder])
      return { ok: true, data: { summary: 's', description: '' } }
    },
    discardChanges: async (folder, request) => {
      calls.push(['discardChanges', folder, request])
      return { ok: true, data: { kind: 'not_repository' } }
    },
    getHistory: async (folder, request) => {
      calls.push(['getHistory', folder, request])
      return { ok: true, data: { commits: [], hasMore: false } }
    },
    getCommitFiles: async (folder, oid) => {
      calls.push(['getCommitFiles', folder, oid])
      return { ok: true, data: [] }
    },
    getCommitDiff: async (folder, request) => {
      calls.push(['getCommitDiff', folder, request])
      return { ok: false, error: { code: 'invalid_input', message: 'x' } }
    }
  }
  return { handlers, calls }
}

describe('registerGitIpc', () => {
  it('registers exactly the git channels and forwards arguments untouched', async () => {
    const ipc = createFakeIpcMain()
    const { handlers, calls } = recordingHandlers()
    registerGitIpc(ipc, handlers)

    expect(ipc.channels()).toEqual(['git:commit', 'git:discardChanges', 'git:getCommitDiff', 'git:getCommitFiles', 'git:getHistory', 'git:getState', 'git:getWorkingDiff', 'git:initRepository', 'git:undoLastCommit'])
    await ipc.invoke('git:getState', '/a')
    await ipc.invoke('git:getWorkingDiff', '/a', { path: 'x' })
    await ipc.invoke('git:initRepository', '/b')
    await ipc.invoke('git:commit', '/a', { summary: 's' })
    await ipc.invoke('git:undoLastCommit', '/a')
    await ipc.invoke('git:discardChanges', '/a', { files: [] })
    await ipc.invoke('git:getHistory', '/a', { skip: 0, limit: 100 })
    await ipc.invoke('git:getCommitFiles', '/a', 'abcd')
    await ipc.invoke('git:getCommitDiff', '/a', { oid: 'abcd' })
    expect(calls).toEqual([
      ['getState', '/a'],
      ['getWorkingDiff', '/a', { path: 'x' }],
      ['initRepository', '/b'],
      ['commit', '/a', { summary: 's' }],
      ['undoLastCommit', '/a'],
      ['discardChanges', '/a', { files: [] }],
      ['getHistory', '/a', { skip: 0, limit: 100 }],
      ['getCommitFiles', '/a', 'abcd'],
      ['getCommitDiff', '/a', { oid: 'abcd' }]
    ])
  })
})

describe('createProgressBroadcaster', () => {
  const event: GitProgressEvent = { folder: '/a', operationId: 'op', operation: 'clone', phase: 'receiving', percent: 5 }

  it('sends each event to every live window on git:progress and skips destroyed ones', () => {
    const sent: Array<[string, string, unknown]> = []
    const window = (name: string, destroyed: boolean) => ({
      isDestroyed: () => destroyed,
      webContents: { isDestroyed: () => destroyed, send: (channel: string, payload: unknown) => sent.push([name, channel, payload]) }
    })
    const broadcast = createProgressBroadcaster(() => [window('one', false), window('two', true), window('three', false)])
    broadcast(event)
    expect(sent).toEqual([
      ['one', 'git:progress', event],
      ['three', 'git:progress', event]
    ])
  })
})
