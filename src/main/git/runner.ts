/**
 * Runs git for Source control in the main process. Unlike core's read-only adapter
 * (`src/core/repo/git.ts`), this one is started by the person, writes, streams progress and can run for
 * minutes: it spawns without a shell, queues writes and network operations per repository, enforces
 * timeouts and output limits, and kills the whole process tree on timeout or cancel.
 *
 * `request.env` is merged last and may carry credentials; it is never logged or put in an error. Each
 * `request.redact` string is replaced in the output, the progress lines and the error detail before anyone sees them.
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { scrubSecrets } from '../github/errors'
import { classifyGitFailure, GitError, type GitRunResult, stderrTail } from './errors'

type GitRunKind = 'read' | 'write' | 'network'

export interface GitRunRequest {
  cwd: string
  args: readonly string[]
  kind: GitRunKind
  stdin?: string
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
  onProgress?(line: string): void
  /** Secrets (a token) to replace in stdout, stderr, progress lines and error details. */
  redact?: readonly string[]
  acceptExitCodes?: readonly number[]
}

interface ReadableLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
}

/** The part of a child process the runner uses, so tests can fake it. */
export interface ChildLike {
  pid?: number
  stdout: ReadableLike | null
  stderr: ReadableLike | null
  stdin: { end(data?: string): unknown; on(event: 'error', listener: () => void): unknown } | null
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildLike

export interface GitRunner {
  run(request: GitRunRequest): Promise<GitRunResult>
}

/** Signals a whole process group (`process.kill(-pgid)`); throws when the group is gone. */
type GroupKill = (pgid: number, signal: NodeJS.Signals) => void

interface GitRunnerOptions {
  spawn?: SpawnFn
  gitPath?: string
  platform?: NodeJS.Platform
  /** Defaults to `process.kill(-pgid)` with the real spawn on macOS and Linux; none with a fake spawn or on Windows. */
  killGroup?: GroupKill | null
}

const FIXED_CONFIG = ['-c', 'core.quotepath=false', '-c', 'color.ui=never', '-c', 'core.fsmonitor=false']
const REDIRECTING_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE'
]
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const READ_TIMEOUT_MS = 30_000
const WRITE_TIMEOUT_MS = 120_000
const KILL_GRACE_MS = 2000

function buildEnv(request: GitRunRequest): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of REDIRECTING_ENV) {
    delete env[key]
  }
  env.GIT_TERMINAL_PROMPT = '0'
  // Git asks an askpass program (GIT_ASKPASS, core.askPass, SSH_ASKPASS) even with terminal prompts off; an empty
  // GIT_ASKPASS turns all three off, so a credential git cannot get fails at once instead of waiting on a dialog.
  env.GIT_ASKPASS = ''
  // Git Credential Manager ignores both and opens its own sign-in window unless told not to interact.
  env.GCM_INTERACTIVE = 'never'
  env.LC_ALL = 'C'
  env.LANGUAGE = 'en'
  if (request.kind === 'read') {
    env.GIT_OPTIONAL_LOCKS = '0'
  }
  return { ...env, ...request.env }
}

function timeoutFor(request: GitRunRequest): number | null {
  if (request.timeoutMs !== undefined) {
    return request.timeoutMs
  }
  if (request.kind === 'read') {
    return READ_TIMEOUT_MS
  }
  return request.kind === 'write' ? WRITE_TIMEOUT_MS : null
}

function canonical(cwd: string, platform: NodeJS.Platform): string {
  let path = resolve(cwd)
  try {
    path = realpathSync.native(path)
  } catch {
    // A folder that does not exist yet is keyed by its resolved path.
  }
  return platform === 'win32' ? path.toLowerCase() : path
}

interface RunnerContext {
  spawnFn: SpawnFn
  gitPath: string
  platform: NodeJS.Platform
  /** When set, each git starts as the leader of its own process group (and session, so without a terminal), and a kill ends the group. */
  killGroup: GroupKill | null
}

/** One signal to git's whole process group (so `git pull`'s own `git fetch` gets it too), or to git alone without one. */
function signalTree(ctx: RunnerContext, child: ChildLike, signal: NodeJS.Signals): void {
  if (ctx.killGroup !== null && child.pid !== undefined) {
    try {
      ctx.killGroup(child.pid, signal)
      return
    } catch {
      // The group is gone already; signal the child itself in case it is not.
    }
  }
  child.kill(signal)
}

/** Windows: taskkill of the tree. Elsewhere: SIGTERM, then SIGKILL after a grace period unless git has exited by then. */
function killTree(ctx: RunnerContext, child: ChildLike, exited: () => boolean): void {
  if (ctx.platform === 'win32' && child.pid !== undefined) {
    try {
      const killer = ctx.spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => {
        child.kill()
      })
    } catch {
      child.kill()
    }
    return
  }
  signalTree(ctx, child, 'SIGTERM')
  setTimeout(() => {
    // Once git has exited its pid, and so its group id, may belong to something else.
    if (!exited()) {
      signalTree(ctx, child, 'SIGKILL')
    }
  }, KILL_GRACE_MS).unref()
}

/** One git process from spawn to settlement; `exited` settles once it is gone (or was never started). */
class Execution {
  private readonly out: Buffer[] = []
  private readonly err: Buffer[] = []
  private readonly decoder = new StringDecoder('utf8')
  private bytes = 0
  private pending = ''
  private settled = false
  private timer: NodeJS.Timeout | null = null
  private child: ChildLike | null = null
  private resolveRun: (result: GitRunResult) => void = () => undefined
  private rejectRun: (error: GitError) => void = () => undefined
  private gone = false
  private markGone: () => void = () => undefined
  readonly exited: Promise<void>

