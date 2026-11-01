import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { afterPack, setPtyHelperMode } from './ptyHelperMode.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXECUTE_BITS = 0o111

const scratch = []

/** A node_modules folder with node-pty's prebuilds laid out as the 1.1.0 tarball ships them (helper not executable). */
function fakeInstall(root = mkdtempSync(join(tmpdir(), 'pty-helper-'))) {
  scratch.push(root)
  const prebuilds = join(root, 'node_modules', 'node-pty', 'prebuilds')
  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    mkdirSync(join(prebuilds, arch), { recursive: true })
    writeFileSync(join(prebuilds, arch, 'spawn-helper'), '')
    chmodSync(join(prebuilds, arch, 'spawn-helper'), 0o644)
  }
  mkdirSync(join(prebuilds, 'win32-x64'), { recursive: true })
  writeFileSync(join(prebuilds, 'win32-x64', 'pty.node'), '')
  return root
}

function mode(path) {
  return statSync(path).mode & 0o777
}

afterEach(() => {
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('setPtyHelperMode', () => {
  // Windows reports no POSIX modes (Node's chmod there only toggles read-only), so the mode checks run elsewhere.
  it.runIf(process.platform !== 'win32')('makes every darwin spawn-helper executable on macOS, keeping its other bits', () => {
    const root = fakeInstall()

    const fixed = setPtyHelperMode({ root, platform: 'darwin' })

    expect(fixed.map((path) => path.slice(root.length))).toEqual([
      join('/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'),
      join('/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper')
    ])
    for (const path of fixed) {
      expect(mode(path)).toBe(0o755)
    }
  })

  it('finds no helper to fix on other platforms', () => {
    const root = fakeInstall()

    for (const platform of ['linux', 'win32']) {
      expect(setPtyHelperMode({ root, platform })).toEqual([])
    }
  })

  it.runIf(process.platform !== 'win32')('leaves every helper not executable on other platforms', () => {
    const root = fakeInstall()

    for (const platform of ['linux', 'win32']) {
      setPtyHelperMode({ root, platform })
    }
    expect(mode(join(root, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'))).toBe(0o644)
  })

  it('does nothing when node-pty is not installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'pty-helper-'))
    scratch.push(root)

    expect(setPtyHelperMode({ root, platform: 'darwin' })).toEqual([])
  })
})

/**
 * electron-builder's afterPack context for a packed macOS app whose unpacked node-pty is laid out as the
 * tarball ships it, and the app's `app.asar.unpacked` folder.
 */
function packedApp(electronPlatformName) {
  const appOutDir = mkdtempSync(join(tmpdir(), 'pty-helper-pack-'))
  scratch.push(appOutDir)
  const resources = join(appOutDir, 'DarkMechanicus.app', 'Contents', 'Resources')
  const unpacked = join(resources, 'app.asar.unpacked')
  fakeInstall(unpacked)
  const packager = { getResourcesDir: (dir) => (dir === appOutDir ? resources : null) }
  return { context: { appOutDir, electronPlatformName, packager }, unpacked }
}

describe('afterPack', () => {
  it.runIf(process.platform !== 'win32')('makes the helpers in a packed macOS app executable', async () => {
    const { context, unpacked } = packedApp('darwin')

    await afterPack(context)

    for (const arch of ['darwin-arm64', 'darwin-x64']) {
      expect(mode(join(unpacked, 'node_modules/node-pty/prebuilds', arch, 'spawn-helper'))).toBe(0o755)
    }
  })

  it('fails the package when a macOS app has no unpacked helper, so a bad asarUnpack cannot ship', async () => {
    const appOutDir = mkdtempSync(join(tmpdir(), 'pty-helper-pack-'))
    scratch.push(appOutDir)
    const packager = { getResourcesDir: () => join(appOutDir, 'DarkMechanicus.app', 'Contents', 'Resources') }

    await expect(afterPack({ appOutDir, electronPlatformName: 'darwin', packager })).rejects.toThrow(/spawn-helper/)
  })

  it.runIf(process.platform !== 'win32')('leaves other platforms’ packages alone', async () => {
    const { context, unpacked } = packedApp('win32')

    await afterPack(context)

    expect(mode(join(unpacked, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'))).toBe(0o644)
  })
})

describe.skipIf(process.platform !== 'darwin')("this checkout's node-pty", () => {
  it('has an executable spawn-helper for every macOS prebuild (set by postinstall)', () => {
    for (const arch of ['darwin-arm64', 'darwin-x64']) {
      const helper = join(ROOT, 'node_modules/node-pty/prebuilds', arch, 'spawn-helper')
      expect(mode(helper) & EXECUTE_BITS, helper).toBe(EXECUTE_BITS)
    }
  })
})
