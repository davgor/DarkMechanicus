/**
 * The pseudo-terminal behind every chat terminal, and the only module that loads `node-pty`.
 *
 * Everything else starts and drives PTYs through `PtyHost`, so tests use the fake in
 * `__mocks__/fakePtyHost.ts` and only `ptyHost.real.test.ts` runs a real one. node-pty is loaded when
 * the host is created, not when this module is imported: its native binary has no Linux prebuild, and
 * a module that only needs these types must still load there.
 *
 * Ending a PTY's whole process tree is `killPtyTree` (`../agents/processTree`); `PtyProcess.kill` is
 * node-pty's own kill (SIGHUP on macOS and Linux, closing the pseudo-console on Windows).
 */
import { assertPtyHelperExecutable, installedPtyHelperPath, type HelperStat } from './ptyHelperCheck'

/** What to run in a PTY. */
export interface PtySpawnSpec {
  /** The program, by absolute path. */
  file: string
  /**
   * Its arguments: an argv, or on Windows only a pre-escaped command line (node-pty's string form),
   * which the caller has quoted itself and node-pty passes through untouched.
   */
  args: readonly string[] | string
  /** The working folder, canonical. */
  cwd: string
  /** The whole environment of the program (nothing is inherited). */
  env: Readonly<Record<string, string>>
  cols: number
  rows: number
}

/** How a PTY's program ended: its exit code, and the signal that ended it, when one did. */
export interface PtyExit {
  exitCode: number
  signal: number | null
}

/** Stops a listener; calling it again does nothing. */
export type PtyDisposer = () => void

/** A program running in a PTY. */
export interface PtyProcess {
  /** The program's pid; on macOS and Linux also its process group's id (forkpty makes it a leader). */
  readonly pid: number
  /** Sends input, as typed. */
  write(data: string): void
  resize(cols: number, rows: number): void
  /** node-pty's own kill: the program only, not what it started (see `killPtyTree`). */
  kill(): void
  onData(listener: (data: string) => void): PtyDisposer
  onExit(listener: (exit: PtyExit) => void): PtyDisposer
}

export interface PtyHost {
  /** Starts `spec` in a new PTY; throws when the program cannot be started. */
  spawn(spec: PtySpawnSpec): PtyProcess
}

interface NodePtyDisposable {
  dispose(): void
}

/** The part of node-pty this host uses, so a test can stand in for the native module. */
export interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: { name: string; cwd: string; env: Record<string, string>; cols: number; rows: number; useConptyDll?: boolean }
  ): {
    readonly pid: number
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(): void
    onData(listener: (data: string) => void): NodePtyDisposable
    onExit(listener: (exit: { exitCode: number; signal?: number }) => void): NodePtyDisposable
  }
}

export interface NodePtyHostOptions {
  platform?: string
  /** Loads node-pty; a test seam for the platform-specific options. */
  load?: () => Promise<NodePtyModule>
  /** The macOS helper to check before node-pty is loaded; node-pty's own by default. */
  helperPath?: string
  /** Reads the helper's mode; a test seam for platforms whose files have no POSIX modes. */
  statHelper?: HelperStat
}

/** The terminal type the renderer's xterm.js emulates. */
const TERMINAL_NAME = 'xterm-256color'

/**
 * The node-pty host. Rejects when node-pty cannot be loaded (no prebuild for this platform), or on macOS
 * when its `spawn-helper` is not executable (`assertPtyHelperExecutable`), so a caller can refuse
 * terminals with that error instead of failing at the first spawn. On Windows it runs the ConPTY
 * node-pty ships (`useConptyDll`), so every Windows version runs the same pseudo-console.
 */
export async function createNodePtyHost(options: NodePtyHostOptions = {}): Promise<PtyHost> {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin') {
    assertPtyHelperExecutable(options.helperPath ?? installedPtyHelperPath(), { platform, stat: options.statHelper })
  }
  const pty = await (options.load ?? (() => import('node-pty')))()
  const windows = platform === 'win32'
  return {
    spawn(spec) {
      if (typeof spec.args === 'string' && !windows) {
        throw new TypeError('A pre-escaped command line is only for Windows; pass an argv instead.')
      }
      const child = pty.spawn(spec.file, typeof spec.args === 'string' ? spec.args : [...spec.args], {
        name: TERMINAL_NAME,
        cwd: spec.cwd,
        env: { ...spec.env },
        cols: spec.cols,
        rows: spec.rows,
        ...(windows ? { useConptyDll: true } : {})
      })
      return {
        pid: child.pid,
        write: (data) => child.write(data),
        resize: (cols, rows) => child.resize(cols, rows),
        kill: () => child.kill(),
        onData(listener) {
          const subscription = child.onData(listener)
          return () => subscription.dispose()
        },
        onExit(listener) {
          const subscription = child.onExit(({ exitCode, signal }) => listener({ exitCode, signal: signal ?? null }))
          return () => subscription.dispose()
        }
      }
    }
  }
}
