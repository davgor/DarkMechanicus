/**
 * The Node side of downloading an agent: the real HTTPS download, installer process runner and temp
 * folder that `createAgentInstaller` takes as injected dependencies. Tests exercise them against a
 * fake `fetch` and against Node itself, so no test reaches a network.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { killProcessTree, startsOwnGroup } from '../agents/processTree'
import type { InstallerFiles, InstallerHttp, InstallOutcome, InstallRunner } from './agentInstaller'
import type { InstallEnvironment } from './agentInstallRecipes'

/** Installer scripts are a few tens of kilobytes; anything near this is not one. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
/** How much of an installer's output is kept: the end, which is where the reason for a failure is. */
const MAX_TAIL_CHARS = 16 * 1024

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

interface InstallerHttpOptions {
  maxBytes?: number
  timeoutMs?: number
}

function assertHttps(url: string): void {
  if (new URL(url).protocol !== 'https:') {
    throw new Error(`Refusing an address that is not HTTPS: ${url}`)
  }
}

/** One GET: HTTPS only, before and after redirects, with a timeout, and an error status is an error. */
async function get(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {}
): Promise<Response> {
  assertHttps(url)
  const response = await fetchImpl(url, { redirect: 'follow', headers, signal: AbortSignal.timeout(timeoutMs) })
  if (response.url !== '' && new URL(response.url).protocol !== 'https:') {
    throw new Error(`The address redirected to a non-HTTPS address (${response.url}).`)
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response
}

function wholePercent(received: number, total: number): number | null {
  return total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : null
}

/** Streams the body to a new file (never over an existing one), hashing it on the way. */
async function streamToFile(
  response: Response,
  destination: string,
  maxBytes: number,
  onPercent: (percent: number | null) => void
): Promise<{ sha256: string }> {
  if (response.body === null) {
    throw new Error('The response had no body.')
  }
  const total = Number(response.headers.get('content-length'))
  const hash = createHash('sha256')
  const file = await open(destination, 'wx')
  let received = 0
  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength
      if (received > maxBytes) {
        throw new Error(`The download is larger than the ${maxBytes} bytes an installer script can be.`)
      }
      hash.update(chunk)
      await file.write(chunk)
      onPercent(wholePercent(received, Number.isFinite(total) ? total : 0))
    }
  } finally {
    await file.close()
  }
  return { sha256: hash.digest('hex') }
}

export function createInstallerHttp(fetchImpl: FetchLike = fetch, options: InstallerHttpOptions = {}): InstallerHttp {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  return {
    async getJson(url) {
      const response = await get(fetchImpl, url, timeoutMs, { Accept: 'application/json', 'User-Agent': 'DarkMechanicus' })
      return response.json()
    },
    async download(url, destination, onPercent) {
      return streamToFile(await get(fetchImpl, url, timeoutMs), destination, maxBytes, onPercent)
    }
  }
}

function spawnFailure(error: unknown): InstallOutcome {
  const code = (error as { code?: unknown } | null)?.code
  return {
    kind: 'spawn_failed',
    code: typeof code === 'string' ? code : null,
    message: error instanceof Error ? error.message : String(error)
  }
}

/**
 * Starts the installer without a shell and resolves with how it ended, never rejecting. Output is
 * stdout and stderr together, keeping the end; the process tree is killed when `timeoutMs` passes, and
 * the timeout is reported once it is gone.
 */
export const runInstallerProcess: InstallRunner = (launch, timeoutMs) =>
  new Promise<InstallOutcome>((resolve) => {
    let tail = ''
    let settled = false
    let timedOut = false
    const finish = (outcome: InstallOutcome): void => {
      if (!settled) {
        settled = true
        resolve(outcome)
      }
    }
    let child: ChildProcess
    try {
      child = spawn(launch.file, [...launch.args], {
        shell: false,
        windowsHide: true,
        // A group of its own is what lets a timeout reach what the installer started (macOS and Linux).
        detached: startsOwnGroup(),
        // No stdin: an installer that asks a question sees end-of-file instead of waiting out the timeout.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...launch.env }
      })
    } catch (error) {
      finish(spawnFailure(error))
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      void killProcessTree(child).then(() => {
        finish({ kind: 'timed_out', output: tail })
      })
    }, timeoutMs)
    const collect = (chunk: string): void => {
      tail = (tail + chunk).slice(-MAX_TAIL_CHARS)
    }
    child.stdout?.setEncoding('utf8').on('data', collect)
    child.stderr?.setEncoding('utf8').on('data', collect)
    child.on('error', (error) => {
      clearTimeout(timer)
      finish(spawnFailure(error))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(timedOut ? { kind: 'timed_out', output: tail } : { kind: 'exited', exitCode: code ?? -1, output: tail })
    })
  })

/** Temp folders under `root` (the OS temp folder by default), each made private to this user by `mkdtemp`. */
export function createInstallerFiles(root: string = tmpdir()): InstallerFiles {
  return {
    makeTempDir: () => mkdtempSync(join(root, 'dm-agent-install-')),
    removeDir: (path) => {
      rmSync(path, { recursive: true, force: true })
    }
  }
}

interface EnvironmentSource {
  platform?: string
  arch?: string
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

/** This machine, as the recipes need to see it. */
export function nodeInstallEnvironment(source: EnvironmentSource = {}): InstallEnvironment {
  const homeDir = source.homeDir ?? homedir()
  const env = source.env ?? process.env
  return {
    platform: source.platform ?? process.platform,
    arch: source.arch ?? process.arch,
    homeDir,
    localAppData: env['LOCALAPPDATA'] ?? join(homeDir, 'AppData', 'Local'),
    systemRoot: env['SystemRoot'] ?? 'C:\\Windows'
  }
}
