import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { killProcessTree, startsOwnGroup } from '../agents/processTree'
import { windowsAgentJob } from './windowsAgentJob'

const MAX_LINE_BYTES = 8 * 1024 * 1024
const STDERR_BYTES = 64 * 1024

interface ProcessSpec {
  file: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface AgentProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
}

export interface AgentProcess {
  pid: number | undefined
  write(line: string): boolean
  onLine(cb: (line: string) => void): () => void
  onStderr(cb: (tail: string) => void): () => void
  onExit(cb: (exit: AgentProcessExit) => void): () => void
  stop(options?: { force?: boolean }): Promise<void>
}

type Spawn = (file: string, args: string[], options: SpawnOptions) => ChildProcess

class JsonlProcess implements AgentProcess {
  readonly pid: number | undefined
  private readonly lines = new Set<(line: string) => void>()
  private readonly diagnostics = new Set<(tail: string) => void>()
  private readonly exits = new Set<(exit: AgentProcessExit) => void>()
  private parts: Buffer[] = []
  private length = 0
  private dropping = false
  private stderr: Buffer = Buffer.alloc(0)
  private exit: AgentProcessExit | undefined
  private ended = false
  private writable = true
  private stopping: Promise<void> | undefined
  private treeCleanup: Promise<boolean> | undefined
  private resolveEnded!: () => void
  // The repository's ES library predates Promise.withResolvers.
  private readonly whenEnded = new Promise<void>((resolve) => { this.resolveEnded = resolve })

  constructor(private readonly child: ChildProcess, bootstrap?: Buffer) {
    this.pid = child.pid
    child.stdout?.on('data', (data: Buffer) => this.frame(data))
    child.stdout?.on('end', () => {
      if (this.length || this.dropping) this.deliver()
    })
    child.stderr?.on('data', (data: Buffer) => this.diagnostic(data))
    child.stdin?.on('error', (error) => this.writeError(error))
    child.once('exit', () => {
      // Check the group while it still belongs to this child, never at a later disposal.
      if (startsOwnGroup()) void this.killTree()
      this.markEnded()
    })
    child.once('error', (error) => {
      this.diagnostic(Buffer.from(`${error.message}\n`))
      this.markEnded()
    })
    // close follows stdout/stderr end, preserving the trailing line and complete stderr.
    child.once('close', (code, signal) => {
      this.markEnded()
      this.exit = { code, signal, stderr: this.stderrTail() }
      for (const cb of this.exits) cb(this.exit)
      this.exits.clear()
    })
    // Queue launch metadata before callers can write JSONL or end stdin. Both share one ordered pipe.
    if (bootstrap) {
      try { child.stdin?.write(bootstrap, (error) => { if (error) this.writeError(error) }) }
      catch (error) { this.writeError(error as Error) }
    }
  }

  private stderrTail(): string {
    // A byte-bounded tail may start inside a UTF-8 character; omit that incomplete prefix.
    let start = 0
    while (start < this.stderr.length && (this.stderr[start] & 0xc0) === 0x80) start++
    return this.stderr.toString('utf8', start)
  }

  private diagnostic(data: Buffer): void {
    const keep = Math.min(this.stderr.length, Math.max(0, STDERR_BYTES - data.length))
    this.stderr = Buffer.concat([this.stderr.subarray(this.stderr.length - keep), data.subarray(-STDERR_BYTES)])
    const tail = this.stderrTail()
    for (const cb of this.diagnostics) cb(tail)
  }

