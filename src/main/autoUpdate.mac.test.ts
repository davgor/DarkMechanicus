import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const checkForUpdates = vi.fn()
const quit = vi.fn()

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '1.2.3',
    getPath: () => '/nonexistent-dm-userdata',
    quit
  },
  BrowserWindow: {
    getAllWindows: () => []
  },
  ipcMain: {
    handle: vi.fn()
  }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    checkForUpdates,
    quitAndInstall: vi.fn(),
    on: vi.fn(),
    logger: undefined,
    autoDownload: false,
    autoInstallOnAppQuit: false
  }
}))

vi.mock('./logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('./macUpdate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./macUpdate')>()
  return {
    ...actual,
    canReplaceBundle: vi.fn(() => true),
    downloadAndStageMacUpdate: vi.fn(),
    discardStagedMacUpdate: vi.fn(),
    startInstallHelper: vi.fn(),
    sweepStaleMacUpdates: vi.fn()
  }
})

import * as macUpdate from './macUpdate'

const originalPlatform = process.platform
const originalExecPath = process.execPath
const APP_EXEC = '/Applications/DarkMechanicus.app/Contents/MacOS/DarkMechanicus'
const feedFiles = [{ url: 'DarkMechanicus-2.0.0-arm64.dmg', sha512: 'sha' }]

function setProperty(name: 'platform' | 'execPath', value: string): void {
  Object.defineProperty(process, name, { value, configurable: true })
}

function feed(version: string, available = true) {
  return { isUpdateAvailable: available, updateInfo: { version, files: feedFiles } }
}

function stagedAt(version: string) {
  return { appPath: `/staged/${version}/DarkMechanicus.app`, workDir: `/staged/${version}` }
}

async function load() {
  vi.resetModules()
  return import('./autoUpdate')
}

beforeEach(() => {
  vi.clearAllMocks()
  setProperty('platform', 'darwin')
  setProperty('execPath', APP_EXEC)
  vi.mocked(macUpdate.canReplaceBundle).mockReturnValue(true)
})

afterEach(() => {
  setProperty('platform', originalPlatform)
  setProperty('execPath', originalExecPath)
  vi.useRealTimers()
})

describe('macOS update checks', () => {
  it('stages a newer version and reports it ready', async () => {
    checkForUpdates.mockResolvedValue(feed('2.0.0'))
    vi.mocked(macUpdate.downloadAndStageMacUpdate).mockResolvedValue(stagedAt('2.0.0'))
    const updater = await load()

    await updater.checkForUpdatesNow()

    expect(macUpdate.downloadAndStageMacUpdate).toHaveBeenCalledTimes(1)
    expect(vi.mocked(macUpdate.downloadAndStageMacUpdate).mock.calls[0]?.[0]).toMatchObject({
      version: '2.0.0',
      arch: process.arch,
      stagingRoot: '/nonexistent-dm-userdata/updates'
    })
    expect(updater.getAutoUpdateState()).toMatchObject({ phase: 'downloaded', availableVersion: '2.0.0' })
  })

  it('does not download when the feed has nothing newer', async () => {
    checkForUpdates.mockResolvedValue(feed('1.2.3', false))
    const updater = await load()

    await updater.checkForUpdatesNow()

    expect(macUpdate.downloadAndStageMacUpdate).not.toHaveBeenCalled()
    expect(updater.getAutoUpdateState().phase).toBe('idle')
  })

  it('does not download again for the version already staged', async () => {
    checkForUpdates.mockResolvedValue(feed('2.0.0'))
    vi.mocked(macUpdate.downloadAndStageMacUpdate).mockResolvedValue(stagedAt('2.0.0'))
    const updater = await load()
    await updater.checkForUpdatesNow()

    await updater.checkForUpdatesNow()

    expect(macUpdate.downloadAndStageMacUpdate).toHaveBeenCalledTimes(1)
    expect(macUpdate.discardStagedMacUpdate).not.toHaveBeenCalled()
  })

  it('discards the staged copy of a superseded version before staging the newer one', async () => {
    vi.mocked(macUpdate.downloadAndStageMacUpdate)
      .mockResolvedValueOnce(stagedAt('2.0.0'))
      .mockResolvedValueOnce(stagedAt('3.0.0'))
    const updater = await load()
    checkForUpdates.mockResolvedValueOnce(feed('2.0.0'))
    await updater.checkForUpdatesNow()
    checkForUpdates.mockResolvedValueOnce(feed('3.0.0'))

    await updater.checkForUpdatesNow()

    expect(macUpdate.discardStagedMacUpdate).toHaveBeenCalledWith(stagedAt('2.0.0'))
    expect(macUpdate.downloadAndStageMacUpdate).toHaveBeenCalledTimes(2)
    expect(updater.getAutoUpdateState()).toMatchObject({ phase: 'downloaded', availableVersion: '3.0.0' })
  })
})

describe('macOS restart handling', () => {
  it('a restart clicked during an in-flight check keeps the staged app and blocks later checks', async () => {
    vi.mocked(macUpdate.downloadAndStageMacUpdate).mockResolvedValue(stagedAt('2.0.0'))
    const updater = await load()
    checkForUpdates.mockResolvedValueOnce(feed('2.0.0'))
    await updater.checkForUpdatesNow()
    checkForUpdates.mockImplementationOnce(async () => {
      updater.quitAndInstallUpdate()
      return feed('3.0.0')
    })

    await updater.checkForUpdatesNow()
    expect(macUpdate.downloadAndStageMacUpdate).toHaveBeenCalledTimes(1)
    expect(macUpdate.discardStagedMacUpdate).not.toHaveBeenCalled()

    const checksBefore = checkForUpdates.mock.calls.length
    await updater.checkForUpdatesNow()
    expect(checkForUpdates.mock.calls.length).toBe(checksBefore)
  })

  it('a second Restart click starts only one install', async () => {
    vi.mocked(macUpdate.downloadAndStageMacUpdate).mockResolvedValue(stagedAt('2.0.0'))
    checkForUpdates.mockResolvedValue(feed('2.0.0'))
    const updater = await load()
    await updater.checkForUpdatesNow()

    updater.quitAndInstallUpdate()
    updater.quitAndInstallUpdate()

    expect(macUpdate.startInstallHelper).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('refuses to install from a folder the user cannot write', async () => {
    vi.mocked(macUpdate.downloadAndStageMacUpdate).mockResolvedValue(stagedAt('2.0.0'))
    checkForUpdates.mockResolvedValue(feed('2.0.0'))
    vi.mocked(macUpdate.canReplaceBundle).mockReturnValue(false)
    const updater = await load()
    await updater.checkForUpdatesNow()

    expect(() => updater.quitAndInstallUpdate()).toThrow('not writable')
    expect(macUpdate.startInstallHelper).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('refuses to install when nothing is staged', async () => {
    const updater = await load()
    expect(() => updater.quitAndInstallUpdate()).toThrow('No staged update')
    expect(macUpdate.startInstallHelper).not.toHaveBeenCalled()
  })
})

describe('macOS startup', () => {
  it('sweeps leftover staging folders on macOS only', async () => {
    vi.useFakeTimers()
    const updater = await load()
    updater.initAutoUpdate()
    expect(macUpdate.sweepStaleMacUpdates).toHaveBeenCalledWith('/nonexistent-dm-userdata/updates')

    vi.clearAllMocks()
    setProperty('platform', 'win32')
    const windowsUpdater = await load()
    windowsUpdater.initAutoUpdate()
    expect(macUpdate.sweepStaleMacUpdates).not.toHaveBeenCalled()
  })
})
