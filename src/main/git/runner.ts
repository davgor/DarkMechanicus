/**
 * Runs git for Source control in the main process. Unlike core's read-only adapter
 * (`src/core/repo/git.ts`), this one is started by the person, writes, streams progress and can run for
 * minutes: it spawns without a shell, queues writes and network operations per repository, enforces
 * timeouts and output limits, and kills the whole process tree on timeout or cancel.
 *
 * `request.env` is merged last and may carry credentials; it is never logged or put in an error.
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
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

interface GitRunnerOptions {
  spawn?: SpawnFn
  gitPath?: string
  platform?: NodeJS.Platform
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
}

function killTree(ctx: RunnerContext, child: ChildLike): void {
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
  child.kill('SIGTERM')
  setTimeout(() => {
    child.kill('SIGKILL')
  }, KILL_GRACE_MS).unref()
}

/** One git process from spawn to settlement. */
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

  constructor(
    private readonly ctx: RunnerContext,
    private readonly request: GitRunRequest
  ) {}

  run(): Promise<GitRunResult> {
    return new Promise<GitRunResult>((resolveRun, rejectRun) => {
      this.resolveRun = resolveRun
      this.rejectRun = rejectRun
      if (this.request.signal?.aborted) {
        this.finish(new GitError('cancelled', '', 'git operation cancelled'), false)
        return
      }
      try {
        this.child = this.ctx.spawnFn(this.ctx.gitPath, [...FIXED_CONFIG, ...this.request.args], {
          cwd: this.request.cwd,
          env: buildEnv(this.request),
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (error) {
        this.finish(spawnFailure(error), false)
        return
      }
      this.attach(this.child)
    })
  }

  private attach(child: ChildLike): void {
    child.stdout?.on('data', (chunk) => this.take(this.out, chunk, false))
    child.stderr?.on('data', (chunk) => this.take(this.err, chunk, true))
    child.on('error', (error) => this.finish(spawnFailure(error), false))
    child.on('close', (code) => this.closed(code))
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
      killTree(this.ctx, this.child)
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
        this.request.onProgress?.(part)
      }
    }
  }

  private closed(code: number | null): void {
    if (this.settled) {
      return
    }
    this.release()
    this.emitLines(this.decoder.end(), true)
    const result: GitRunResult = {
      code: code ?? -1,
      stdout: Buffer.concat(this.out).toString('utf8'),
      stderr: Buffer.concat(this.err).toString('utf8')
    }
    if ((this.request.acceptExitCodes ?? [0]).includes(result.code)) {
      this.resolveRun(result)
    } else {
      this.rejectRun(classifyGitFailure(result, this.request.args))
    }
  }
}

export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const ctx: RunnerContext = {
    spawnFn: options.spawn ?? ((command, args, opts) => nodeSpawn(command, [...args], opts) as unknown as ChildLike),
    gitPath: options.gitPath ?? 'git',
    platform: options.platform ?? process.platform
  }
  const tails = new Map<string, Promise<void>>()

  return {
    run(request) {
      if (request.kind === 'read') {
        return new Execution(ctx, request).run()
      }
      const key = canonical(request.cwd, ctx.platform)
      const previous = tails.get(key)
      // With nothing ahead of it a write starts at once; otherwise it waits its turn, in request order.
      const result = previous === undefined ? new Execution(ctx, request).run() : previous.then(() => new Execution(ctx, request).run())
      const tail = result.then(
        () => undefined,
        () => undefined
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
