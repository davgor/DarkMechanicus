/** Opening a conflicted file in the default app: only a conflicted file, and only inside the repository. */
import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { put } from '../../test/gitScratch'
import { getConflicts, markResolved, openInEditor } from './conflicts'
import { createGitRunner } from './runner'

const runner = createGitRunner()
const cleanups: Array<() => void> = []
beforeEach(() => isolateGitConfig(cleanups))
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

/** `main` merging `topic` with `sub/f.txt` and `top.txt` both modified. */
function conflicted(): GitRepo {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  put(r.root, 'sub/f.txt', 'base\n')
  put(r.root, 'top.txt', 'base\n')
  r.git('add', '-A')
  r.git('commit', '-q', '-m', 'base')
  r.branch('topic')
  put(r.root, 'sub/f.txt', 'theirs\n')
  put(r.root, 'top.txt', 'theirs\n')
  r.git('commit', '-q', '-am', 'theirs')
  r.switchTo('main')
  put(r.root, 'sub/f.txt', 'ours\n')
  put(r.root, 'top.txt', 'ours\n')
  r.git('commit', '-q', '-am', 'ours')
  expect(() => r.git('merge', '-q', 'topic')).toThrow()
  return r
}

function opener(result = ''): { openPath: (path: string) => Promise<string>; opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    openPath: (path) => {
      opened.push(path)
      return Promise.resolve(result)
    }
  }
}

/** A directory outside the repository, next to it, holding `f.txt`. */
function outsideDir(r: GitRepo): string {
  const dir = join(r.root, '..', 'outside', 'sub')
  mkdirSync(dir, { recursive: true })
  put(dir, 'f.txt', '<<<<<<< not ours\n')
  return dir
}

describe('openInEditor', () => {
  it('opens a conflicted file by its absolute path', async () => {
    const r = conflicted()
    const { openPath, opened } = opener()
    await openInEditor(runner, r.root, 'sub/f.txt', { openPath })
    expect(opened).toEqual([join(r.root, 'sub', 'f.txt')])
  })

  it('refuses `..`, absolute paths and files that are not conflicted, opening nothing', async () => {
    const r = conflicted()
    const { openPath, opened } = opener()
    await expect(openInEditor(runner, r.root, '../outside/sub/f.txt', { openPath })).rejects.toThrow(/stay inside the repository/)
    await expect(openInEditor(runner, r.root, 'sub/../../top.txt', { openPath })).rejects.toThrow(/stay inside the repository/)
    await expect(openInEditor(runner, r.root, join(r.root, 'top.txt'), { openPath })).rejects.toThrow(/stay inside the repository/)
    await expect(openInEditor(runner, r.root, '/etc/hosts', { openPath })).rejects.toThrow(/stay inside the repository/)
    await expect(openInEditor(runner, r.root, 'file-1.txt', { openPath })).rejects.toThrow(/not a conflicted file/)
    await expect(openInEditor(runner, r.root, '.git/config', { openPath })).rejects.toThrow(/not a conflicted file/)
    await expect(openInEditor(runner, r.root, 'sub/./f.txt', { openPath })).rejects.toThrow(/not a conflicted file/)
    expect(opened).toEqual([])
  })
})

describe('openInEditor through symlinks and missing files', () => {
  it('refuses a conflicted path that a symlink leads out of the repository', async () => {
    const r = conflicted()
    const dir = outsideDir(r)
    renameSync(join(r.root, 'sub'), join(r.root, 'sub-moved'))
    symlinkSync(dir, join(r.root, 'sub'), 'junction')
    const { openPath, opened } = opener()
    await expect(openInEditor(runner, r.root, 'sub/f.txt', { openPath })).rejects.toThrow(/outside the repository/)
    expect(opened).toEqual([])
    const file = (await getConflicts(runner, r.root)).files.find((entry) => entry.path === 'sub/f.txt')
    expect(file?.markers).toBe(0)
  })

  it('refuses a conflicted file that is itself a symlink out of the repository', async () => {
    const r = conflicted()
    const dir = outsideDir(r)
    renameSync(join(r.root, 'top.txt'), join(r.root, 'top-moved.txt'))
    symlinkSync(join(dir, 'f.txt'), join(r.root, 'top.txt'))
    const { openPath, opened } = opener()
    await expect(openInEditor(runner, r.root, 'top.txt', { openPath })).rejects.toThrow(/outside the repository/)
    expect(opened).toEqual([])
    expect((await getConflicts(runner, r.root)).files.find((entry) => entry.path === 'top.txt')?.markers).toBe(0)
  })

  it('refuses a conflicted file that is missing', async () => {
    const r = conflicted()
    rmSync(join(r.root, 'top.txt'))
    const { openPath, opened } = opener()
    await expect(openInEditor(runner, r.root, 'top.txt', { openPath })).rejects.toThrow(/is not in the working tree/)
    expect(opened).toEqual([])
  })

  it('reports what the default app could not do', async () => {
    const r = conflicted()
    const { openPath } = opener('No application knows how to open this file.')
    await expect(openInEditor(runner, r.root, 'top.txt', { openPath })).rejects.toThrow(/No application knows how to open/)
  })

  it('leaves the repository alone when Mark resolved is asked through a symlinked folder', async () => {
    const r = conflicted()
    const dir = outsideDir(r)
    renameSync(join(r.root, 'sub'), join(r.root, 'sub-moved'))
    symlinkSync(dir, join(r.root, 'sub'), 'junction')
    // Refused before git runs: git refuses a path beyond a symlink, but git for Windows stages through a junction.
    await expect(markResolved(runner, r.root, { path: 'sub/f.txt' })).rejects.toThrow('sub/f.txt is reached through a linked folder, so it is not staged.')
    expect(r.git('ls-files', '-u', '--', 'sub/f.txt')).not.toBe('')
  })

  it('stages the deletion of a conflicted file whose whole folder is gone, since no link leads to it', async () => {
    const r = conflicted()
    rmSync(join(r.root, 'sub'), { recursive: true })
    await expect(markResolved(runner, r.root, { path: 'sub/f.txt' })).resolves.toMatchObject({ kind: 'repository' })
    expect(r.git('ls-files', '--stage', '--', 'sub/f.txt')).toBe('')
  })
})

