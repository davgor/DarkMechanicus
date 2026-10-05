/**
 * Running the user's `claude` executable for the Claude adapter: finding the program behind a
 * Windows shim, starting it for the Agent SDK in a way that lets the whole process tree be killed,
 * and the input stream a long-lived query reads its messages from.
 *
 * Process trees. The SDK's own close only reaches the program it started (on Windows
 * `TerminateProcess` leaves what that program started running). The SDK lets the host start the
 * process, so this module does, remembers every child, and kills the tree: `taskkill /t` on Windows
 * (through the shared `killTree`), the child's own process group on macOS and Linux, where it is
 * started detached to get one.
 */
import { spawn as nodeSpawn, type ChildProcessByStdio } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { win32 } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { killTree } from '../../desktop/agentProbeNode'

/** How much of the program's stderr is kept to explain a failure with. */
const STDERR_CHARS = 2000

type PipedChild = ChildProcessByStdio<Writable, Readable, Readable>

interface PipedSpawnOptions {
  cwd: string | undefined
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  detached: boolean
  windowsHide: true
}

export interface ProcessDeps {
  platform: string
  spawn: (command: string, args: string[], options: PipedSpawnOptions) => PipedChild
  /** Kills a child and, on Windows, everything it started (`taskkill /t`). */
  killTree: (child: PipedChild) => void
  /** Kills a whole POSIX process group by the pid of its leader. */
  killGroup: (pid: number) => void
}

/** The processes a chat started, for the SDK to run and for the adapter to kill. */
export interface ClaudeProcesses {
  /** For the SDK's `spawnClaudeCodeProcess` option. */
  spawn: (options: SpawnOptions) => SpawnedProcess
  /** Kills every live process this started, with everything they started. */
  killAll: () => void
  /** The end of what those processes printed on stderr. */
  stderrTail: () => string
}

const realDeps: ProcessDeps = {
  platform: process.platform,
  spawn: (command, args, options) => nodeSpawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }),
  killTree,
  killGroup: (pid) => {
    process.kill(-pid, 'SIGKILL')
  }
}

function isLive(child: PipedChild): boolean {
  return child.exitCode === null && child.signalCode === null
}

function killOne(child: PipedChild, deps: ProcessDeps): void {
  if (!isLive(child)) {
    return
  }
  if (deps.platform === 'win32' || child.pid === undefined) {
    deps.killTree(child)
    return
  }
  try {
    deps.killGroup(child.pid)
  } catch {
    // The group is already gone (or never formed); make sure the child itself is.
    deps.killTree(child)
  }
}

export function createClaudeProcesses(overrides: Partial<ProcessDeps> = {}): ClaudeProcesses {
  const deps: ProcessDeps = { ...realDeps, ...overrides }
  const children = new Set<PipedChild>()
  let stderr = ''
  return {
    spawn: (options) => {
      const child = deps.spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        // A POSIX group of its own is what lets killAll reach what the program started.
        detached: deps.platform !== 'win32',
        windowsHide: true
      })
      if (child.stdin === null || child.stdout === null || child.stderr === null) {
        throw new Error('The Claude Code process started without its pipes.')
      }
      // Always drained: an undrained stderr pipe would stall the program once it fills.
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr = `${stderr}${String(chunk)}`.slice(-STDERR_CHARS)
      })
      children.add(child)
      child.once('exit', () => children.delete(child))
      return child
    },
    killAll: () => {
      for (const child of children) {
        killOne(child, deps)
      }
    },
    stderrTail: () => stderr
  }
}

// ---- Finding the program ----

const SHIM_EXTENSION = /\.(?:cmd|bat)$/i
/** What an npm `.cmd` shim runs: a quoted path under `%dp0%`, the folder holding the shim. */
const SHIM_TARGET = /"%dp0%\\([^"]+\.(?:js|exe))"/gi
const SHIM_HELP =
  'Dark Mechanicus cannot launch Claude Code through that .cmd shim. Connect claude.exe instead (the native installer puts it in %USERPROFILE%\\.local\\bin).'

/**
 * The program to hand the SDK. Node cannot start `.cmd` shims without a shell, and a shell would
 * have to quote the SDK's arguments (JSON, a model name) for cmd.exe, which cannot be done safely.
 * So an npm shim is followed to the script or program it runs; one that cannot be followed is
 * refused with what to connect instead.
 */
export function resolveClaudeExecutable(path: string, platform: string, readFile: (path: string) => string = readShimFile): string {
  if (platform !== 'win32' || !SHIM_EXTENSION.test(path)) {
    return path
  }
  let text: string
  try {
    text = readFile(path)
  } catch {
    throw new Error(SHIM_HELP)
  }
  const target = [...text.matchAll(SHIM_TARGET)].at(-1)?.[1]
  if (target === undefined) {
    throw new Error(SHIM_HELP)
  }
  return win32.join(win32.dirname(path), target)
}

export function readShimFile(path: string): string {
  return readFileSync(path, 'utf8')
}

// ---- The input stream ----

export interface InputQueue<T> {
  iterable: AsyncIterable<T>
  push: (item: T) => void
  /** Ends the stream once what was queued has been read. */
  close: () => void
}

/** An async stream the adapter writes to and the SDK reads from, so one process carries many turns. */
export function createInputQueue<T>(): InputQueue<T> {
  const buffer: T[] = []
  let waiting: ((result: IteratorResult<T>) => void) | null = null
  let closed = false
  const finished = (): IteratorResult<T> => ({ value: undefined, done: true })
  return {
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift() as T, done: false })
          }
          if (closed) {
            return Promise.resolve(finished())
          }
          return new Promise((resolve) => {
            waiting = resolve
          })
        },
        return: () => {
          closed = true
          return Promise.resolve(finished())
        }
      })
    },
    push: (item) => {
      if (closed) {
        return
      }
      if (waiting === null) {
        buffer.push(item)
        return
      }
      const resolve = waiting
      waiting = null
      resolve({ value: item, done: false })
    },
    close: () => {
      closed = true
      const resolve = waiting
      waiting = null
      resolve?.(finished())
    }
  }
}
