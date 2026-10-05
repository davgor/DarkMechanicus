/**
 * The Node side of an ACP agent: starts the process with pipes on all three streams (no shell, no
 * inheritance of the app's own stdin), splits its output into lines for the connection, keeps the
 * tail of its stderr to say why it ended, and ends the whole process tree on `kill`.
 *
 * Tree kill. On Windows `killTree` runs `taskkill /t /f`, which also ends what a `.cmd` shim started.
 * Elsewhere the agent is started as its own process group and the group is killed, so a shell
 * wrapper's children do not outlive it. Tests run it against Node itself.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { killTree } from '../../desktop/agentProbeNode'
import type { TransportFactory, TransportHandle, TransportSink } from './acpClient'

/** What is kept of stderr to explain an exit. */
const STDERR_TAIL_CHARS = 500

const NOTHING: TransportHandle = {
  write: () => {},
  kill: () => {}
}

function killProcessTree(child: ChildProcess): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // The group is already gone, or was never made; the direct kill below covers it.
    }
  }
  killTree(child)
}

function failureText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  return typeof code === 'string' ? `could not be started (${code}): ${message}` : `could not be started: ${message}`
}

/**
 * Splits a stream of text into lines (`\n` or `\r\n`) and drops the empty ones; the unfinished last
 * line waits for more text or for the end.
 */
function lineSplitter(deliver: (line: string) => void): { push(chunk: string): void; end(): void } {
  const onLine = (line: string): void => {
    const text = line.replace(/\r$/, '')
    if (text !== '') {
      deliver(text)
    }
  }
  let pending = ''
  return {
    push(chunk) {
      const lines = (pending + chunk).split('\n')
      pending = lines.pop() ?? ''
      lines.forEach(onLine)
    },
    end() {
      onLine(pending)
      pending = ''
    }
  }
}

function wire(child: ChildProcess, sink: TransportSink): void {
  let closed = false
  let stderrTail = ''
  const close = (how: string): void => {
    if (!closed) {
      closed = true
      const tail = stderrTail.trim()
      sink.closed(tail === '' ? how : `${how}: ${tail}`)
    }
  }
  const lines = lineSplitter((line) => {
    sink.line(line)
  })
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    lines.push(chunk)
  })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
  })
  child.stdin?.on('error', () => {})
  child.on('error', (error) => {
    close(failureText(error))
  })
  child.on('close', (code, signal) => {
    lines.end()
    close(signal === null ? `exit code ${code ?? -1}` : `signal ${signal}`)
  })
}

/** Starts `launch` in `cwd` and reports its lines and its end to `sink`. */
export const nodeTransport: TransportFactory = (launch, cwd, sink) => {
  let child: ChildProcess
  try {
    child = spawn(launch.file, [...launch.args], {
      cwd,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatimArguments,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    queueMicrotask(() => {
      sink.closed(failureText(error))
    })
    return NOTHING
  }
  wire(child, sink)
  return {
    write(line) {
      if (child.stdin?.writable === true) {
        child.stdin.write(`${line}\n`)
      }
    },
    kill() {
      killProcessTree(child)
    }
  }
}
