/**
 * Sets the execute bit on node-pty's macOS `spawn-helper`.
 *
 * node-pty 1.1.0's published tarball ships `prebuilds/darwin-*\/spawn-helper` as `-rw-r--r--`, and without
 * the bit every PTY spawn fails with `posix_spawnp failed.`. Neither of node-pty's install scripts sets it,
 * so approving them would not help: this runs from the repository's `postinstall` instead, and as
 * electron-builder's `afterPack` hook on each packed macOS app. Other platforms have no helper to fix, so
 * it does nothing there.
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXECUTE_BITS = 0o111

/**
 * Makes every `node_modules/node-pty/prebuilds/darwin-*\/spawn-helper` under `root` executable on macOS.
 * Returns the helpers it found (all executable afterwards), or nothing on other platforms or without node-pty.
 */
export function setPtyHelperMode({ root = ROOT, platform = process.platform } = {}) {
  const prebuilds = join(root, 'node_modules', 'node-pty', 'prebuilds')
  if (platform !== 'darwin' || !existsSync(prebuilds)) {
    return []
  }
  const helpers = readdirSync(prebuilds)
    .filter((name) => name.startsWith('darwin-'))
    .sort()
    .map((name) => join(prebuilds, name, 'spawn-helper'))
    .filter((path) => existsSync(path))
  for (const helper of helpers) {
    chmodSync(helper, (statSync(helper).mode & 0o7777) | EXECUTE_BITS)
  }
  return helpers
}

/**
 * electron-builder's `afterPack` hook: makes the helpers in a packed macOS app's `app.asar.unpacked`
 * executable, and fails the package when that app has none (node-pty was not unpacked from the asar).
 */
export async function afterPack({ appOutDir, electronPlatformName, packager }) {
  if (electronPlatformName !== 'darwin') {
    return
  }
  const unpacked = join(packager.getResourcesDir(appOutDir), 'app.asar.unpacked')
  if (setPtyHelperMode({ root: unpacked, platform: electronPlatformName }).length === 0) {
    throw new Error(`No node-pty spawn-helper under ${unpacked}: node_modules/node-pty/** must be in asarUnpack.`)
  }
}

if (typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setPtyHelperMode()
}
