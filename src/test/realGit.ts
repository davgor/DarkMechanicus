/**
 * Vitest global setup: on Windows, every test worker finds the real git.exe first on PATH. Not shipped.
 *
 * `git` on a Windows PATH is Git for Windows' launcher (`cmd\git.exe`), which starts the real git.exe as a second
 * process for each call and waits for it. The real binary sets up the same environment for itself and the hooks and
 * aliases it runs (MSYSTEM, HOME, its own folders first on PATH), so git behaves the same without the launcher, at one
 * process per call instead of two. The suite starts tens of thousands of git processes, the code under test's
 * included, and on a loaded Windows machine each process start is what a git-heavy test waits on.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

interface RealGitDeps {
  platform: NodeJS.Platform
  path: string
  /** What `git --exec-path` prints: Git's helper directory. */
  execPath: () => string
  exists: (file: string) => boolean
}

/** Put the real git.exe first on Windows, including distributions with no executable in libexec. */
export function realGitFirst(deps: RealGitDeps): string {
  if (deps.platform !== 'win32') {
    return deps.path
  }
  let folder: string
  try {
    folder = win32.normalize(deps.execPath().trim())
  } catch {
    // No git to ask: the tests that need it fail as they would have.
    return deps.path
  }
  if (deps.exists(win32.join(folder, 'git.exe'))) return `${folder}${win32.delimiter}${deps.path}`
  if (!win32.isAbsolute(folder) || win32.basename(folder).toLowerCase() !== 'git-core' ||
      win32.basename(win32.dirname(folder)).toLowerCase() !== 'libexec') return deps.path
  const bin = win32.resolve(folder, '..', '..', 'bin')
  return deps.exists(win32.join(bin, 'git.exe')) ? `${bin}${win32.delimiter}${deps.path}` : deps.path
}

export default function setup(): void {
  const path = process.env.PATH ?? ''
  const first = realGitFirst({
    platform: process.platform,
    path,
    execPath: () => execFileSync('git', ['--exec-path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }),
    exists: existsSync
  })
  if (first !== path) {
    // Workers are started after the global setup, with this process's environment.
    process.env.PATH = first
  }
}
