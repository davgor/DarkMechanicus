import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { killPtyTree, type PtyTree } from '../agents/processTree'
import { createNodePtyHost, type PtyExit, type PtyProcess } from './ptyHost'

/**
 * Runs the fixture agent CLI in a real PTY through the node-pty host, on macOS only: Linux has no
 * node-pty prebuild, and a live PTY on Windows (ConPTY, taskkill) is verified by the Windows ticket.
 * The tests wait on the fixture's own output (it writes each report to its log before printing it),
 * never on timers.
 */
vi.setConfig({ testTimeout: 60_000 })

const FIXTURE = join(import.meta.dirname, '__fixtures__', 'agentFixture.mjs')
const ARGV = ['--model', 'haiku', 'two words', 'ünïcödé', '--background-child']

interface FixtureEvent {
  event: string
  [key: string]: unknown
}

/** Folders and pids this file made, so a failed assertion leaves nothing behind. */
const scratch: string[] = []
const started: number[] = []

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone, which is what the tests want.
    }
  }
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A scratch folder made under `/tmp`, by its canonical path (`/private/tmp/…`), as a PTY's cwd must be. */
function scratchFolder(): string {
  const dir = realpathSync.native(mkdtempSync(join('/tmp', 'dm-pty-')))
  scratch.push(dir)
  return dir
}

function readLog(dir: string): FixtureEvent[] {
  return readFileSync(join(dir, 'agent-fixture.log'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as FixtureEvent)
}

/** Resolves once the PTY's output (line breaks removed, as the terminal may wrap) contains `needle`. */
function outputContains(child: PtyProcess, needle: string): Promise<void> {
  let seen = ''
  return new Promise((resolve) => {
    const stop = child.onData((chunk) => {
      seen += chunk.replace(/[\r\n]/g, '')
      if (seen.includes(needle)) {
        stop()
        resolve()
      }
    })
  })
}

/** The PTY as the tree kill needs it, plus its exit result. */
interface TrackedPty extends PtyTree {
  exit: Promise<PtyExit>
}

/** The PTY as the tree kill needs it, with its exit tracked from the start. */
function asTree(child: PtyProcess): TrackedPty {
  let exited = false
  const exit = new Promise<PtyExit>((resolve) => {
    child.onExit((result) => {
      exited = true
      resolve(result)
    })
  })
  return { pid: child.pid, kill: () => child.kill(), exited: exit, exit, hasExited: () => exited }
}

/** Every process that is in process group `pgid`, from `ps`. */
function groupMembers(pgid: number): number[] {
  return execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, group]) => group === pgid)
    .map(([pid]) => pid as number)
}

/** Starts the fixture in a PTY in a fresh scratch folder and waits until it is reading input. */
async function startFixture(): Promise<{ dir: string; child: PtyProcess; tree: TrackedPty; grandchild: number }> {
  const dir = scratchFolder()
  const host = await createNodePtyHost()
  const child = host.spawn({
    file: process.execPath,
    args: [FIXTURE, ...ARGV],
    cwd: dir,
    env: { PATH: process.env['PATH'] ?? '', DM_SESSION_TOKEN: 'dm_grant_for_test' },
    cols: 100,
    rows: 30
  })
  started.push(child.pid)
  const tree = asTree(child)
  await outputContains(child, '"event":"ready"')
  const spawned = readLog(dir).find((event) => event.event === 'background-child')
  const grandchild = spawned?.['pid'] as number
  started.push(grandchild)
  return { dir, child, tree, grandchild }
}

describe.runIf(process.platform === 'darwin')('the node-pty host running the fixture agent CLI', () => {
  it('starts it in the canonical folder with the grant variable and the exact argv, echoes input and reports a resize', async () => {
    const { dir, child, tree } = await startFixture()

    const echoed = outputContains(child, '"data":"hello"')
    child.write('hello')
    await echoed
    const resized = outputContains(child, '"cols":132,"rows":43}')
    child.resize(132, 43)
    await resized

    const log = readLog(dir)
    expect(log[0]).toEqual({
      event: 'start',
      pid: child.pid,
      cwd: dir,
      sessionToken: true,
      argv: ARGV,
      cols: 100,
      rows: 30
    })
    expect(log[0]?.['cwd']).toMatch(/^\/private\/tmp\/dm-pty-/)
    expect(log.filter((event) => event.event === 'input').map((event) => event['data'])).toEqual(['hello'])
    expect(log.at(-1)).toEqual({ event: 'sigwinch', cols: 132, rows: 43 })
    expect(await killPtyTree(tree)).toBe(true)
  })
})

describe.runIf(process.platform === 'darwin')('the tree kill on the fixture agent CLI in a real PTY', () => {
  it('is ended with everything in its tree by the tree kill, including a backgrounded grandchild', async () => {
    const { child, tree, grandchild } = await startFixture()
    expect(grandchild).toBeGreaterThan(0)
    // forkpty made the fixture a process group leader; its grandchild is in that group.
    expect(groupMembers(child.pid).sort()).toEqual([child.pid, grandchild].sort())

    expect(await killPtyTree(tree)).toBe(true)

    // No waiting: the kill resolved only once the exit was reported and the group was empty.
    expect(groupMembers(child.pid)).toEqual([])
  })

  it('ends the grandchild a fixture left running when it exited, from the group it led', async () => {
    const { child, tree, grandchild } = await startFixture()

    child.write('\u0003')
    expect((await tree.exit).exitCode).toBe(130)
    expect(groupMembers(child.pid)).toEqual([grandchild])

    // Asked right after the exit is reported, as a session would from its exit listener.
    expect(await killPtyTree(tree)).toBe(true)

    expect(groupMembers(child.pid)).toEqual([])
  })
})
