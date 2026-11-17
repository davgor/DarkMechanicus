/**
 * Stops packaging from a checkout whose `node_modules` is a symbolic link or, on Windows, a junction (Node reports
 * both as symbolic links).
 *
 * electron-builder collects the app's production dependencies from `node_modules`; through a link it leaves the
 * hoisted ones out of `app.asar`, and the packaged app does not start. `package:win` and `package:mac` run this
 * before electron-builder so that build fails here, saying why, instead of shipping an app that never opens.
 */
import { lstatSync, readlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Why `root` cannot be packaged, or `null` when its `node_modules` is a real folder (or absent, which
 * electron-builder reports itself).
 */
export function linkedNodeModulesProblem(root = ROOT) {
  const path = join(root, 'node_modules')
  const stats = lstatSync(path, { throwIfNoEntry: false })
  if (stats === undefined || !stats.isSymbolicLink()) {
    return null
  }
  return (
    `Cannot package: ${path} is a symbolic link or junction to ${readlinkSync(path)}. ` +
    'electron-builder would leave the hoisted dependencies out of app.asar and the packaged app would not start. ' +
    'Package from a checkout with its own node_modules folder (run npm ci there).'
  )
}

if (typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problem = linkedNodeModulesProblem()
  if (problem !== null) {
    process.stderr.write(`${problem}\n`)
    process.exitCode = 1
  }
}
