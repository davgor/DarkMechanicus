/**
 * Checks node-pty's macOS `spawn-helper` before any PTY starts.
 *
 * node-pty starts every program through that helper, and when it is not executable (node-pty 1.1.0's
 * tarball ships it `-rw-r--r--`; `scripts/ptyHelperMode.mjs` fixes it at install and packaging) every
 * spawn fails with only `posix_spawnp failed.`. This turns that into a message that names the file and
 * says what to do. Other platforms have no helper.
 */
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** The part of `fs.statSync` the check reads, so a test can report a mode on any platform. */
export type HelperStat = (path: string) => { mode: number; isFile(): boolean }

export interface PtyHelperCheckOptions {
  platform?: string
  stat?: HelperStat
}

const EXECUTE_BITS = 0o111

/** Throws the app's own message when `helperPath` is not an executable file; does nothing outside macOS. */
export function assertPtyHelperExecutable(helperPath: string, options: PtyHelperCheckOptions = {}): void {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return
  }
  let executable: boolean
  try {
    const stats = (options.stat ?? statSync)(helperPath)
    executable = stats.isFile() && (stats.mode & EXECUTE_BITS) !== 0
  } catch {
    executable = false
  }
  if (!executable) {
    throw new Error(`The terminal helper isn't executable: ${helperPath}. Reinstall Dark Mechanicus.`)
  }
}

/**
 * The helper node-pty at `packageDir` runs on `platform`/`arch`: its prebuild's `spawn-helper`, moved
 * from `app.asar` to `app.asar.unpacked` the way node-pty's `unixTerminal.js` moves it in a packaged app.
 */
export function ptyHelperPath(packageDir: string, platform: string, arch: string): string {
  return join(packageDir, 'prebuilds', `${platform}-${arch}`, 'spawn-helper').replace('app.asar', 'app.asar.unpacked')
}

/** The helper of the node-pty this process loads. */
export function installedPtyHelperPath(): string {
  const packageJson = createRequire(__filename).resolve('node-pty/package.json')
  return ptyHelperPath(dirname(packageJson), process.platform, process.arch)
}
