import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { maskAgentChatSecretsDeep } from '../agentChat/secretMask'
import { killProcessTree, startsOwnGroup } from '../agents/processTree'
import { logger } from '../logger'
import type { ArbiterLaunchSpec as Launch } from './arbiterLaunch'
import { parseArbiterVerdict } from './arbiterPrompt'

export type ArbiterResult =
  | { decision: 'allow_once' | 'deny'; reason: string }
  | { decision: 'escalate'; reason: string; cause: 'verdict' | 'invalid' | 'timeout' | 'error' | 'cancelled' }

interface ArbiterOptions {
  /** Called only after the runner has created its fresh, owned working directory. */
  launch: (tempDir: string) => Launch
  input: string
  tempRoot: string
  timeoutMs?: number
  spawn?: typeof spawnChild
  killTree?: typeof killProcessTree
}

const STDOUT_LIMIT = 256 * 1024
const STDERR_LIMIT = 4 * 1024
const safeReason = (reason: string): string => maskAgentChatSecretsDeep(reason).slice(0, 500)
const escalate = (cause: Extract<ArbiterResult, { decision: 'escalate' }>['cause'], reason: string): ArbiterResult =>
  ({ decision: 'escalate', cause, reason: safeReason(reason) })

/** Both injected killers and filesystem failures must fail closed, never strand the result promise. */
async function bounded(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work.then(value => value !== false, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms) })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** What Windows answers while a handle in the directory is still open: a killed descendant's cwd, or a file it held. */
const BUSY_CODES: Record<string, true> = { EBUSY: true, EPERM: true, ENOTEMPTY: true }
const REMOVE_ATTEMPTS = 4

/**
 * Removes the run's directory. `taskkill /t /f` returns once termination has been requested, and the runner waits only
 * for its direct child's exit, so a descendant can still be releasing its handles (its cwd is this directory) when the
 * removal starts. A busy removal is asked again after 50, 100 and 150 ms: 300 ms in all, inside `removeTemp`'s bound.
 */
