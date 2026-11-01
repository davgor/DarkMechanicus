/**
 * Reads this computer's GitHub CLI login: the github.com token `gh auth token --hostname github.com`
 * prints. `gh` is looked up without a shell (every absolute `PATH` entry, then the install folders a
 * GUI app's minimal `PATH` misses) and run from its full path with prompts, update checks and token
 * env off, no TTY and a timeout. gh's stdout is the token: it is returned and never logged or kept; its stderr is
 * kept only as a short, scrubbed error detail. Runner, `env`, `platform` and `exists` are injected.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { GithubError, scrubSecrets } from './errors'

export interface GhRunRequest {
  file: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
}

/** How a gh run ended. A spawn failure (no such file, not executable) carries no detail. */
export type GhRunResult =
  | { kind: 'exited'; exitCode: number | null; stdout: string; stderr: string }
  | { kind: 'spawn_failed' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }

interface GhLookupDeps {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  /** Whether `path` is a file this process may execute. */
  exists(path: string): boolean
}

interface GhCliDeps extends GhLookupDeps {
  run(request: GhRunRequest): Promise<GhRunResult>
}

interface GhCli {
  /** The github.com token of the GitHub CLI's login. Main-only: never pass it to IPC, a log line or an error. */
  readGhToken(signal?: AbortSignal): Promise<string>
}

const TOKEN_ARGS = ['auth', 'token', '--hostname', 'github.com'] as const
const TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 64 * 1024
const DETAIL_CHARS = 300
/** Shorter stdout words are no token, and scrubbing them would garble the detail. */
const MIN_SCRUBBED_CHARS = 8
/** A token is one run of printable, non-space ASCII: anything else (several lines, a message) is no token. */
const TOKEN_SHAPE = /^[\x21-\x7e]+$/
/** GitHub token prefixes (classic, OAuth, user-to-server, server-to-server, refresh, fine-grained), even stuck to other text. */
const TOKEN_LIKE = /(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g
/**
 * Env dropped (in any case) before gh runs: tokens gh would print instead of its stored login (a
 * shell's `GH_TOKEN` is not the login to keep), and settings that fake a terminal or print debug output.
 */
const DROPPED_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_FORCE_TTY', 'GH_DEBUG', 'DEBUG', 'CLICOLOR_FORCE']

const FALLBACK_DIRS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['/opt/homebrew/bin', '/usr/local/bin'],
  linux: ['/usr/bin', '/snap/bin']
}

/** An env value by name; on Windows names are case-insensitive (`Path`, `PATH`). */
function envValue(deps: GhLookupDeps, name: string): string | undefined {
  if (deps.platform !== 'win32') {
    return deps.env[name]
  }
  const key = Object.keys(deps.env).find((candidate) => candidate.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : deps.env[key]
}

function windowsFallbacks(deps: GhLookupDeps): string[] {
  const programFiles = envValue(deps, 'ProgramFiles')
  const localAppData = envValue(deps, 'LOCALAPPDATA')
  return [
    ...(programFiles === undefined ? [] : [win32.join(programFiles, 'GitHub CLI')]),
    ...(localAppData === undefined ? [] : [win32.join(localAppData, 'Programs', 'GitHub CLI')])
  ]
}

/** Folders to look in, in order: `PATH`, then the usual install folders. */
function searchDirs(deps: GhLookupDeps): string[] {
  const windows = deps.platform === 'win32'
  const fromPath = (envValue(deps, 'PATH') ?? '')
    .split(windows ? ';' : ':')
    .map((entry) => (windows ? entry.trim().replace(/^"(.*)"$/, '$1') : entry))
  const fallbacks = windows ? windowsFallbacks(deps) : (FALLBACK_DIRS[deps.platform] ?? FALLBACK_DIRS.linux ?? [])
  return [...fromPath, ...fallbacks]
}

/**
 * The full path of `gh`, or null. Relative and empty `PATH` entries are skipped, so a `gh` in the
 * working folder is never run. On Windows only `gh.exe`: a `.cmd` or `.bat` would need a shell.
 */
export function findGh(deps: GhLookupDeps): string | null {
  const path = deps.platform === 'win32' ? win32 : posix
  const name = deps.platform === 'win32' ? 'gh.exe' : 'gh'
  for (const dir of searchDirs(deps)) {
    if (dir !== '' && path.isAbsolute(dir)) {
      const candidate = path.join(dir, name)
      if (deps.exists(candidate)) {
        return candidate
      }
    }
  }
  return null
}

function ghEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.entries(env).filter(([key]) => !DROPPED_ENV.includes(key.toUpperCase()))
  return { ...Object.fromEntries(kept), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }
}

