import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { killProcessTree, startsOwnGroup } from './processTree'

/**
 * These tests start and kill real processes, on whatever platform runs them (taskkill on Windows,
 * a process group elsewhere). They wait on process events, never on timers: the child's `exit`, and
 * the close of the pipe the grandchild inherited, which only happens once every process that held it
 * has ended.
 */
vi.setConfig({ testTimeout: 60_000 })

/** A parent that starts a grandchild sharing its stdout pipe, prints the grandchild's pid, and idles. */
const PARENT = `
const { spawn } = require('node:child_process')
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] })
console.log(grandchild.pid)
setInterval(() => {}, 1000)
`

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

interface Tree {
  child: ChildProcess
  childPid: number
  grandchildPid: number
}

/** Pids this test started, so a failed assertion cannot leave them running. */
const started: number[] = []

async function startTree(): Promise<Tree> {
  const child = spawn(process.execPath, ['-e', PARENT], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: startsOwnGroup(),
    windowsHide: true
  })
  const childPid = child.pid as number
  started.push(childPid)
  const [chunk] = (await once(child.stdout as NonNullable<ChildProcess['stdout']>, 'data')) as [Buffer]
  const grandchildPid = Number(String(chunk).trim())
  started.push(grandchildPid)
  return { child, childPid, grandchildPid }
}

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid)
    } catch {
      // Already gone, which is what the tests want.
    }
  }
})

describe('killProcessTree with a real process tree', () => {
  it('resolves only after the process and the process it started have exited', async () => {
    const { child, childPid, grandchildPid } = await startTree()
    expect(alive(childPid)).toBe(true)
    expect(alive(grandchildPid)).toBe(true)
    const pipeClosed = once(child.stdout as NonNullable<ChildProcess['stdout']>, 'close')

    const gone = await killProcessTree(child)

    expect(gone).toBe(true)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    // No waiting: the helper has already waited.
    expect(alive(grandchildPid)).toBe(false)
    expect(alive(childPid)).toBe(false)
    // The pipe the grandchild held is closed too (an event, so this only waits if the grandchild is still running).
    await pipeClosed
  })

  it('has nothing to do for a process that already exited', async () => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', detached: startsOwnGroup(), windowsHide: true })
    await once(child, 'exit')

    expect(await killProcessTree(child)).toBe(true)
  })

  it('can be asked twice while the first request is still running', async () => {
    const { child, grandchildPid } = await startTree()

    const results = await Promise.all([killProcessTree(child), killProcessTree(child)])

    expect(results).toEqual([true, true])
    expect(alive(grandchildPid)).toBe(false)
  })
})
