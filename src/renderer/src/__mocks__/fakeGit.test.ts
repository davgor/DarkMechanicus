import { describe, expect, it } from 'vitest'
import { FakeGit } from './fakeGit'

describe('FakeGit', () => {
  it('answers per-folder state and diffs, records calls, and reports unknown folders', async () => {
    const git = new FakeGit()
    git.setState('/a', { kind: 'not_repository' })
    git.setDiff('/a', 'x.txt', { kind: 'binary', path: 'x.txt', oldPath: null, oldMode: null, newMode: null, hash: '' } as never)
    expect(await git.getState('/a')).toEqual({ ok: true, data: { kind: 'not_repository' } })
    expect((await git.getWorkingDiff('/a', { path: 'x.txt', oldPath: null, kind: 'modified' })).ok).toBe(true)
    expect(await git.getState('/zzz')).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(await git.initRepository('/a')).toMatchObject({ ok: true })
    expect(git.calls.map((call) => call.method)).toEqual(['getState', 'getWorkingDiff', 'getState', 'initRepository'])
  })

  it('commits, undoes and discards, refusing untracked folders and paths outside the repository', async () => {
    const git = new FakeGit()
    const status = {
      root: '/a',
      branch: { name: 'main', headOid: 'h', upstream: null, ahead: 0, behind: 0 },
      files: [{ path: 'x.txt', oldPath: null, kind: 'modified' as const }],
      inProgress: null
    }
    git.setState('/a', { kind: 'repository', status })
    git.undoneMessage = { summary: 'S', description: 'D' }
    const files = [{ path: 'x.txt', oldPath: null }]
    expect(await git.commit('/a', { summary: 'S', description: '', files })).toMatchObject({ ok: true })
    expect(await git.commit('/a', { summary: ' ', description: '', files })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await git.commit('/a', { summary: 'S', description: '', files: [{ path: '../x', oldPath: null }] })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await git.commit('/zzz', { summary: 'S', description: '', files })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(await git.undoLastCommit('/a')).toEqual({ ok: true, data: { summary: 'S', description: 'D' } })
    expect(await git.undoLastCommit('/zzz')).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(await git.discardChanges('/a', { files: [{ path: '/etc/x', oldPath: null, kind: 'untracked' }] })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await git.discardChanges('/zzz', { files: [] })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    const result = await git.discardChanges('/a', { files: [{ path: 'x.txt', oldPath: null, kind: 'modified' }] })
    expect(result.ok && result.data.kind === 'repository' && result.data.status.files).toEqual([])
  })

  it('delivers progress to listeners until they unsubscribe', () => {
    const git = new FakeGit()
    const seen: number[] = []
    const off = git.onProgress((event) => seen.push(event.percent ?? -1))
    const event = { folder: '/a', operationId: 'o', operation: 'x', phase: 'p', percent: 1 }
    git.emitProgress(event)
    off()
    git.emitProgress(event)
    expect(seen).toEqual([1])
  })
})
