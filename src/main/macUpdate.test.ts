import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_BUNDLE_NAME,
  INSTALL_HELPER_SCRIPT,
  appBundlePathFromExecPath,
  canReplaceBundle,
  discardStagedMacUpdate,
  downloadAndStageMacUpdate,
  isInstallableLocation,
  macArchSuffix,
  pickMacDmg,
  releaseAssetUrl,
  startInstallHelper,
  sweepStaleMacUpdates
} from './macUpdate'

// The real logger loads electron-log, which requires the electron runtime.
vi.mock('./logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

const files = [
  { url: 'DarkMechanicus-0.83.0-x64.dmg', sha512: 'x64-sha' },
  { url: 'DarkMechanicus-0.83.0-arm64.dmg', sha512: 'arm64-sha' }
]

describe('macArchSuffix', () => {
  it('maps Node arch names to the DMG suffix, defaulting to x64', () => {
    expect(macArchSuffix('arm64')).toBe('arm64')
    expect(macArchSuffix('x64')).toBe('x64')
    expect(macArchSuffix('ia32')).toBe('x64')
  })
})

describe('pickMacDmg', () => {
  it('picks the DMG matching the machine architecture', () => {
    expect(pickMacDmg(files, 'arm64')?.sha512).toBe('arm64-sha')
    expect(pickMacDmg(files, 'x64')?.sha512).toBe('x64-sha')
  })

  it('returns undefined when no DMG matches', () => {
    expect(pickMacDmg([{ url: 'DarkMechanicus-Setup-0.83.0.exe', sha512: 'win' }], 'arm64')).toBeUndefined()
  })
})

describe('releaseAssetUrl', () => {
  it('builds the GitHub release download URL for a version tag', () => {
    expect(releaseAssetUrl('0.83.0', 'DarkMechanicus-0.83.0-arm64.dmg')).toBe(
      'https://github.com/davgor/DarkMechanicus/releases/download/v0.83.0/DarkMechanicus-0.83.0-arm64.dmg'
    )
  })
})

describe('appBundlePathFromExecPath', () => {
  it('returns the enclosing .app bundle of the executable', () => {
    expect(
      appBundlePathFromExecPath(`/Applications/${APP_BUNDLE_NAME}/Contents/MacOS/DarkMechanicus`)
    ).toBe(`/Applications/${APP_BUNDLE_NAME}`)
  })

  it('returns undefined when not running from a bundle (dev builds)', () => {
    expect(appBundlePathFromExecPath('/Users/me/node_modules/electron/dist/Electron')).toBeUndefined()
  })
})

describe('isInstallableLocation', () => {
  it('refuses DMG volumes and translocated quarantine copies', () => {
    expect(isInstallableLocation('/Applications/DarkMechanicus.app')).toBe(true)
    expect(isInstallableLocation('/Volumes/DarkMechanicus/DarkMechanicus.app')).toBe(false)
    expect(
      isInstallableLocation('/private/var/folders/x/AppTranslocation/ABC/d/DarkMechanicus.app')
    ).toBe(false)
  })
})

describe('startInstallHelper guards', () => {
  it('refuses a bundle with an unexpected name', () => {
    expect(() =>
      startInstallHelper({ appPath: '/x', workDir: '/y' }, '/Applications/Other.app', 1)
    ).toThrow('unexpected bundle path')
  })

  it('refuses to replace an app running from a DMG volume', () => {
    expect(() =>
      startInstallHelper({ appPath: '/x', workDir: '/y' }, '/Volumes/DarkMechanicus/DarkMechanicus.app', 1)
    ).toThrow('Cannot update an app')
  })
})

describe('downloadAndStageMacUpdate', () => {
  let stagingRoot: string

  beforeEach(() => {
    stagingRoot = mkdtempSync(join(tmpdir(), 'dm-staging-test-'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(stagingRoot, { recursive: true, force: true })
  })

  it('rejects a DMG whose checksum does not match and leaves nothing staged', async () => {
    vi.stubGlobal('fetch', async () => new Response(Buffer.from('not a real dmg')))
    await expect(
      downloadAndStageMacUpdate({
        version: '0.83.0',
        files: [{ url: 'DarkMechanicus-0.83.0-arm64.dmg', sha512: 'wrong' }],
        arch: 'arm64',
        stagingRoot,
        onProgress: () => {}
      })
    ).rejects.toThrow('Checksum mismatch')
    expect(readdirSync(stagingRoot)).toEqual([])
  })

  it('fails before any download when no DMG matches the architecture', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(
      downloadAndStageMacUpdate({
        version: '0.83.0',
        files: [{ url: 'DarkMechanicus-0.83.0-x64.dmg', sha512: 'x' }],
        arch: 'arm64',
        stagingRoot,
        onProgress: () => {}
      })
    ).rejects.toThrow('No macOS arm64 DMG')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fails with the HTTP status when the download is refused', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }))
    await expect(
      downloadAndStageMacUpdate({
        version: '0.83.0',
        files: [{ url: 'DarkMechanicus-0.83.0-arm64.dmg', sha512: 'x' }],
        arch: 'arm64',
        stagingRoot,
        onProgress: () => {}
      })
    ).rejects.toThrow('Download failed (404)')
    expect(readdirSync(stagingRoot)).toEqual([])
  })
})

describe('canReplaceBundle', () => {
  it('is true when the bundle folder is writable and false when it is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-writable-test-'))
    try {
      expect(canReplaceBundle(join(dir, APP_BUNDLE_NAME))).toBe(true)
      expect(canReplaceBundle(join(dir, 'missing', APP_BUNDLE_NAME))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('sweepStaleMacUpdates', () => {
  it('removes leftover staging folders and keeps unrelated entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'dm-sweep-test-'))
    try {
      mkdirSync(join(root, 'dm-update-abc'))
      writeFileSync(join(root, 'dm-update-abc', 'DarkMechanicus.dmg'), 'x')
      mkdirSync(join(root, 'keep-me'))
      sweepStaleMacUpdates(root)
      expect(existsSync(join(root, 'dm-update-abc'))).toBe(false)
      expect(existsSync(join(root, 'keep-me'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does nothing when the staging root does not exist', () => {
    expect(() => sweepStaleMacUpdates(join(tmpdir(), 'dm-no-such-root-' + Date.now()))).not.toThrow()
  })
})

describe('discardStagedMacUpdate', () => {
  it('deletes the staging folder of a superseded update', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'dm-discard-test-'))
    writeFileSync(join(workDir, 'leftover.dmg'), 'x')
    discardStagedMacUpdate({ appPath: join(workDir, 'staged', APP_BUNDLE_NAME), workDir })
    expect(existsSync(workDir)).toBe(false)
  })
})

interface HelperFixture {
  root: string
  home: string
  bin: string
  dest: string
  src: string
  cleanup: string
  openLog: string
}

/** Builds a fake install: a staged app ready to swap in, and shims for ditto, xattr and open. */
function makeHelperFixture(): HelperFixture {
  const root = mkdtempSync(join(tmpdir(), 'dm-helper-test-'))
  const fixture: HelperFixture = {
    root,
    home: join(root, 'home'),
    bin: join(root, 'bin'),
    dest: join(root, 'Applications', APP_BUNDLE_NAME),
    src: join(root, 'staging', 'staged', APP_BUNDLE_NAME),
    cleanup: join(root, 'staging'),
    openLog: join(root, 'open.log')
  }
  for (const dir of [fixture.home, fixture.bin, join(root, 'Applications'), join(fixture.src, 'Contents', 'MacOS')]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(join(fixture.src, 'Contents', 'MacOS', 'marker'), 'new')
  writeFileSync(join(fixture.src, 'Contents', 'Info.plist'), 'new')
  const shims: Record<string, string> = {
    ditto: 'cp -R "$1" "$2"',
    xattr: 'exit 0',
    open: 'echo "$@" >> "$OPEN_LOG"'
  }
  for (const [name, body] of Object.entries(shims)) {
    const path = join(fixture.bin, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  return fixture
}

function runHelper(fixture: HelperFixture): void {
  const result = spawnSync(
    '/bin/sh',
    ['-c', INSTALL_HELPER_SCRIPT, 'dm-update', '999999', fixture.src, fixture.dest, fixture.cleanup],
    {
      env: { HOME: fixture.home, PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`, OPEN_LOG: fixture.openLog },
      encoding: 'utf8'
    }
  )
  expect(result.status).toBe(0)
}

/**
 * Runs the real install script against temp directories. `ditto` becomes `cp -R`, `xattr` a
 * no-op and `open` a logger, so the swap and rollback logic is exercised without touching
 * /Applications. Needs POSIX sh, so it is skipped on Windows.
 */
describe.skipIf(process.platform === 'win32')('INSTALL_HELPER_SCRIPT', () => {
  let fixture: HelperFixture

  beforeEach(() => {
    fixture = makeHelperFixture()
  })

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true })
  })

  it('replaces an existing install, removes the old copy and staging, then reopens the app', () => {
    mkdirSync(join(fixture.dest, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(fixture.dest, 'Contents', 'MacOS', 'marker'), 'old')

    runHelper(fixture)

    expect(readFileSync(join(fixture.dest, 'Contents', 'MacOS', 'marker'), 'utf8')).toBe('new')
    expect(existsSync(`${fixture.dest}.old`)).toBe(false)
    expect(existsSync(`${fixture.dest}.new`)).toBe(false)
    expect(existsSync(fixture.cleanup)).toBe(false)
    expect(readFileSync(fixture.openLog, 'utf8').trim()).toBe(fixture.dest)
  })

  it('keeps the current app when the staged copy is incomplete', () => {
    rmSync(join(fixture.src, 'Contents', 'MacOS'), { recursive: true, force: true })
    mkdirSync(join(fixture.dest, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(fixture.dest, 'Contents', 'MacOS', 'marker'), 'old')

    runHelper(fixture)

    expect(readFileSync(join(fixture.dest, 'Contents', 'MacOS', 'marker'), 'utf8')).toBe('old')
    expect(existsSync(`${fixture.dest}.new`)).toBe(false)
    expect(existsSync(fixture.cleanup)).toBe(false)
    expect(readFileSync(fixture.openLog, 'utf8').trim()).toBe(fixture.dest)
  })

  it('installs when no previous copy exists', () => {
    runHelper(fixture)
    expect(readFileSync(join(fixture.dest, 'Contents', 'MacOS', 'marker'), 'utf8')).toBe('new')
  })
})

describe('downloadAndStageMacUpdate progress', () => {
  let stagingRoot: string

  beforeEach(() => {
    stagingRoot = mkdtempSync(join(tmpdir(), 'dm-progress-test-'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(stagingRoot, { recursive: true, force: true })
  })

  function streamed(contentLength: string | undefined): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(50))
        controller.enqueue(new Uint8Array(50))
        controller.close()
      }
    })
    const headers: Record<string, string> = contentLength === undefined ? {} : { 'content-length': contentLength }
    return new Response(body, { headers })
  }

  async function stageAndCollectProgress(contentLength: string | undefined): Promise<number[]> {
    vi.stubGlobal('fetch', async () => streamed(contentLength))
    const progress: number[] = []
    await expect(
      downloadAndStageMacUpdate({
        version: '0.83.0',
        files: [{ url: 'DarkMechanicus-0.83.0-arm64.dmg', sha512: 'wrong' }],
        arch: 'arm64',
        stagingRoot,
        onProgress: (percent) => progress.push(percent)
      })
    ).rejects.toThrow('Checksum mismatch')
    return progress
  }

  it('reports percent complete from the content length', async () => {
    expect(await stageAndCollectProgress('200')).toEqual([25, 50])
  })

  it('reports no progress when the server gives no content length', async () => {
    expect(await stageAndCollectProgress(undefined)).toEqual([])
  })
})
