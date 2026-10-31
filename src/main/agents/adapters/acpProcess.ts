/**
 * The Node side of an ACP agent: starts the process with pipes on all three streams (no shell, no
 * inheritance of the app's own stdin), splits its output into lines for the connection, keeps the
 * tail of its stderr to say why it ended, and ends the whole process tree on `kill`.
 *
 * Tree kill. `kill` goes through the shared `killProcessTree`: on Windows `taskkill /t /f`, which also
 * ends what a `.cmd` shim started; elsewhere the agent is started as its own process group
 * (`startsOwnGroup`) and the group is killed, so a shell wrapper's children do not outlive it. What the
 * agent leaves running in its group when it exits on its own is ended as it exits, and a `kill` after
 * that waits for the same kill. It resolves once the tree is gone or `killProcessTree`'s wait has passed;
 * a tree still alive then is not killed again, only logged with its process id. Tests run it against
 * Node itself.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { logger } from '../../logger'
import { killProcessTree, startsOwnGroup } from '../processTree'
import type { TransportFactory, TransportHandle, TransportSink } from './acpClient'

interface EndTreeDeps {
  killProcessTree: (child: ChildProcess) => Promise<boolean>
  warn: (message: string) => void
}

const realEndTreeDeps: EndTreeDeps = {
  killProcessTree: (child) => killProcessTree(child),
  warn: (message) => {
    logger.warn(message)
  }
}

/** Ends `child`'s tree once, and logs one line naming its process id if the tree outlived the wait. */
export async function endAgentTree(child: ChildProcess, deps: EndTreeDeps = realEndTreeDeps): Promise<void> {
  if (!(await deps.killProcessTree(child))) {
    deps.warn(`agent process ${child.pid ?? 'unknown'}: its process tree was still alive after the kill wait`)
  }
}

/** What is kept of stderr to explain an exit. */
const STDERR_TAIL_CHARS = 500

const NOTHING: TransportHandle = {
  write: () => {},
  kill: () => Promise.resolve()
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
export const nodeTransport: TransportFactory = (launch, cwd, sink, env = {}) => {
  let child: ChildProcess
  try {
    child = spawn(launch.file, [...launch.args], {
      cwd,
      // The chat's grant travels here, so the `dm` the agent runs is the one it was authorized for.
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatimArguments,
      detached: startsOwnGroup(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    queueMicrotask(() => {
      sink.closed(failureText(error))
    })
    return NOTHING
  }
  wire(child, sink)
  // Asked as it exits, while its process group's id can only be its own (see `killProcessTree`).
  child.once('exit', () => {
    void killProcessTree(child)
  })
  return {
    write(line) {
      if (child.stdin?.writable === true) {
        child.stdin.write(`${line}\n`)
      }
    },
    async kill() {
      await endAgentTree(child)
    }
  }
}
