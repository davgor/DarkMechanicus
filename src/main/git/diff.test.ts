import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileDiff } from '../../shared/git/diff'
import type { FileChange } from '../../shared/git/status'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { gitIn, put, scratchDir } from '../../test/gitScratch'
import { readWorkingDiff } from './diff'
import { createGitRunner } from './runner'
import { readRepoState } from './status'

const runner = createGitRunner()
const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function repo(): GitRepo {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  return r
}

async function changeOf(root: string, path: string): Promise<FileChange> {
  const state = await readRepoState(runner, root)
  if (state.kind !== 'repository') {
    throw new Error('not a repository')
  }
  const change = state.status.files.find((file) => file.path === path)
  if (change === undefined) {
    throw new Error(`no change for ${path}: ${JSON.stringify(state.status.files)}`)
  }
  return change
}

async function diffOf(root: string, path: string, options?: { force?: boolean }): Promise<FileDiff> {
  return readWorkingDiff(runner, root, await changeOf(root, path), options)
}

function textOf(diff: FileDiff): Extract<FileDiff, { kind: 'text' }> {
  if (diff.kind !== 'text') {
    throw new Error(`expected text, got ${diff.kind}`)
  }
  return diff
}

function commitFile(r: GitRepo, name: string, content: string | Buffer): void {
  put(r.root, name, content)
  r.git('add', '--', name)
  r.git('commit', '-q', '-m', `add ${name}`)
}

describe('readWorkingDiff', () => {
  it('reads a modified file with old and new line numbers', async () => {
    const r = repo()
    commitFile(r, 'm.txt', '1\n2\n3\n4\n')
    put(r.root, 'm.txt', '1\ntwo\n3\n4\n5\n')
    const diff = textOf(await diffOf(r.root, 'm.txt'))
    expect(diff).toMatchObject({ path: 'm.txt', oldPath: null })
    expect(diff.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(diff.hunks).toHaveLength(1)
    expect(diff.hunks[0].lines.map((l) => [l.kind, l.text, l.oldNumber, l.newNumber])).toEqual([
      ['context', '1', 1, 1],
      ['delete', '2', 2, null],
      ['add', 'two', null, 2],
      ['context', '3', 3, 3],
      ['context', '4', 4, 4],
      ['add', '5', null, 5]
    ])
  })

  it('reads a staged added file and a deleted file', async () => {
    const r = repo()
    put(r.root, 'new.txt', 'a\nb\n')
    r.git('add', 'new.txt')
    const added = textOf(await diffOf(r.root, 'new.txt'))
    expect(added.newMode).toBe('100644')
    expect(added.hunks[0].lines.map((l) => [l.kind, l.newNumber])).toEqual([
      ['add', 1],
      ['add', 2]
    ])
    rmSync(join(r.root, 'file-1.txt'))
    const deleted = textOf(await diffOf(r.root, 'file-1.txt'))
    expect(deleted.hunks[0].lines.every((l) => l.kind === 'delete')).toBe(true)
    expect(deleted.hunks[0].lines[0]).toMatchObject({ oldNumber: 1, newNumber: null })
  })
})

describe('readWorkingDiff (untracked, renamed, binary)', () => {
  it('reads an untracked file, including a non-ASCII name', async () => {
    const r = repo()
    const name = 'dir/héllo wörld ✓.txt'
    put(r.root, name, 'x\ny\n')
    const diff = textOf(await diffOf(r.root, name))
    expect(diff.path).toBe(name)
    expect(diff.hunks[0].lines.map((l) => [l.kind, l.text, l.newNumber])).toEqual([
      ['add', 'x', 1],
      ['add', 'y', 2]
    ])
  })

  it('reads a rename with an edit', async () => {
    const r = repo()
    commitFile(r, 'before.txt', '1\n2\n3\n4\n5\n6\n7\n8\n')
    r.git('mv', 'before.txt', 'after.txt')
    put(r.root, 'after.txt', '1\n2\n3\n4\n5\n6\n7\n8\n9\n')
    const diff = textOf(await diffOf(r.root, 'after.txt'))
    expect(diff).toMatchObject({ path: 'after.txt', oldPath: 'before.txt' })
    expect(diff.hunks[0].lines.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['9'])
  })

  it('reports a pure rename as empty', async () => {
    const r = repo()
    commitFile(r, 'before.txt', '1\n2\n3\n')
    r.git('mv', 'before.txt', 'after.txt')
    expect(await diffOf(r.root, 'after.txt')).toMatchObject({ kind: 'empty', path: 'after.txt', oldPath: 'before.txt' })
  })

  it('reports binary files, tracked and untracked', async () => {
    const r = repo()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52])
    commitFile(r, 'img.png', png)
    put(r.root, 'img.png', Buffer.concat([png, Buffer.from([0x00, 0xff])]))
    put(r.root, 'fresh.png', png)
    expect(await diffOf(r.root, 'img.png')).toMatchObject({ kind: 'binary', path: 'img.png' })
    expect(await diffOf(r.root, 'fresh.png')).toMatchObject({ kind: 'binary', path: 'fresh.png' })
  })
})