async function removeDirectory(dir: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= REMOVE_ATTEMPTS || !Object.hasOwn(BUSY_CODES, (error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    await delay(50 * attempt)
  }
}

class ArbiterRun {
  private child?: ChildProcess
  private timer?: NodeJS.Timeout
  private outcome?: ArbiterResult
  private complete!: (result: ArbiterResult) => void
  private readonly completed = new Promise<ArbiterResult>(resolve => { this.complete = resolve })
  private readonly stdout = Buffer.allocUnsafe(STDOUT_LIMIT)
  private stdoutSize = 0
  private stderr = Buffer.alloc(0)
  private stderrTruncated = false
  private treeStopped?: Promise<boolean>
  private realTreeStopped?: Promise<boolean>
  private tempDir?: string
  private creatingDirectory = true
  private tempRemoved?: Promise<boolean>

  constructor(private readonly options: ArbiterOptions) {}

  cancel(): void {
    this.finish(escalate('cancelled', 'Arbiter cancelled.'))
  }

  private finish(result: ArbiterResult): void {
    if (this.outcome) return
    this.outcome = result
    clearTimeout(this.timer)
    this.stopTree()
    this.complete(result)
  }

  private stopRealTree(): Promise<boolean> {
    if (!this.child?.pid) return Promise.resolve(true)
    if (!this.realTreeStopped) {
      try {
        this.realTreeStopped = killProcessTree(this.child, { waitMs: 3_500 }).catch(() => false)
      } catch {
        this.realTreeStopped = Promise.resolve(false)
      }
    }
    return this.realTreeStopped
  }

  private async stopWithFallback(): Promise<boolean> {
    let primary: Promise<boolean>
    try {
      primary = this.options.killTree!(this.child!)
    } catch {
      primary = Promise.resolve(false)
    }
    // Reserve time for the real tree killer and rm inside the existing 4.5 s finalization bound.
    if (await bounded(primary, 250)) return this.realTreeStopped ?? true
    return this.stopRealTree()
  }

  private stopTree(): Promise<boolean> {
    if (!this.child?.pid) return Promise.resolve(true)
    this.treeStopped ??= this.options.killTree && this.options.killTree !== killProcessTree
      ? this.stopWithFallback() : this.stopRealTree()
    return this.treeStopped
  }

  private collectStdout(data: Buffer): void {
    if (this.outcome) return
    if (data.length > STDOUT_LIMIT - this.stdoutSize) {
      this.finish(escalate('invalid', 'Arbiter output exceeded 256 KiB.'))
      return
    }
    data.copy(this.stdout, this.stdoutSize)
    this.stdoutSize += data.length
  }

  private collectStderr(data: Buffer): void {
    this.stderrTruncated ||= this.stderr.length + data.length > STDERR_LIMIT
    const keep = Math.min(this.stderr.length, Math.max(0, STDERR_LIMIT - data.length))
    this.stderr = Buffer.concat([this.stderr.subarray(this.stderr.length - keep), data.subarray(-STDERR_LIMIT)])
  }

  private verdict(code: number | null, launch: Launch): ArbiterResult {
    if (code !== 0) return escalate('error', 'Arbiter process failed.')
    const parsed = parseArbiterVerdict(this.stdout.toString('utf8', 0, this.stdoutSize), launch.protocol)
    if (!parsed.ok) return escalate('invalid', 'Arbiter returned an invalid verdict.')
    const { decision, reason } = parsed.verdict
    return decision === 'escalate' ? escalate('verdict', reason) : { decision, reason: safeReason(reason) }
  }

  private launch(tempDir: string): void {
    const launch = this.options.launch(tempDir)
    // Candidate OMP argv/config is not evidence of MCP isolation or nonempty stdin support.
    if (launch.protocol !== 'claude') {
      this.finish(escalate('error', 'unsupported_kind'))
      return
    }
    this.child = (this.options.spawn ?? spawnChild)(launch.file, launch.args, {
      cwd: launch.cwd, env: launch.env, stdio: 'pipe', windowsHide: true, detached: startsOwnGroup()
    })
    this.child.on('error', () => this.finish(escalate('error', 'Arbiter process failed.')))
    // Capture leftovers synchronously at exit, while its process group cannot have been reused.
    this.child.once('exit', () => { this.stopRealTree(); this.stopTree() })
    this.child.once('close', code => { if (!this.outcome) this.finish(this.verdict(code, launch)) })
    this.child.stdout?.on('data', (data: Buffer) => this.collectStdout(data))
    this.child.stderr?.on('data', (data: Buffer) => this.collectStderr(data))
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream?.on('error', () => this.finish(escalate('error', 'Arbiter stream failed.')))
    }
    if (!this.child.stdin || !this.child.stdout || !this.child.stderr) throw new Error('Missing arbiter pipes')
    this.child.stdin.end(this.options.input)
  }

  private logError(): void {
    let text = this.stderr.toString('utf8')
    // A retained suffix may start inside a secret. Drop that entire partial line before masking.
    if (this.stderrTruncated) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : ''
    try {
      logger.warn('Arbiter process error:', maskAgentChatSecretsDeep(text))
    } catch {
      // Logging must not turn a fail-closed result into a rejected promise.
    }
  }

  private removeTemp(): Promise<boolean> {
    if (!this.tempDir) return Promise.resolve(!this.creatingDirectory)
    this.tempRemoved ??= bounded(removeDirectory(this.tempDir), 500)
    return this.tempRemoved
  }

  private async prepare(): Promise<void> {
    try {
      this.tempDir = await mkdtemp(join(this.options.tempRoot, 'dm-arbiter-'))
      this.creatingDirectory = false
      // The public result may already have settled. Ownership still requires removing a late directory.
      if (this.outcome) { await this.removeTemp(); return }
      this.launch(this.tempDir)
    } catch {
      this.creatingDirectory = false
      this.finish(escalate('error', 'Arbiter failed to start.'))
    }
  }

  private async cleanup(): Promise<boolean> {
    const stopped = await bounded(this.stopTree(), 4_000)
    this.child?.stdin?.destroy()
    this.child?.stdout?.destroy()
    this.child?.stderr?.destroy()
    return await this.removeTemp() && stopped
  }

  async run(): Promise<ArbiterResult> {
    // Directory creation cannot be cancelled by Node; do not await it on the public result path.
    let result: ArbiterResult = escalate('error', 'Arbiter failed to start.')
    let cleaned = false
    this.timer = setTimeout(() => this.finish(escalate('timeout', 'Arbiter timed out.')), this.options.timeoutMs ?? 60_000)
    void this.prepare()
    try {
      result = await this.completed
    } catch {
      this.finish(escalate('error', 'Arbiter failed to start.'))
      result = await this.completed
    } finally {
      clearTimeout(this.timer)
      cleaned = await this.cleanup().catch(() => false)
    }
    if (!cleaned) {
      const cause = result.decision === 'escalate' ? result.cause : 'error'
      result = escalate(cause, 'Arbiter cleanup could not be confirmed.')
    }
    if (result.decision === 'escalate' && result.cause === 'error') this.logError()
    return result
  }
}

/** One isolated, bounded arbiter; policy/input masking must happen before calling this main-only API. */
export function startArbiter(options: ArbiterOptions): { result: Promise<ArbiterResult>; cancel(): void } {
  const run = new ArbiterRun(options)
  return { result: run.run(), cancel: () => run.cancel() }
}