/**
 * The last characters of gh's stderr, with every word gh printed on stdout (a token) and anything
 * token-like replaced. Longest words go first, so a word that is the start of the token cannot split it.
 */
function stderrDetail(stderr: string, stdout: string): string | undefined {
  const printed = stdout
    .split(/\s+/)
    .filter((word) => word.length >= MIN_SCRUBBED_CHARS)
    .sort((a, b) => b.length - a.length)
  const scrubbed = scrubSecrets(stderr, printed).replace(TOKEN_LIKE, '[redacted]').trim()
  return scrubbed === '' ? undefined : scrubbed.slice(-DETAIL_CHARS)
}

function tokenOf(result: GhRunResult): string {
  if (result.kind === 'spawn_failed') {
    throw new GithubError('gh_not_installed')
  }
  if (result.kind === 'timeout') {
    throw new GithubError('cancelled', 'The GitHub CLI did not answer in time.')
  }
  if (result.kind === 'aborted') {
    throw new GithubError('cancelled')
  }
  const token = result.stdout.trim()
  if (result.exitCode !== 0 || !TOKEN_SHAPE.test(token)) {
    throw new GithubError('gh_not_signed_in', undefined, stderrDetail(result.stderr, result.stdout))
  }
  return token
}

export function createGhCli(deps: GhCliDeps): GhCli {
  return {
    readGhToken: async (signal) => {
      const file = findGh(deps)
      if (file === null) {
        throw new GithubError('gh_not_installed')
      }
      return tokenOf(await deps.run({ file, args: TOKEN_ARGS, env: ghEnv(deps.env), timeoutMs: TIMEOUT_MS, signal }))
    }
  }
}

/** Whether `path` is an executable file (a directory or a file without the execute bit is not). */
export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false
    }
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A stream's output, kept up to MAX_OUTPUT_BYTES (a token is far shorter). */
function cappedOutput(): { add(chunk: Buffer): void; text(): string } {
  const chunks: Buffer[] = []
  let bytes = 0
  return {
    add: (chunk) => {
      if (bytes < MAX_OUTPUT_BYTES) {
        chunks.push(chunk)
        bytes += chunk.length
      }
    },
    text: () => Buffer.concat(chunks).toString('utf8')
  }
}

function startGh(request: GhRunRequest, group: boolean): ChildProcess | null {
  try {
    return spawn(request.file, [...request.args], { env: request.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: group })
  } catch {
    return null
  }
}

/**
 * Runs gh for real: no shell, stdin closed, stdout and stderr piped (so no TTY), no console window on
 * Windows. A timeout or an abort kills it (its whole process group elsewhere, so a keychain helper
 * it started goes too) and settles at once.
 */
export function runGhProcess(request: GhRunRequest): Promise<GhRunResult> {
  const group = process.platform !== 'win32'
  const child = request.signal?.aborted === true ? null : startGh(request, group)
  if (child === null) {
    return Promise.resolve(request.signal?.aborted === true ? { kind: 'aborted' } : { kind: 'spawn_failed' })
  }
  return new Promise((resolve) => {
    const stdout = cappedOutput()
    const stderr = cappedOutput()
    let settled = false
    const settle = (result: GhRunResult): void => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
    }
    const kill = (result: GhRunResult): void => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      settle(result)
    }
    const onAbort = (): void => kill({ kind: 'aborted' })
    const timer = setTimeout(() => kill({ kind: 'timeout' }), request.timeoutMs)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => stdout.add(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.add(chunk))
    child.on('error', () => settle({ kind: 'spawn_failed' }))
    child.on('close', (exitCode) => settle({ kind: 'exited', exitCode, stdout: stdout.text(), stderr: stderr.text() }))
  })
}
