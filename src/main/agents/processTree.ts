/**
 * The one place that ends an agent's whole process tree, and says when it is gone.
 *
 * An agent is a program that starts other programs (a Windows `.cmd` shim starts Node, Node starts
 * tools), so ending only the process this app started leaves the rest running. `killProcessTree`
 * ends the whole tree and resolves once it is gone:
 * - Windows: `taskkill /pid <pid> /t /f` finds the tree through each process's parent. It is awaited:
 *   the promise settles after taskkill has finished and the child has exited.
 * - macOS and Linux: SIGKILL goes to the child's own process group, which exists when the child was
 *   started with `detached: startsOwnGroup()`. The group is then checked until no member is left.
 *
 * Callers keep their own bookkeeping; this only kills. A child that already ended is left alone: its
 * pid may by now belong to something else.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { win32 } from 'node:path'

/** How long a kill waits for the tree to be gone before it reports that it is not. */
const WAIT_MS = 5_000
/** How often the process group is checked for members, and how many checks that is at most (one second). */
const GROUP_POLL_MS = 10
const MAX_GROUP_POLLS = 100
/** What taskkill exits with when there is no such process (it has already ended). */
const TASKKILL_NO_SUCH_PROCESS = 128

/** Everything the helper does to the system, so tests can drive each platform without a real tree. */
interface TreeKillDeps {
  platform: string
  /** `taskkill /pid <pid> /t /f`; its exit code, or null when it could not be started or was itself killed. */
  taskkill: (pid: number) => Promise<number | null>
  /** `process.kill` for a whole group: a signal name, or 0 to ask whether any member is left. Throws when none is. */
  signalGroup: (pgid: number, signal: 'SIGKILL' | 0) => void
  sleep: (ms: number) => Promise<void>
  /** The longest the whole kill waits. */
  waitMs: number
}

/**
 * Whether a child must be started as the leader of its own process group (`detached`) for
 * `killProcessTree` to reach what it starts. Windows has no groups and finds the tree through parents.
 */
export function startsOwnGroup(platform: string = process.platform): boolean {
  return platform !== 'win32'
}

/** Taskkill by its full path, so a program placed in the working folder can never stand in for it. */
function taskkillPath(): string {
  return win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe')
}

function runTaskkill(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    const killer = spawn(taskkillPath(), ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    killer.once('error', () => {
      resolve(null)
    })
    killer.once('exit', (code) => {
      resolve(code)
    })
  })
}

function realDeps(): TreeKillDeps {
  return {
    platform: process.platform,
    taskkill: runTaskkill,
    signalGroup: (pgid, signal) => {
      process.kill(-pgid, signal)
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    waitMs: WAIT_MS
  }
}

function hasEnded(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/** Settles when the child exits, or when it failed to start (which reports an error and no exit). */
function whenEnded(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => {
      resolve()
    })
    child.once('error', () => {
      resolve()
    })
  })
}

/** Whether the process group still has a member (a member that has ended but is not yet collected counts). */
function groupHasMembers(pgid: number, deps: TreeKillDeps): boolean {
  try {
    deps.signalGroup(pgid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForGroupToEmpty(pgid: number, deps: TreeKillDeps): Promise<boolean> {
  for (let polls = 0; polls < MAX_GROUP_POLLS; polls += 1) {
    if (!groupHasMembers(pgid, deps)) {
      return true
    }
    await deps.sleep(GROUP_POLL_MS)
  }
  return false
}

/** Resolves true when the whole tree was ended, false when only the child could be (taskkill failed). */
async function endWindowsTree(child: ChildProcess, pid: number, deps: TreeKillDeps): Promise<boolean> {
  const code = await deps.taskkill(pid)
  if (code === 0 || code === TASKKILL_NO_SUCH_PROCESS) {
    return true
  }
  // Taskkill is missing or refused: end the program itself, which is all that can be reached.
  child.kill('SIGKILL')
  return false
}

/** Resolves true when the group is empty, false when there was no group to signal or it did not empty. */
async function endGroup(child: ChildProcess, pid: number, deps: TreeKillDeps): Promise<boolean> {
  try {
    deps.signalGroup(pid, 'SIGKILL')
  } catch {
    // There is no group of its own (the child was not started as a leader): end the program itself.
    child.kill('SIGKILL')
    return false
  }
  return waitForGroupToEmpty(pid, deps)
}

/** Issues the kill at once (before any await) and resolves when what it can know about the tree is settled. */
function endTree(child: ChildProcess, deps: TreeKillDeps): Promise<boolean> {
  const { pid } = child
  if (pid === undefined) {
    child.kill('SIGKILL')
    return Promise.resolve(true)
  }
  return deps.platform === 'win32' ? endWindowsTree(child, pid, deps) : endGroup(child, pid, deps)
}

/** `work`'s result, or null once `ms` have passed; the timer never keeps the process alive and never outlives the work. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null)
    }, ms)
    timer.unref()
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}

async function stopTree(child: ChildProcess, overrides: Partial<TreeKillDeps>): Promise<boolean> {
  const deps: TreeKillDeps = { ...realDeps(), ...overrides }
  if (hasEnded(child)) {
    return true
  }
  const ended = whenEnded(child)
  const reached = endTree(child, deps)
  const settled = await within(Promise.all([ended, reached]), deps.waitMs)
  return settled !== null && settled[1]
}

/** The kill that is running for each child. Two taskkills racing over one tree can fail each other. */
const running = new WeakMap<ChildProcess, Promise<boolean>>()

/**
 * Ends `child` and everything it started, and resolves with whether that tree is gone: true once the
 * child has exited and nothing could be found of what it started, false when the limit passed first or
 * the tree could not be reached (taskkill failed, or there was no process group to signal). The kill is
 * sent before this returns. Asking again while a kill is running shares it (the later call's overrides
 * are ignored); asking after it settled starts a new one.
 */
export function killProcessTree(child: ChildProcess, overrides: Partial<TreeKillDeps> = {}): Promise<boolean> {
  const shared = running.get(child)
  if (shared !== undefined) {
    return shared
  }
  const kill = stopTree(child, overrides)
  running.set(child, kill)
  const forget = (): void => {
    running.delete(child)
  }
  kill.then(forget, forget)
  return kill
}
