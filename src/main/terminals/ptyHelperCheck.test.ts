import { chmodSync, cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertPtyHelperExecutable, installedPtyHelperPath, ptyHelperPath, type HelperStat } from './ptyHelperCheck'
import { createNodePtyHost, type NodePtyModule } from './ptyHost'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A helper file in a scratch folder with the given mode, as `npm ci` or a bad package might leave it. */
function helperWithMode(mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'dm-pty-helper-'))
  scratch.push(dir)
  const helper = join(dir, 'spawn-helper')
  writeFileSync(helper, '')
  chmodSync(helper, mode)
  return helper
}

/** A `stat` that reports one mode for every path, for the platforms whose files have no POSIX modes. */
function statWithMode(mode: number): HelperStat {
  return () => ({ mode: 0o100000 | mode, isFile: () => true })
}

const message = (path: string): string => `The terminal helper isn't executable: ${path}. Reinstall Dark Mechanicus.`

/** A node-pty stand-in that records whether anything reached it. */
function recordingPty(): { pty: NodePtyModule; spawned: string[] } {
  const spawned: string[] = []
  const pty: NodePtyModule = {
    spawn(file) {
      spawned.push(file)
      throw new Error('posix_spawnp failed.')
    }
  }
  return { pty, spawned }
}

describe('assertPtyHelperExecutable', () => {
  it('accepts an executable helper on macOS', () => {
    expect(() =>
      assertPtyHelperExecutable('/app/spawn-helper', { platform: 'darwin', stat: statWithMode(0o755) })
    ).not.toThrow()
  })

  it("refuses a helper without the execute bit with the app's own message naming it", () => {
    expect(() => assertPtyHelperExecutable('/app/spawn-helper', { platform: 'darwin', stat: statWithMode(0o644) })).toThrow(
      message('/app/spawn-helper')
    )
  })

  it('refuses a helper that is missing, with the same message', () => {
    const missing: HelperStat = (path) => {
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: 'ENOENT' })
    }

    expect(() => assertPtyHelperExecutable('/app/spawn-helper', { platform: 'darwin', stat: missing })).toThrow(
      message('/app/spawn-helper')
    )
  })

  it('refuses a folder in the helper’s place', () => {
    const folder: HelperStat = () => ({ mode: 0o040755, isFile: () => false })

    expect(() => assertPtyHelperExecutable('/app/spawn-helper', { platform: 'darwin', stat: folder })).toThrow(
      message('/app/spawn-helper')
    )
  })

  it('checks nothing on other platforms, which have no helper', () => {
    for (const platform of ['linux', 'win32']) {
      expect(() => assertPtyHelperExecutable('/app/spawn-helper', { platform, stat: statWithMode(0o644) })).not.toThrow()
    }
  })

  // Windows reports no POSIX modes, so the checks on real files run elsewhere.
  it.runIf(process.platform !== 'win32')('reads the real file’s mode', () => {
    expect(() => assertPtyHelperExecutable(helperWithMode(0o755), { platform: 'darwin' })).not.toThrow()
    const helper = helperWithMode(0o644)
    expect(() => assertPtyHelperExecutable(helper, { platform: 'darwin' })).toThrow(message(helper))
  })
})

describe('ptyHelperPath', () => {
  it("is node-pty's prebuilt helper for the platform and architecture", () => {
    expect(ptyHelperPath('/repo/node_modules/node-pty', 'darwin', 'arm64')).toBe(
      join('/repo/node_modules/node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper')
    )
  })

  it('points into app.asar.unpacked in a packaged app, as node-pty itself does', () => {
    expect(
      ptyHelperPath('/Applications/DarkMechanicus.app/Contents/Resources/app.asar/node_modules/node-pty', 'darwin', 'x64')
    ).toBe(
      join(
        '/Applications/DarkMechanicus.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty',
        'prebuilds',
        'darwin-x64',
        'spawn-helper'
      )
    )
  })

  it('is the installed node-pty’s helper for this machine', () => {
    expect(installedPtyHelperPath()).toBe(
      join(realpathSync.native(join(process.cwd(), 'node_modules')), 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    )
  })
})

/** Creates a host over a node-pty stand-in whose helper `/app/spawn-helper` reports `mode`. */
function hostWithHelperMode(platform: string, mode: number): Promise<unknown> {
  const { pty } = recordingPty()
  return createNodePtyHost({
    platform,
    helperPath: '/app/spawn-helper',
    statHelper: statWithMode(mode),
    load: () => Promise.resolve(pty)
  })
}

describe('createNodePtyHost: the helper check', () => {
  it.runIf(process.platform !== 'win32')(
    "refuses terminals on macOS with the app's message when the helper is not executable, before node-pty is reached",
    async () => {
      const helperPath = helperWithMode(0o644)
      const { pty, spawned } = recordingPty()
      let loaded = false
      const load = (): Promise<NodePtyModule> => {
        loaded = true
        return Promise.resolve(pty)
      }

      const created = createNodePtyHost({ platform: 'darwin', helperPath, load })

      await expect(created).rejects.toThrow(message(helperPath))
      await expect(created).rejects.not.toThrow(/posix_spawnp/)
      expect(loaded).toBe(false)
      expect(spawned).toEqual([])
    }
  )

  it('checks the stat it is given, so the check runs on every platform the tests run on', async () => {
    await expect(hostWithHelperMode('darwin', 0o644)).rejects.toThrow(message('/app/spawn-helper'))
  })

  it('starts on macOS when the helper is executable', async () => {
    await expect(hostWithHelperMode('darwin', 0o755)).resolves.toBeDefined()
  })

  it('does not look for a helper outside macOS', async () => {
    await expect(hostWithHelperMode('linux', 0o644)).resolves.toBeDefined()
  })
})

/**
 * A copy of the installed node-pty (its JavaScript and this machine's prebuild) in a scratch folder, with
 * the helper's execute bit removed as the 1.1.0 tarball ships it, so the real module can be run against
 * a broken helper without touching `node_modules`.
 */
function brokenNodePtyCopy(): string {
  const installed = join(process.cwd(), 'node_modules', 'node-pty')
  const dir = mkdtempSync(join(tmpdir(), 'dm-pty-copy-'))
  scratch.push(dir)
  const copy = join(dir, 'node_modules', 'node-pty')
  const prebuild = join('prebuilds', `${process.platform}-${process.arch}`)
  for (const part of ['package.json', 'lib', prebuild]) {
    cpSync(join(installed, part), join(copy, part), { recursive: true })
  }
  chmodSync(join(copy, prebuild, 'spawn-helper'), 0o644)
  return copy
}

const ECHO = { file: '/bin/echo', args: ['ok'], cwd: '/', env: { PATH: '/usr/bin:/bin' }, cols: 80, rows: 24 }

describe.runIf(process.platform === 'darwin')('the real node-pty with its helper not executable', () => {
  it("fails with the app's message naming the helper instead of posix_spawnp failed.", async () => {
    const copy = brokenNodePtyCopy()
    const require = createRequire(import.meta.url)
    const pty = require(copy) as NodePtyModule
    const helperPath = ptyHelperPath(copy, process.platform, process.arch)

    // Unchecked, node-pty itself reports only the failed spawn.
    expect(() => pty.spawn(ECHO.file, [...ECHO.args], { ...ECHO, name: 'xterm' })).toThrow('posix_spawnp failed.')
    await expect(createNodePtyHost({ helperPath, load: () => Promise.resolve(pty) })).rejects.toThrow(message(helperPath))
  })
})
