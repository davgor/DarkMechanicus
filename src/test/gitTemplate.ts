/**
 * Fixtures built once per test file and copied per test: a test that needs history, a remote or an operation in
 * progress gets it with a folder copy instead of the dozens of git processes that built it (each costs a few hundred
 * milliseconds on a Windows CI runner). Not shipped.
 */
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, vi } from 'vitest'
import { isolateGitConfig } from './gitRemotes'
import { scratchDir } from './gitScratch'

/** The spellings of an absolute path git may have written into a config file. */
function spellings(path: string): string[] {
  return [path.replaceAll('\\', '\\\\'), path, path.replaceAll('\\', '/')]
}

/** The files that can name a repository's own or another repository's folder: configs and worktree links. */
function linkFiles(folder: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'objects') {
        found.push(...linkFiles(path))
      }
    } else if (entry.name === 'config' || entry.name === 'gitdir' || entry.name === '.git') {
      found.push(path)
    }
  }
  return found
}

/**
 * A copy of `template`, a folder of repositories (a clone, its bare origin, a teammate's clone, linked worktrees), in a
 * new scratch folder removed by `cleanups`. Every config or worktree link that names a folder inside the template
 * names the same folder inside the copy, so the copy pushes to its own origin and never touches the template.
 */
export function copyRepositories(template: string, cleanups: Array<() => void>): string {
  const dir = scratchDir('dm-copy-')
  cleanups.push(dir.cleanup)
  cpSync(template, dir.path, { recursive: true })
  const from = spellings(template)
  const to = spellings(dir.path)
  for (const file of linkFiles(dir.path)) {
    if (!statSync(file).isFile()) {
      continue
    }
    const text = readFileSync(file, 'utf8')
    const next = from.reduce((current, spelling, at) => current.replaceAll(spelling, to[at] ?? spelling), text)
    if (next !== text) {
      writeFileSync(file, next)
    }
  }
  return dir.path
}

/**
 * Builds a fixture once for the file, before its tests, under the same isolated git config the tests use (the
 * person's own config never shapes it), and removes what `build` registered in `cleanups` after them. Returns the
 * fixture; read it inside a test or hook, never while the file is collected.
 */
export function useTemplate<T>(build: (cleanups: Array<() => void>) => T | Promise<T>): () => T {
  const cleanups: Array<() => void> = []
  let built: { value: T } | undefined
  beforeAll(async () => {
    isolateGitConfig(cleanups)
    try {
      built = { value: await build(cleanups) }
    } finally {
      vi.unstubAllEnvs()
    }
  })
  afterAll(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.()
    }
  })
  return () => {
    if (built === undefined) {
      throw new Error('The template exists only once the file has started')
    }
    return built.value
  }
}