/** `main` merging `topic` with every one of `names` modified on both sides, in one repository and one merge. */
function conflictedFiles(names: readonly string[]): GitRepo {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  const side = (content: string, message: string): void => {
    for (const name of names) {
      put(r.root, name, content)
    }
    r.git('add', '-A')
    r.git('commit', '-q', '-m', message)
  }
  side('base\n', 'base')
  r.branch('topic')
  side('theirs\n', 'theirs')
  r.switchTo('main')
  side('ours\n', 'ours')
  expect(() => r.git('merge', '-q', 'topic')).toThrow()
  return r
}

/** `main` merging `topic` with `name` both modified; `mode` is applied to the working file afterwards. */
function conflictedFile(name: string, mode?: number): GitRepo {
  const r = conflictedFiles([name])
  if (mode !== undefined) {
    chmodSync(join(r.root, name), mode)
  }
  return r
}

describe('openInEditor never launches a program', () => {
  // Windows keeps no executable bit; it runs a file by its extension, which the tests below cover.
  it.skipIf(process.platform === 'win32')('refuses an executable file, which the default app could run', async () => {
    const r = conflictedFile('setup', 0o755)
    const { openPath, opened } = opener()
    await expect(openInEditor(runner, r.root, 'setup', { openPath })).rejects.toThrow(/could run as a program/)
    expect(opened).toEqual([])
  })

  it('refuses names the OS opens by running them', async () => {
    const names = ['deploy.command', 'install.BAT', 'run.exe', 'tool.js', 'script.ps1', 'link.url']
    const r = conflictedFiles(names)
    for (const name of names) {
      const { openPath, opened } = opener()
      await expect(openInEditor(runner, r.root, name, { openPath })).rejects.toThrow(/could run as a program/)
      expect(opened).toEqual([])
    }
  })

  it('on Windows also refuses Python and the other script types, and every extension PATHEXT lists', async () => {
    const names = ['tool.py', 'gui.PYW', 'app.pyz', 'run.pl', 'start.jnlp', 'help.chm', 'x.wsc', 'y.sct', 'z.ws', 'e.scf', 'f.xbap', 'job.xyz', 'm.abc']
    const r = conflictedFiles(names)
    const windows = { platform: 'win32' as const, env: { PATHEXT: '.COM;.EXE;.XYZ; .Abc ;;' } }
    for (const name of names) {
      const { openPath, opened } = opener()
      await expect(openInEditor(runner, r.root, name, { openPath, system: windows })).rejects.toThrow(/could run as a program/)
      expect(opened).toEqual([])
    }
  })

  it('honours PATHEXT only on Windows', async () => {
    const r = conflictedFile('job.xyz')
    const { openPath, opened } = opener()
    await openInEditor(runner, r.root, 'job.xyz', { openPath, system: { platform: 'darwin', env: { PATHEXT: '.XYZ' } } })
    expect(opened).toEqual([join(r.root, 'job.xyz')])
  })

  it('refuses a conflicted path that is a folder (a submodule), and one inside a nested .git', async () => {
    const r = conflictedFile('top.txt')
    rmSync(join(r.root, 'top.txt'))
    mkdirSync(join(r.root, 'top.txt'))
    const { openPath, opened } = opener()
    await expect(openInEditor(runner, r.root, 'top.txt', { openPath })).rejects.toThrow(/is not a file/)
    const nested = conflictedFile('cfg')
    mkdirSync(join(nested.root, 'vendor', 'n', '.git'), { recursive: true })
    put(nested.root, 'vendor/n/.git/config', '[core]\n')
    rmSync(join(nested.root, 'cfg'))
    symlinkSync(join(nested.root, 'vendor', 'n', '.git', 'config'), join(nested.root, 'cfg'))
    await expect(openInEditor(runner, nested.root, 'cfg', { openPath })).rejects.toThrow(/outside the repository/)
    expect(opened).toEqual([])
  })
})
