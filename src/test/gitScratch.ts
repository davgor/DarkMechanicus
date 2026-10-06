/** Small helpers for tests that drive a real repository from outside the code under test. Not shipped. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { removeScratch } from './removeScratch'

const CONFIG = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false']

/** Runs git in `cwd` and returns its output untrimmed. */
export function gitIn(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
    delete env[key]
  }
  return execFileSync('git', ['-C', cwd, ...CONFIG, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
}

export function scratchDir(prefix = 'dm-git-'): { path: string; cleanup(): void } {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  return { path, cleanup: () => removeScratch(path) }
}

/** Writes a file (creating folders) relative to `root`. */
export function put(root: string, name: string, content: string | Buffer): void {
  const path = join(root, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** A comparable form of a path: canonical, forward slashes, lower case on Windows. */
export function samePath(path: string): string {
  const real = realpathSync.native(path).replace(/\\/g, '/')
  return process.platform === 'win32' ? real.toLowerCase() : real
}