  private deliver(): void {
    if (!this.dropping) {
      const data = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.length)
      const line = data.toString('utf8').replace(/\r$/, '')
      for (const cb of this.lines) cb(line)
    }
    this.parts = []
    this.length = 0
    this.dropping = false
  }

  private append(data: Buffer): void {
    if (this.dropping || data.length === 0) return
    if (this.length + data.length > MAX_LINE_BYTES) {
      this.parts = []
      this.length = 0
      this.dropping = true
      this.diagnostic(Buffer.from('Agent stdout line exceeded 8 MiB; dropped.\n'))
    } else {
      this.parts.push(data)
      this.length += data.length
    }
  }

  private frame(data: Buffer): void {
    let start = 0
    for (;;) {
      const lf = data.indexOf(10, start)
      if (lf === -1) { this.append(data.subarray(start)); break }
      this.append(data.subarray(start, lf))
      this.deliver()
      start = lf + 1
    }
  }

  private markEnded(): void {
    this.ended = true
    this.writable = false
    this.resolveEnded()
  }

  private writeError(error: Error): void {
    this.writable = false
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') this.diagnostic(Buffer.from(`${error.message}\n`))
    // EPIPE can precede exit/close. Keep the real exit code and final stderr, not a synthetic exit.
    if (this.child.exitCode !== null || this.child.signalCode !== null) this.markEnded()
  }

  private killTree(): Promise<boolean> {
    this.treeCleanup ??= killProcessTree(this.child).catch((error: unknown) => {
      this.diagnostic(Buffer.from(`Agent process-tree shutdown failed: ${String(error)}\n`))
      return false
    })
    return this.treeCleanup
  }

  private async shutdown(): Promise<void> {
    let escalation: NodeJS.Timeout | undefined
    let deadline: NodeJS.Timeout | undefined
    const bounded = new Promise<void>((resolve) => {
      deadline = setTimeout(() => {
        this.diagnostic(Buffer.from('Agent process shutdown exceeded 5 seconds.\n'))
        resolve()
      }, 5_000)
    })
    const shutdown = async (): Promise<void> => {
      if (!this.ended) {
        escalation = setTimeout(() => { void this.killTree() }, 3_000)
        this.writable = false
        try { this.child.stdin?.end() } catch (error) { this.writeError(error as Error) }
        await this.whenEnded
      }
      await this.treeCleanup
    }
    try { await Promise.race([shutdown(), bounded]) } finally {
      clearTimeout(escalation)
      clearTimeout(deadline)
    }
  }

  /** False means stdin has closed/exited; backpressure alone is not an exit. */
  write(line: string): boolean {
    const { child } = this
    if (!this.writable || this.ended || child.exitCode !== null || child.signalCode !== null || !child.stdin || child.stdin.destroyed) return false
    try {
      child.stdin.write(`${line}\n`, (error) => { if (error) this.writeError(error) })
      return true
    } catch (error) {
      this.writeError(error as Error)
      return false
    }
  }

  onLine(cb: (line: string) => void): () => void {
    this.lines.add(cb)
    return () => { this.lines.delete(cb) }
  }

  /** Receives the current bounded tail, not an unbounded stream accumulation. */
  onStderr(cb: (tail: string) => void): () => void {
    this.diagnostics.add(cb)
    if (this.stderr.length) cb(this.stderrTail())
    return () => { this.diagnostics.delete(cb) }
  }

  onExit(cb: (result: AgentProcessExit) => void): () => void {
    if (this.exit) cb(this.exit)
    else this.exits.add(cb)
    return () => { this.exits.delete(cb) }
  }

  stop(options: { force?: boolean } = {}): Promise<void> {
    // Escalate even when a graceful stop is already pending; never look up an ended PID again.
    if (options.force && !this.ended) void this.killTree()
    this.stopping ??= this.shutdown()
    return this.stopping
  }
}

/** Main-only transport. Consumers must mask diagnostics before persistence or IPC. */
export function startAgentProcess(spec: ProcessSpec, spawn: Spawn = spawnChild): AgentProcess {
  const owned = process.platform === 'win32' ? windowsAgentJob(spec.file, spec.args) : undefined
  const program = owned ?? spec
  return new JsonlProcess(spawn(program.file, program.args, {
    cwd: spec.cwd, env: spec.env, stdio: 'pipe', windowsHide: true, detached: startsOwnGroup()
  }), owned?.stdin)
}
