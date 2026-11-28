/**
 * What a test holds open inside its scratch folders: child processes and opened workspaces or databases. Windows
 * cannot remove a folder a running process or an open database file holds, and since Node 24.21 `rmSync` really
 * sleeps between its EPERM retries, so a forgotten holder turned into a 15 s hook timeout instead of a leaked
 * folder. Registered holders are released before their folder is removed (`removeScratch`), whatever order the
 * test's own cleanups run in, and a child the test left running fails the cleanup at once, by name. Not shipped.
 */
import type { ChildProcess } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'

interface TrackedChild {
  name: string
  folder: string
  child: ChildProcess
  /** Settles once the process has exited, or never started. */
  exited: Promise<void>
}

interface TrackedHandle {
  name: string
  folders: string[]
  close: () => void
}

const children = new Set<TrackedChild>()
const handles = new Set<TrackedHandle>()

function holds(folder: string, path: string): boolean {
  const rel = relative(resolve(folder), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

function label(entry: TrackedChild): string {
  return `${entry.name} (pid ${entry.child.pid ?? 'none'})`
}

/**
 * Registers `child`, running in (or holding) `folder`, until it exits. The test stops it before the folder is removed;
 * `settleScratch` then awaits its exit. `name` is how a leak is reported; it defaults to the command line.
 */
export function trackChild(child: ChildProcess, folder: string, name = child.spawnargs.join(' ')): ChildProcess {
  let done = (): void => undefined
  const exited = new Promise<void>((settle) => {
    done = settle
  })
  const entry: TrackedChild = { name, folder, child, exited }
  const finish = (): void => {
    children.delete(entry)
    done()
  }
  if (!running(child)) {
    finish()
    return child
  }
  children.add(entry)
  child.once('exit', finish)
  // Node may emit no 'exit' after a failed spawn; with no process there is nothing left to hold the folder.
  child.once('error', () => {
    if (child.pid === undefined) finish()
  })
  return child
}

/**
 * Registers something open inside `folders` (a workspace, a database) that `close` releases. Scratch removal closes it
 * first; the returned `close` closes it and drops the registration, for an owner that closes it itself.
 */
export function trackHandle(name: string, folders: readonly string[], close: () => void): { close(): void } {
  const entry: TrackedHandle = { name, folders: [...folders], close }
  handles.add(entry)
  return {
    close: () => {
      handles.delete(entry)
      close()
    }
  }
}

function closeHandlesIn(folder: string): void {
  for (const entry of handles) {
    if (entry.folders.some((held) => holds(folder, held))) {
      handles.delete(entry)
      entry.close()
    }
  }
}

function childrenIn(folder: string): TrackedChild[] {
  return [...children].filter((entry) => holds(folder, entry.folder))
}

/** Kills each child the test left running and names it: a leak fails the cleanup instead of holding the folder. */
function stopLeaks(entries: TrackedChild[], where: string): string[] {
  const leaks = entries.filter((entry) => !entry.child.killed && running(entry.child))
  for (const entry of leaks) entry.child.kill()
  return leaks.map((entry) => `${label(entry)} is still running in ${where}`)
}

function fail(problems: string[]): void {
  if (problems.length > 0) {
    throw new Error(`scratch cleanup: ${problems.join('; ')}`)
  }
}

/**
 * Releases what holds `folder`, synchronously: closes every registered handle inside it, and fails naming every
 * registered child still in it (one left running is killed). A child the test stopped but that has not exited yet
 * needs `settleScratch` first: a synchronous cleanup cannot wait for it.
 */
export function releaseScratch(folder: string): void {
  closeHandlesIn(folder)
  const held = childrenIn(folder)
  const exiting = held.filter((entry) => entry.child.killed && running(entry.child))
  fail([
    ...stopLeaks(held, folder),
    ...exiting.map((entry) => `${label(entry)} is still exiting in ${folder}: await settleScratch before removing it`)
  ])
}

/**
 * Closes every registered handle in `folder` and awaits the exit of every registered child in it. A child the test
 * left running is killed, awaited too, and then reported by name.
 */
export async function settleScratch(folder: string): Promise<void> {
  closeHandlesIn(folder)
  const held = childrenIn(folder)
  const leaks = stopLeaks(held, folder)
  await Promise.all(held.map((entry) => entry.exited))
  fail(leaks)
}

/**
 * For the end of a test file: kills and awaits every registered child still running, closes every registered handle,
 * and fails naming the children, so a leak is reported by the file that made it.
 */
export async function settleAllScratch(): Promise<void> {
  for (const entry of handles) {
    handles.delete(entry)
    entry.close()
  }
  const held = [...children]
  const leaks = stopLeaks(held, 'a test file that has ended')
  await Promise.all(held.map((entry) => entry.exited))
  fail(leaks)
}
