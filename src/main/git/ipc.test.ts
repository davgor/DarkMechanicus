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
    },
    ...syncHandlers(calls),
    ...branchHandlers(calls)
  }
  return { handlers, calls }
}

type SyncMethod = 'fetch' | 'pull' | 'push' | 'cancelOperation' | 'getCloneParent' | 'chooseCloneParent' | 'clone'

function syncHandlers(calls: unknown[][]): Pick<GitHandlers, SyncMethod> {
  const operation = (name: string): GitHandlers['fetch'] => async (folder, request) => {
    calls.push([name, folder, request])
    return { ok: true, data: { kind: 'not_repository' } }
  }
  return {
    fetch: operation('fetch'),
    pull: operation('pull'),
    push: operation('push'),
    cancelOperation: async (folder, operationId) => {
      calls.push(['cancelOperation', folder, operationId])
      return { ok: true, data: { cancelled: true } }
    },
    getCloneParent: async (...args: unknown[]) => {
      calls.push(['getCloneParent', ...args])
      return { ok: true, data: null }
    },
    chooseCloneParent: async (...args: unknown[]) => {
      calls.push(['chooseCloneParent', ...args])
      return { ok: true, data: '/parent' }
    },
    clone: async (request) => {
      calls.push(['clone', request])
      return { ok: false, error: { code: 'target_exists', message: 'x' } }
    }
  }
}

const BRANCH_METHODS = [
  'listBranches',
  'checkBranchName',
  'createBranch',
  'switchBranch',
  'renameBranch',
  'deleteBranch',
  'mergeIntoCurrent',
  'listStashes',
  'restoreStash',
  'discardStash'
] as const

const CONFLICT_METHODS = ['getConflicts', 'resolveWith', 'markResolved', 'abortMerge', 'commitMerge', 'abortOperation', 'openInEditor'] as const

const PULL_REQUEST_METHODS = ['getPullRequests', 'checkoutPullRequest', 'getCompareUrl', 'getCommitUrl'] as const

type BranchMethod = (typeof BRANCH_METHODS)[number] | (typeof CONFLICT_METHODS)[number] | (typeof PULL_REQUEST_METHODS)[number]

function branchHandlers(calls: unknown[][]): Pick<GitHandlers, BranchMethod> {
  const record = (name: string) => async (...args: unknown[]) => {
    calls.push([name, ...args])
    return { ok: false as const, error: { code: 'invalid_input' as const, message: 'x' } }
  }
  const methods = [...BRANCH_METHODS, ...CONFLICT_METHODS, ...PULL_REQUEST_METHODS]
  return Object.fromEntries(methods.map((name) => [name, record(name)])) as unknown as Pick<GitHandlers, BranchMethod>
}

const CHANNELS = [
  'git:cancelOperation',
  'git:chooseCloneParent',
  'git:clone',
  'git:getCloneParent',
  'git:commit',
  'git:discardChanges',
  'git:fetch',
  'git:getCommitDiff',
  'git:getCommitFiles',
  'git:getHistory',
  'git:getState',
  'git:getWorkingDiff',
  'git:initRepository',
  'git:pull',
  'git:push',
  'git:undoLastCommit',
  ...BRANCH_METHODS.map((name) => `git:${name}`),
  ...CONFLICT_METHODS.map((name) => `git:${name}`),
  ...PULL_REQUEST_METHODS.map((name) => `git:${name}`)
]

