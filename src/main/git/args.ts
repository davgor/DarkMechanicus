/** Builds git argument lists from untrusted paths and refs, refusing anything git could read as an option or an escape. */
import { isAbsolute, posix, win32 } from 'node:path'
import type { GitRunner } from './runner'

function refuse(what: string): never {
  throw new Error(`Refusing to pass ${what} to git.`)
}

function escapesRepository(path: string): boolean {
  let depth = 0
  for (const segment of path.split(/[\\/]+/)) {
    if (segment === '..') {
      depth -= 1
    } else if (segment !== '' && segment !== '.') {
      depth += 1
    }
    if (depth < 0) {
      return true
    }
  }
  return false
}

function isAbsolutePath(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path) || posix.isAbsolute(path) || /^[A-Za-z]:/.test(path)
}

function checkPath(path: string): void {
  if (path === '') {
    refuse('an empty path')
  }
  if (path.includes('\u0000')) {
    refuse('a NUL-containing path')
  }
  if (isAbsolutePath(path)) {
    refuse('an absolute path')
  }
  if (escapesRepository(path)) {
    refuse('a path that leaves the repository')
  }
}

/** `['--', ...paths]`, so no path can be read as an option. */
export function pathArgs(paths: readonly string[]): string[] {
  paths.forEach(checkPath)
  return ['--', ...paths]
}

/** A branch, tag or commit name that is safe as a bare argument. */
export function refArg(name: string): string {
  if (name === '') {
    refuse('an empty ref')
  }
  if (name.startsWith('-')) {
    refuse('an option-like ref')
  }
  if (name.includes('\u0000')) {
    refuse('a NUL-containing ref')
  }
  if (/\s/.test(name)) {
    refuse('a ref with whitespace')
  }
  return name
}

interface BranchNameVerdict {
  valid: boolean
  normalized: string | null
}

/** Asks git whether `name` is a valid branch name (`git check-ref-format --branch`). */
export async function checkBranchName(runner: GitRunner, cwd: string, name: string): Promise<BranchNameVerdict> {
  if (name === '' || name.startsWith('-') || name.includes('\u0000')) {
    return { valid: false, normalized: null }
  }
  const result = await runner.run({ cwd, args: ['check-ref-format', '--branch', name], kind: 'read', acceptExitCodes: [0, 1, 128] })
  const normalized = result.stdout.trim()
  return result.code === 0 && normalized !== '' ? { valid: true, normalized } : { valid: false, normalized: null }
}
