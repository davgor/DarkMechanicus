/**
 * The process side of the Codex adapter: starts `codex app-server` in the chat's folder and turns
 * its stdio into the line transport `codexRpc.ts` speaks over.
 *
 * Launching follows the same rules as every other agent run (`planCliLaunch`): no shell for a
 * user-chosen path, and a Windows `.cmd` shim goes through exactly one cmd.exe parse with the path
 * in one pair of quotes. The subcommand is a constant, never user text. Stopping uses `killTree`, so
 * the shim's child (Node, or the Codex binary) goes with it.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { planCliLaunch, type AgentProbeDeps, type LaunchPlan, type ProbeLaunch } from '../../desktop/agentProbe'
import { inspectExecutable, killTree } from '../../desktop/agentProbeNode'
import type { RpcTransport } from './codexRpc'

const SUBCOMMAND = 'app-server'
/** How long a stopped process may take to be gone before the stop is reported anyway. */
const KILL_WAIT_MS = 5_000
/** What is kept of the program's stderr, to say why it ended. */
const STDERR_KEEP = 600

interface LineSplitter {
  push(chunk: string): void
  /** Hands over a last line that has no newline. */
  flush(): void
}

/** Splits a text stream into lines: pieces are joined, `\r\n` is accepted, blank lines are skipped. */
export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  let rest = ''
  const emit = (line: string): void => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line
    if (text.trim() !== '') {
      onLine(text)
    }
  }
  return {
    push: (chunk) => {
      const lines = (rest + chunk).split('\n')
      rest = lines.pop() ?? ''
      lines.forEach(emit)
    },
    flush: () => {
      const last = rest
      rest = ''
      emit(last)
    }
  }
}

/** How to run `<executable> app-server`, or why it cannot be run. */
export function planCodexLaunch(executablePath: string, deps: Pick<AgentProbeDeps, 'platform' | 'inspect' | 'comspec'>): LaunchPlan {
  return planCliLaunch(executablePath, [SUBCOMMAND], deps)
}

function describeExit(code: number | null, signal: NodeJS.Signals | null, stderr: string, stopped: boolean): string {
  if (stopped) {
    return 'Codex was stopped.'
  }
  const how = code === null ? `was ended by ${signal ?? 'a signal'}` : `exited with code ${code}`
  const said = stderr.trim()
  return said === '' ? `Codex ${how}.` : `Codex ${how}: ${said}`
}

/** One running `codex app-server`: its stdout as lines, its stderr as the reason it ended. */
class CodexProcess implements RpcTransport {
  private lineListener: (line: string) => void = () => {}
  private closeListener: (reason: string) => void = () => {}
  private closedWith: string | null = null
  private stopped = false
  private stderr = ''
  private readonly lines = createLineSplitter((line) => {
    this.lineListener(line)
  })
  private readonly child: ChildProcess

  constructor(launch: ProbeLaunch, folder: string) {
    const child = spawn(launch.file, [...launch.args], {
      cwd: folder,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      this.lines.push(chunk)
    })
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP)
    })
    // A write to a program that already ended is reported by its close, not as a crash here.
    child.stdin?.on('error', () => {})
    child.on('error', (error) => {
      this.close(`Codex could not start: ${error.message}`)
    })
    child.on('close', (code, signal) => {
      this.close(describeExit(code, signal, this.stderr, this.stopped))
    })
  }

  write(line: string): void {
    if (this.closedWith === null) {
      this.child.stdin?.write(`${line}
`)
    }
  }

  onLine(listener: (line: string) => void): void {
    this.lineListener = listener
  }

  onClose(listener: (reason: string) => void): void {
    this.closeListener = listener
    if (this.closedWith !== null) {
      listener(this.closedWith)
    }
  }

  kill(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.closedWith !== null) {
        resolve()
        return
      }
      this.stopped = true
      const timer = setTimeout(resolve, KILL_WAIT_MS)
      this.child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      killTree(this.child)
    })
  }

  private close(reason: string): void {
    if (this.closedWith === null) {
      this.closedWith = reason
      this.lines.flush()
      this.closeListener(reason)
    }
  }
}

/**
 * Starts `codex app-server` for the folder. Throws when the executable cannot be launched safely;
 * a program that starts and then fails reports through `onClose`.
 */
export function spawnCodexTransport(executablePath: string, folder: string): RpcTransport {
  const plan = planCodexLaunch(executablePath, { platform: process.platform, inspect: inspectExecutable })
  if ('ok' in plan) {
    throw new Error(plan.reason)
  }
  return new CodexProcess(plan.launch, folder)
}
