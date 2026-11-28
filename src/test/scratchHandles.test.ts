import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { scratchDir } from './gitScratch'
import { createGitRepo } from './gitRepo'
import { removeScratch } from './removeScratch'
import { releaseScratch, settleAllScratch, settleScratch, trackChild, trackHandle } from './scratchHandles'
import { createHarness } from './workspaceHarness'

/** A Node process that runs until it is killed, with `cwd` as its working directory (which holds the folder on Windows). */
function idleChild(cwd: string): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { cwd, stdio: 'ignore' })
}

/** Resolves once `child` has exited. */
function exitOf(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) done()
    else child.once('exit', () => done())
  })
}

/** Whether `promise` settles before the event loop's next turn: nothing it awaits is a timer or another process. */
async function settlesAtOnce(promise: Promise<void>): Promise<boolean> {
  const nextTurn = new Promise<false>((done) => setImmediate(() => done(false)))
  return Promise.race([promise.then(() => true), nextTurn])
}

const spawned: ChildProcess[] = []
const folders: string[] = []

afterEach(async () => {
  for (const child of spawned.splice(0)) child.kill()
  await settleAllScratch().catch(() => undefined)
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function scratch(): string {
  const { path } = scratchDir('dm-scratch-')
  folders.push(path)
  return path
}

function child(cwd: string, name?: string): ChildProcess {
  const started = idleChild(cwd)
  spawned.push(started)
  return trackChild(started, cwd, name)
}

describe('scratch cleanup', () => {
  it('closes an open database and awaits a stopped child before the folder is removed, which then needs no retry', async () => {
    const folder = scratch()
    const db = new DatabaseSync(join(folder, 'held.db'))
    db.exec('CREATE TABLE t (x INTEGER)')
    trackHandle('held.db', [folder], () => db.close())
    const holder = child(folder, 'held-child')
    holder.kill()
    expect(holder.exitCode).toBeNull()

    await settleScratch(folder)

    expect(db.isOpen).toBe(false)
    expect(holder.exitCode !== null || holder.signalCode !== null).toBe(true)
    // No retries: on Windows a folder still held by the database or the child would fail with EPERM or EBUSY here.
    rmSync(folder, { recursive: true, force: true, maxRetries: 0 })
    expect(existsSync(folder)).toBe(false)
  })

  it('reports a child the test left running by name, at once, and kills it', async () => {
    const folder = scratch()
    const leaked = child(folder, 'leaky-child')

    expect(() => removeScratch(folder)).toThrow(/leaky-child \(pid \d+\) is still running in /)
    expect(leaked.killed).toBe(true)
    expect(existsSync(folder)).toBe(true)
    await exitOf(leaked)
  })

  it('reports a leaked child by name from the asynchronous cleanup too, after awaiting its exit', async () => {
    const folder = scratch()
    const leaked = child(folder, 'leaky-async-child')

    await expect(settleScratch(folder)).rejects.toThrow(/leaky-async-child \(pid \d+\) is still running in /)
    expect(leaked.exitCode !== null || leaked.signalCode !== null).toBe(true)
  })

  it('refuses a synchronous removal while a stopped child is still exiting, naming it', async () => {
    const folder = scratch()
    const exiting = child(folder, 'exiting-child')
    exiting.kill()

    expect(() => removeScratch(folder)).toThrow(/exiting-child \(pid \d+\) is still exiting in .*await settleScratch/)
    await settleScratch(folder)
    removeScratch(folder)
    expect(existsSync(folder)).toBe(false)
  })
})

describe('scratch cleanup of a clean folder, and at the end of a test file', () => {
  it('removes a clean folder without waiting', async () => {
    const folder = scratch()
    const elsewhere = scratch()
    const outside = child(elsewhere, 'outside-child')
    outside.kill()

    expect(await settlesAtOnce(settleScratch(folder))).toBe(true)
    removeScratch(folder)
    expect(existsSync(folder)).toBe(false)
    await settleScratch(elsewhere)
  })

  it('fails the end of a test file naming each child still running, after stopping and awaiting it', async () => {
    const folder = scratch()
    const leaked = child(folder, 'file-leak')
    let closed = false
    trackHandle('file-handle', [folder], () => {
      closed = true
    })

    await expect(settleAllScratch()).rejects.toThrow(/file-leak \(pid \d+\) is still running in a test file that has ended/)
    expect(closed).toBe(true)
    expect(leaked.exitCode !== null || leaked.signalCode !== null).toBe(true)
  })
})

describe('the shared scratch helpers', () => {
  it('close a harness workspace opened on a real repository when the repository is removed first', async () => {
    const harness = createHarness()
    const repo = createGitRepo()
    try {
      const workspace = harness.open('planner', { root: repo.root })
      await workspace.initializeRepository({ name: 'scratch-repo' })
      expect(() => workspace.ctx()).not.toThrow()

      repo.cleanup()

      expect(() => workspace.ctx()).toThrow()
      expect(existsSync(repo.root)).toBe(false)
    } finally {
      harness.cleanup()
    }
  })

  it('release a repository made at a caller root before removing it', () => {
    const folder = scratch()
    const repo = createGitRepo({ root: join(folder, 'repo') })
    let closed = false
    trackHandle('repo handle', [join(repo.root, '.git')], () => {
      closed = true
    })

    repo.cleanup()

    expect(closed).toBe(true)
    expect(existsSync(repo.root)).toBe(false)
  })

  it('fail a harness cleanup that would remove a folder a registered child still runs in', async () => {
    const harness = createHarness()
    const leaked = child(harness.root, 'harness-child')

    expect(() => harness.cleanup()).toThrow(/harness-child \(pid \d+\) is still running in /)
    await exitOf(leaked)
    harness.cleanup()
    expect(existsSync(harness.root)).toBe(false)
  })

  it('releases nothing outside the folder being removed', () => {
    const folder = scratch()
    const sibling = scratch()
    let closed = false
    trackHandle('sibling handle', [sibling], () => {
      closed = true
    })

    releaseScratch(folder)

    expect(closed).toBe(false)
    releaseScratch(sibling)
    expect(closed).toBe(true)
  })
})