describe('registerGitIpc', () => {
  it('registers exactly the git channels and forwards arguments untouched', async () => {
    const ipc = createFakeIpcMain()
    const { handlers, calls } = recordingHandlers()
    registerGitIpc(ipc, handlers)

    expect(ipc.channels()).toEqual([...CHANNELS].sort())
    await ipc.invoke('git:getState', '/a')
    await ipc.invoke('git:getWorkingDiff', '/a', { path: 'x' })
    await ipc.invoke('git:initRepository', '/b')
    await ipc.invoke('git:commit', '/a', { summary: 's' })
    await ipc.invoke('git:undoLastCommit', '/a')
    await ipc.invoke('git:discardChanges', '/a', { files: [] })
    await ipc.invoke('git:getHistory', '/a', { skip: 0, limit: 100 })
    await ipc.invoke('git:getCommitFiles', '/a', 'abcd')
    await ipc.invoke('git:getCommitDiff', '/a', { oid: 'abcd' })
    await ipc.invoke('git:fetch', '/a', { operationId: 'f' })
    await ipc.invoke('git:pull', '/a', { operationId: 'l' })
    await ipc.invoke('git:push', '/a', { operationId: 'p' })
    await ipc.invoke('git:cancelOperation', '/a', 'p')
    expect(calls).toEqual([
      ['getState', '/a'],
      ['getWorkingDiff', '/a', { path: 'x' }],
      ['initRepository', '/b'],
      ['commit', '/a', { summary: 's' }],
      ['undoLastCommit', '/a'],
      ['discardChanges', '/a', { files: [] }],
      ['getHistory', '/a', { skip: 0, limit: 100 }],
      ['getCommitFiles', '/a', 'abcd'],
      ['getCommitDiff', '/a', { oid: 'abcd' }],
      ['fetch', '/a', { operationId: 'f' }],
      ['pull', '/a', { operationId: 'l' }],
      ['push', '/a', { operationId: 'p' }],
      ['cancelOperation', '/a', 'p']
    ])
  })
})

describe('registerGitIpc clone channels', () => {
  it('forwards the clone request untouched; the parent channels take no argument from the renderer', async () => {
    const ipc = createFakeIpcMain()
    const { handlers, calls } = recordingHandlers()
    registerGitIpc(ipc, handlers)
    await ipc.invoke('git:getCloneParent', '/injected')
    await ipc.invoke('git:chooseCloneParent', '/injected')
    await ipc.invoke('git:clone', { operationId: 'c', url: 'octocat/Hello-World', name: 'Hello-World' }, '/injected')
    expect(calls).toEqual([['getCloneParent'], ['chooseCloneParent'], ['clone', { operationId: 'c', url: 'octocat/Hello-World', name: 'Hello-World' }]])
  })
})

describe('registerGitIpc branch channels', () => {
  it('forwards the branch and stash channels untouched', async () => {
    const ipc = createFakeIpcMain()
    const { handlers, calls } = recordingHandlers()
    registerGitIpc(ipc, handlers)
    const folderOnly: Partial<Record<BranchMethod, true>> = { listBranches: true, listStashes: true }
    for (const name of BRANCH_METHODS) {
      await (folderOnly[name] ? ipc.invoke(`git:${name}`, '/a', 'ignored') : ipc.invoke(`git:${name}`, '/a', { name }))
    }
    expect(calls).toEqual(BRANCH_METHODS.map((name) => (folderOnly[name] ? [name, '/a'] : [name, '/a', { name }])))
  })
})

describe('registerGitIpc conflict channels', () => {
  it('forwards the conflict channels untouched', async () => {
    const ipc = createFakeIpcMain()
    const { handlers, calls } = recordingHandlers()
    registerGitIpc(ipc, handlers)
    const folderOnly: Partial<Record<BranchMethod, true>> = { getConflicts: true, abortMerge: true, abortOperation: true }
    for (const name of CONFLICT_METHODS) {
      await (folderOnly[name] ? ipc.invoke(`git:${name}`, '/a', 'ignored') : ipc.invoke(`git:${name}`, '/a', { name }))
    }
    expect(calls).toEqual(CONFLICT_METHODS.map((name) => (folderOnly[name] ? [name, '/a'] : [name, '/a', { name }])))
  })
})

describe('registerGitIpc pull request channels', () => {
  it('forwards the pull request channels untouched', async () => {
    const ipc = createFakeIpcMain()
    const { handlers, calls } = recordingHandlers()
    registerGitIpc(ipc, handlers)
    const folderOnly: Partial<Record<BranchMethod, true>> = { getCompareUrl: true }
    for (const name of PULL_REQUEST_METHODS) {
      await (folderOnly[name] ? ipc.invoke(`git:${name}`, '/a', 'ignored') : ipc.invoke(`git:${name}`, '/a', { name }))
    }
    expect(calls).toEqual(PULL_REQUEST_METHODS.map((name) => (folderOnly[name] ? [name, '/a'] : [name, '/a', { name }])))
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
