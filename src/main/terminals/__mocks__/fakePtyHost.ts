/**
 * Test double for `PtyHost`: records each spawn and gives the test a handle that plays the program in
 * the PTY (its output and its exit) and shows what was sent to it (input, sizes, kills). Not shipped.
 */
import type { PtyDisposer, PtyExit, PtyHost, PtyProcess, PtySpawnSpec } from '../ptyHost'

let nextPid = 40_000

/** A program running in a fake PTY; the test drives its side. */
export class FakePty implements PtyProcess {
  readonly pid = (nextPid += 1)
  /** Everything written to the PTY, in order. */
  readonly written: string[] = []
  /** Every resize, in order. */
  readonly sizes: [number, number][] = []
  /** How many times node-pty's own kill was called. */
  kills = 0
  /** Whether the test has ended the program. */
  exited = false
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(exit: PtyExit) => void>()

  constructor(readonly spec: PtySpawnSpec) {}

  write(data: string): void {
    this.written.push(data)
  }

  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows])
  }

  kill(): void {
    this.kills += 1
  }

  onData(listener: (data: string) => void): PtyDisposer {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onExit(listener: (exit: PtyExit) => void): PtyDisposer {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /** The program prints `data`. */
  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data)
    }
  }

  /** The program ends. */
  exit(exit: PtyExit = { exitCode: 0, signal: null }): void {
    this.exited = true
    for (const listener of this.exitListeners) {
      listener(exit)
    }
  }
}

export class FakePtyHost implements PtyHost {
  /** Every PTY started, oldest first. */
  readonly spawns: FakePty[] = []
  private spawnError: Error | null = null

  spawn(spec: PtySpawnSpec): FakePty {
    const error = this.spawnError
    if (error !== null) {
      this.spawnError = null
      throw error
    }
    const pty = new FakePty(spec)
    this.spawns.push(pty)
    return pty
  }

  /** Makes the next spawn throw `error`, as node-pty does when the program cannot be started. */
  failNextSpawn(error: Error): void {
    this.spawnError = error
  }

  /** The PTY started last. */
  last(): FakePty {
    const pty = this.spawns.at(-1)
    if (pty === undefined) {
      throw new Error('No PTY has been started.')
    }
    return pty
  }
}