describe('readWorkingDiff (modes, newlines, size)', () => {
  // Skipped on Windows, where the working tree cannot carry an executable bit; the parser tests cover the mode headers.
  it.skipIf(process.platform === 'win32')('reports a mode-only change as empty', async () => {
    const r = repo()
    commitFile(r, 'run.sh', '#!/bin/sh\n')
    chmodSync(join(r.root, 'run.sh'), 0o755)
    expect(await diffOf(r.root, 'run.sh')).toMatchObject({ kind: 'empty', oldMode: '100644', newMode: '100755' })
  })

  it('keeps the no-newline marker', async () => {
    const r = repo()
    commitFile(r, 'n.txt', 'a\nb')
    put(r.root, 'n.txt', 'a\nc')
    const diff = textOf(await diffOf(r.root, 'n.txt'))
    expect(diff.hunks[0].lines.map((l) => [l.kind, l.text, l.noNewlineAtEnd])).toEqual([
      ['context', 'a', false],
      ['delete', 'b', true],
      ['add', 'c', true]
    ])
  })

  it('keeps carriage returns on CRLF lines', async () => {
    const r = repo()
    commitFile(r, 'w.txt', 'one\r\ntwo\r\nthree\r\n')
    put(r.root, 'w.txt', 'one\r\nTWO\r\nthree\r\n')
    const diff = textOf(await diffOf(r.root, 'w.txt'))
    expect(diff.hunks[0].lines.map((l) => l.text)).toEqual(['one\r', 'two\r', 'TWO\r', 'three\r'])
  })

  it('diffs every file on an unborn branch against nothing', async () => {
    const dir = scratchDir()
    cleanups.push(dir.cleanup)
    gitIn(dir.path, 'init', '-q', '-b', 'main')
    put(dir.path, 'staged.txt', 's\n')
    put(dir.path, 'loose.txt', 'l\n')
    gitIn(dir.path, 'add', 'staged.txt')
    expect(textOf(await diffOf(dir.path, 'staged.txt')).hunks[0].lines).toHaveLength(1)
    expect(textOf(await diffOf(dir.path, 'loose.txt')).hunks[0].lines[0]).toMatchObject({ kind: 'add', text: 'l' })
  })

  it('reports too_large above 2 MiB and reads it with force', async () => {
    const r = repo()
    put(r.root, 'big.txt', `${'x'.repeat(99)}\n`.repeat(25_000))
    expect(await diffOf(r.root, 'big.txt')).toMatchObject({ kind: 'too_large', bytes: 2 * 1024 * 1024, path: 'big.txt' })
    const forced = textOf(await diffOf(r.root, 'big.txt', { force: true }))
    expect(forced.hunks[0].lines).toHaveLength(25_000)
  })
})

describe('readWorkingDiff (external programs)', () => {
  it('never runs a configured external diff, textconv driver or fsmonitor', async () => {
    const r = repo()
    const tools = scratchDir()
    cleanups.push(tools.cleanup)
    const dir = tools.path.replace(/\\/g, '/')
    const markers = { ext: `${dir}/ext.marker`, conv: `${dir}/conv.marker`, mon: `${dir}/mon.marker` }
    writeFileSync(join(tools.path, 'ext.sh'), `echo ran >> "${markers.ext}"\n`)
    writeFileSync(join(tools.path, 'conv.sh'), `echo ran >> "${markers.conv}"\ncat "$1"\n`)
    writeFileSync(join(tools.path, 'mon.sh'), `echo ran >> "${markers.mon}"\n`)
    commitFile(r, 'doc.txt', 'a\nb\n')
    put(r.root, '.gitattributes', '*.txt diff=marker\n')
    r.git('config', 'diff.external', `sh ${dir}/ext.sh`)
    r.git('config', 'diff.marker.textconv', `sh ${dir}/conv.sh`)
    r.git('config', 'core.fsmonitor', `sh ${dir}/mon.sh`)
    put(r.root, 'doc.txt', 'a\nc\n')
    put(r.root, 'loose.txt', 'l\n')

    // Control: plain git runs them, so a marker can appear. An external diff replaces textconv, so
    // each is exercised on its own.
    gitIn(r.root, 'diff', 'HEAD', '--', 'doc.txt')
    gitIn(r.root, 'status', '--porcelain')
    expect(existsSync(markers.ext)).toBe(true)
    r.git('config', '--unset', 'diff.external')
    gitIn(r.root, 'diff', 'HEAD', '--', 'doc.txt')
    expect(existsSync(markers.conv)).toBe(true)
    r.git('config', 'diff.external', `sh ${dir}/ext.sh`)
    for (const marker of Object.values(markers)) {
      rmSync(marker, { force: true })
    }

    textOf(await diffOf(r.root, 'doc.txt'))
    textOf(await diffOf(r.root, 'loose.txt'))
    for (const marker of Object.values(markers)) {
      expect(existsSync(marker)).toBe(false)
    }
  })
})