  constructor(
    private readonly ctx: RunnerContext,
    private readonly request: GitRunRequest
  ) {
    this.exited = new Promise<void>((resolve) => {
      this.markGone = () => {
        this.gone = true
        resolve()
      }
    })
  }

  run(): Promise<GitRunResult> {
    return new Promise<GitRunResult>((resolveRun, rejectRun) => {
      this.resolveRun = resolveRun
      this.rejectRun = rejectRun
      if (this.request.signal?.aborted) {
        this.markGone()
        this.finish(new GitError('cancelled', '', 'git operation cancelled'), false)
        return
      }
      try {
        this.child = this.ctx.spawnFn(this.ctx.gitPath, [...FIXED_CONFIG, ...this.request.args], {
          cwd: this.request.cwd,
          env: buildEnv(this.request),
          shell: false,
          windowsHide: true,
          detached: this.ctx.killGroup !== null,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (error) {
        this.markGone()
        this.finish(spawnFailure(error), false)
        return
      }
      this.attach(this.child)
    })
  }

  private attach(child: ChildLike): void {
    child.stdout?.on('data', (chunk) => this.take(this.out, chunk, false))
    child.stderr?.on('data', (chunk) => this.take(this.err, chunk, true))
    child.on('error', (error) => {
      this.markGone()
      this.finish(spawnFailure(error), false)
    })
    child.on('close', (code) => {
      this.markGone()
      this.closed(code)
    })
    const limit = timeoutFor(this.request)
    if (limit !== null) {
      this.timer = setTimeout(() => this.finish(new GitError('timeout', '', `git timed out after ${limit} ms`), true), limit)
    }
    this.request.signal?.addEventListener('abort', this.onAbort, { once: true })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(this.request.stdin)
  }

  private readonly onAbort = (): void => {
    this.finish(new GitError('cancelled', '', 'git operation cancelled'), true)
  }

  /** Rejects once, stops the timer and the abort listener, and optionally kills the process tree. */
  private finish(error: GitError, kill: boolean): void {
    if (this.settled) {
      return
    }
    this.release()
    if (kill && this.child !== null) {
      killTree(this.ctx, this.child, () => this.gone)
    }
    this.rejectRun(error)
  }

  private release(): void {
    this.settled = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
    }
    this.request.signal?.removeEventListener('abort', this.onAbort)
  }

  private take(into: Buffer[], chunk: Buffer | string, progress: boolean): void {
    if (this.settled) {
      return
    }
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    this.bytes += buffer.length
    const max = this.request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    if (this.bytes > max) {
      this.finish(new GitError('output_too_large', '', `git output exceeded ${max} bytes`), true)
      return
    }
    into.push(buffer)
    if (progress) {
      this.emitLines(this.decoder.write(buffer), false)
    }
  }

  /** Progress lines: stderr split on both CR and LF, because git redraws progress with CR. */
  private emitLines(text: string, final: boolean): void {
    const parts = (this.pending + text).split(/[\r\n]/)
    this.pending = final ? '' : (parts.pop() ?? '')
    for (const part of parts) {
      if (part !== '') {
        this.request.onProgress?.(scrubSecrets(part, this.request.redact ?? []))
      }
    }
  }

  private closed(code: number | null): void {
    if (this.settled) {
      return
    }
    this.release()
    this.emitLines(this.decoder.end(), true)
    const secrets = this.request.redact ?? []
    const result: GitRunResult = {
      code: code ?? -1,
      stdout: scrubSecrets(Buffer.concat(this.out).toString('utf8'), secrets),
      stderr: scrubSecrets(Buffer.concat(this.err).toString('utf8'), secrets)
    }
    if ((this.request.acceptExitCodes ?? [0]).includes(result.code)) {
      this.resolveRun(result)
    } else {
      this.rejectRun(classifyGitFailure(result, this.request.args))
    }
  }
}

export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const platform = options.platform ?? process.platform
  // A fake spawn's pids are made up: signalling their group could hit a real process.
  const realGroup: GroupKill | null = options.spawn === undefined && platform !== 'win32' ? (pgid, signal) => process.kill(-pgid, signal) : null
  const ctx: RunnerContext = {
    spawnFn: options.spawn ?? ((command, args, opts) => nodeSpawn(command, [...args], opts) as unknown as ChildLike),
    gitPath: options.gitPath ?? 'git',
    platform,
    killGroup: options.killGroup === undefined ? realGroup : options.killGroup
  }
  const tails = new Map<string, Promise<void>>()

  return {
    run(request) {
      if (request.kind === 'read') {
        return new Execution(ctx, request).run()
      }
      const key = canonical(request.cwd, ctx.platform)
      const previous = tails.get(key)
      let exited: Promise<void> = Promise.resolve()
      const start = (): Promise<GitRunResult> => {
        const execution = new Execution(ctx, request)
        exited = execution.exited
        return execution.run()
      }
      // With nothing ahead of it a write starts at once; otherwise it waits its turn, in request order.
      const result = previous === undefined ? start() : previous.then(start)
      // The next one waits until this git is gone, not just settled: a cancelled or timed-out git may still be writing.
      const tail = result.then(
        () => exited,
        () => exited
      )
      tails.set(key, tail)
      void tail.then(() => {
        if (tails.get(key) === tail) {
          tails.delete(key)
        }
      })
      return result
    }
  }
}

function spawnFailure(error: unknown): GitError {
  const code = (error as { code?: unknown }).code
  const message = error instanceof Error ? error.message : String(error)
  return code === 'ENOENT'
    ? new GitError('git_not_found', stderrTail(message), 'git was not found')
    : new GitError('git_failed', stderrTail(message), 'git could not be started')
}
