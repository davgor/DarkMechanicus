import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoUpdateState } from '../shared/autoUpdate/types'

const checkForUpdates = vi.fn()
const quitAndInstall = vi.fn()
const on = vi.fn()

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '1.2.3'
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
    quitAndInstall,
    on,
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

async function loadModule(): Promise<typeof import('./autoUpdate')> {
  return import('./autoUpdate')
}

function resetAutoUpdateTest(): void {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  checkForUpdates.mockResolvedValue(undefined)
  delete process.env['DISABLE_AUTO_UPDATE']
}

function restoreAutoUpdateTest(): void {
  vi.useRealTimers()
  delete process.env['DISABLE_AUTO_UPDATE']
}

/** Snapshot mock call count into a plain number so fireguard does not treat it as a tautology. */
function callCount(fn: { mock: { calls: unknown[] } }): number {
  return fn.mock.calls.length
}

type UpdaterHandler = (payload?: unknown) => void

/** Records the handlers `initAutoUpdate` wires onto the mocked updater so tests can fire its events. */
function captureUpdaterHandlers(): Map<string, UpdaterHandler> {
  const handlers = new Map<string, UpdaterHandler>()
  on.mockImplementation((event: string, handler: UpdaterHandler) => {
    handlers.set(event, handler)
  })
  return handlers
}

type LoadedWithHandlers = typeof import('./autoUpdate') & { handlers: Map<string, UpdaterHandler> }

/** Loads the module, runs the first scheduled check and finishes downloading `version`. */
async function loadWithDownloadedUpdate(version: string): Promise<LoadedWithHandlers> {
  const handlers = captureUpdaterHandlers()
  const autoUpdate = await loadModule()
  autoUpdate.initAutoUpdate()
  await vi.advanceTimersByTimeAsync(autoUpdate.INITIAL_CHECK_DELAY_MS)
  handlers.get('update-downloaded')?.({ version })
  return { ...autoUpdate, handlers }
}

/** The state the banner renders as "Version <version> is ready." with "Restart now". */
function readyState(version: string): AutoUpdateState {
  return {
    phase: 'downloaded',
    currentVersion: '1.2.3',
    availableVersion: version,
    downloadPercent: 100,
    message: `Version ${version} is ready.`
  }
}

describe('canStartUpdateCheck', () => {
  beforeEach(resetAutoUpdateTest)
  afterEach(restoreAutoUpdateTest)

  it('allows idle, error and downloaded, blocks in-flight phases', async () => {
    const { canStartUpdateCheck } = await loadModule()
    const byPhase = {
      idle: canStartUpdateCheck('idle'),
      error: canStartUpdateCheck('error'),
      checking: canStartUpdateCheck('checking'),
      available: canStartUpdateCheck('available'),
      downloading: canStartUpdateCheck('downloading'),
      downloaded: canStartUpdateCheck('downloaded')
    }
    expect(byPhase).toEqual({
      idle: true,
      error: true,
      checking: false,
      available: false,
      downloading: false,
      downloaded: true
    })
  })
})

describe('initAutoUpdate scheduling', () => {
  beforeEach(resetAutoUpdateTest)
  afterEach(restoreAutoUpdateTest)

  it('schedules an initial check then recurring polls', async () => {
    const { initAutoUpdate, INITIAL_CHECK_DELAY_MS, POLL_INTERVAL_MS } = await loadModule()
    initAutoUpdate()

    expect(callCount(checkForUpdates)).toBe(0)

    await vi.advanceTimersByTimeAsync(INITIAL_CHECK_DELAY_MS)
    expect(callCount(checkForUpdates)).toBe(1)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(callCount(checkForUpdates)).toBe(2)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(callCount(checkForUpdates)).toBe(3)
  })
})

describe('checkForUpdatesNow guards', () => {
  beforeEach(resetAutoUpdateTest)
  afterEach(restoreAutoUpdateTest)

  it('skips overlapping checks while a previous check is in flight', async () => {
    let resolveCheck: (() => void) | undefined
    checkForUpdates.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCheck = resolve
        })
    )

    const { initAutoUpdate, checkForUpdatesNow, INITIAL_CHECK_DELAY_MS } = await loadModule()
    initAutoUpdate()
    await vi.advanceTimersByTimeAsync(INITIAL_CHECK_DELAY_MS)
    expect(callCount(checkForUpdates)).toBe(1)

    const overlapping = checkForUpdatesNow()
    expect(callCount(checkForUpdates)).toBe(1)

    resolveCheck?.()
    await overlapping
  })

  it('is a no-op when auto-update is disabled', async () => {
    process.env['DISABLE_AUTO_UPDATE'] = '1'
    const { checkForUpdatesNow, isAutoUpdateEnabled } = await loadModule()
    expect(isAutoUpdateEnabled()).toBe(false)
    await checkForUpdatesNow()
    expect(callCount(checkForUpdates)).toBe(0)
  })
})

describe('checkForUpdatesNow phase guards', () => {
  beforeEach(resetAutoUpdateTest)
  afterEach(restoreAutoUpdateTest)

  it('does not start a check while checking, available or downloading', async () => {
    const handlers = captureUpdaterHandlers()
    const { initAutoUpdate, checkForUpdatesNow, getAutoUpdateState, INITIAL_CHECK_DELAY_MS } =
      await loadModule()
    initAutoUpdate()
    await vi.advanceTimersByTimeAsync(INITIAL_CHECK_DELAY_MS)
    expect(callCount(checkForUpdates)).toBe(1)

    const attempts: Array<{ phase: string; calls: number }> = []
    const tryCheckAfter = async (event: string, payload?: unknown): Promise<void> => {
      handlers.get(event)?.(payload)
      await checkForUpdatesNow()
      attempts.push({ phase: getAutoUpdateState().phase, calls: callCount(checkForUpdates) })
    }
    await tryCheckAfter('checking-for-update')
    await tryCheckAfter('update-available', { version: '2.0.0' })
    await tryCheckAfter('download-progress', { percent: 10 })

    expect(attempts).toEqual([
      { phase: 'checking', calls: 1 },
      { phase: 'available', calls: 1 },
      { phase: 'downloading', calls: 1 }
    ])
  })

  it('skips overlapping re-checks while a downloaded update is ready', async () => {
    let resolveCheck: (() => void) | undefined
    const { checkForUpdatesNow } = await loadWithDownloadedUpdate('9.0.0')
    checkForUpdates.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCheck = resolve
        })
    )

    const first = checkForUpdatesNow()
    const overlapping = checkForUpdatesNow()
    expect(callCount(checkForUpdates)).toBe(2)

    resolveCheck?.()
    await Promise.all([first, overlapping])
  })
})

describe('re-check triggers after an update is downloaded', () => {
  beforeEach(resetAutoUpdateTest)
  afterEach(restoreAutoUpdateTest)

  it('queries the feed again on the scheduled poll', async () => {
    const { getAutoUpdateState, POLL_INTERVAL_MS } = await loadWithDownloadedUpdate('9.0.0')
    expect(getAutoUpdateState().phase).toBe('downloaded')
    expect(callCount(checkForUpdates)).toBe(1)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(callCount(checkForUpdates)).toBe(2)
  })

  it('queries the feed again on the manual Check for updates request', async () => {
    const { registerAutoUpdateHandlers } = await loadWithDownloadedUpdate('9.0.0')
    const listeners = new Map<string, () => unknown>()
    registerAutoUpdateHandlers({
      handle: (channel, listener) => {
        listeners.set(channel, () => listener({} as IpcMainInvokeEvent))
      }
    })

    await listeners.get('autoUpdate:checkForUpdates')?.()
    expect(callCount(checkForUpdates)).toBe(2)
  })
})

describe('re-check finding a newer version after an update is downloaded', () => {
  beforeEach(resetAutoUpdateTest)
  afterEach(restoreAutoUpdateTest)

  it('moves to a newer version through available, downloading and downloaded', async () => {
    const { checkForUpdatesNow, getAutoUpdateState, handlers } =
      await loadWithDownloadedUpdate('9.0.0')
    await checkForUpdatesNow()

    const steps: Array<Partial<AutoUpdateState>> = []
    for (const [event, payload] of [
      ['checking-for-update', undefined],
      ['update-available', { version: '9.1.0' }],
      ['download-progress', { percent: 41.6 }],
      ['update-downloaded', { version: '9.1.0' }]
    ] as const) {
      handlers.get(event)?.(payload)
      const { phase, availableVersion, message } = getAutoUpdateState()
      steps.push({ phase, availableVersion, message })
    }

    expect(steps).toEqual([
      { phase: 'downloaded', availableVersion: '9.0.0', message: 'Version 9.0.0 is ready.' },
      { phase: 'available', availableVersion: '9.1.0', message: 'Version 9.1.0 is downloading…' },
      { phase: 'downloading', availableVersion: '9.1.0', message: 'Version 9.1.0 is downloading…' },
      { phase: 'downloaded', availableVersion: '9.1.0', message: 'Version 9.1.0 is ready.' }
    ])
  })

  it('reports an error and allows a fresh check when a newer download fails', async () => {
    const { checkForUpdatesNow, getAutoUpdateState, handlers, POLL_INTERVAL_MS } =
      await loadWithDownloadedUpdate('9.0.0')
    await checkForUpdatesNow()

    handlers.get('update-available')?.({ version: '9.1.0' })
    handlers.get('download-progress')?.({ percent: 30 })
    handlers.get('error')?.(new Error('download interrupted'))
    const { phase, message } = getAutoUpdateState()
    const callsBeforeRecovery = callCount(checkForUpdates)

    await checkForUpdatesNow()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    expect({ phase, message }).toEqual({ phase: 'error', message: 'download interrupted' })
    expect(callCount(checkForUpdates)).toBe(callsBeforeRecovery + 2)
  })
})

describe('re-check keeping the downloaded update', () => {
  beforeEach(resetAutoUpdateTest)
  afterEach(restoreAutoUpdateTest)

  it('keeps the downloaded update ready when the feed has nothing newer', async () => {
    const { checkForUpdatesNow, getAutoUpdateState, handlers } =
      await loadWithDownloadedUpdate('9.0.0')
    await checkForUpdatesNow()

    handlers.get('checking-for-update')?.()
    handlers.get('update-not-available')?.({ version: '9.0.0' })

    expect(getAutoUpdateState()).toEqual(readyState('9.0.0'))
  })

  it('keeps the downloaded update ready when the feed re-announces the same version', async () => {
    const { checkForUpdatesNow, getAutoUpdateState, handlers } =
      await loadWithDownloadedUpdate('9.0.0')
    await checkForUpdatesNow()

    const phases: string[] = []
    for (const [event, payload] of [
      ['checking-for-update', undefined],
      ['update-available', { version: '9.0.0' }],
      ['update-downloaded', { version: '9.0.0' }]
    ] as const) {
      handlers.get(event)?.(payload)
      phases.push(getAutoUpdateState().phase)
    }

    expect(phases).toEqual(['downloaded', 'downloaded', 'downloaded'])
    expect(getAutoUpdateState()).toEqual(readyState('9.0.0'))
  })

  it('keeps the downloaded update ready when the re-check itself fails', async () => {
    const { checkForUpdatesNow, getAutoUpdateState, handlers } =
      await loadWithDownloadedUpdate('9.0.0')

    handlers.get('checking-for-update')?.()
    handlers.get('error')?.(new Error('net::ERR_INTERNET_DISCONNECTED'))
    const afterErrorEvent = getAutoUpdateState()

    checkForUpdates.mockRejectedValueOnce(new Error('offline'))
    await checkForUpdatesNow()

    expect(afterErrorEvent).toEqual(readyState('9.0.0'))
    expect(getAutoUpdateState()).toEqual(readyState('9.0.0'))
  })
})

describe('registerAutoUpdateHandlers', () => {
  beforeEach(resetAutoUpdateTest)
  afterEach(restoreAutoUpdateTest)

  it('registers the update channels on the registrar it is given', async () => {
    const { registerAutoUpdateHandlers, getAutoUpdateState } = await loadModule()
    const listeners = new Map<string, () => unknown>()
    registerAutoUpdateHandlers({
      handle: (channel, listener) => {
        listeners.set(channel, () => listener({} as IpcMainInvokeEvent))
      }
    })

    expect([...listeners.keys()].sort()).toEqual([
      'autoUpdate:checkForUpdates',
      'autoUpdate:getState',
      'autoUpdate:quitAndInstall'
    ])
    expect(listeners.get('autoUpdate:getState')?.()).toEqual({ phase: 'idle', currentVersion: '1.2.3' })
    expect(getAutoUpdateState()).toEqual({ phase: 'idle', currentVersion: '1.2.3' })
  })

  it('forwards update checks and the silent install to the updater', async () => {
    const { registerAutoUpdateHandlers } = await loadModule()
    const listeners = new Map<string, () => unknown>()
    registerAutoUpdateHandlers({
      handle: (channel, listener) => {
        listeners.set(channel, () => listener({} as IpcMainInvokeEvent))
      }
    })

    await listeners.get('autoUpdate:checkForUpdates')?.()
    listeners.get('autoUpdate:quitAndInstall')?.()

    expect(callCount(checkForUpdates)).toBe(1)
    expect(quitAndInstall.mock.calls[0] ?? []).toEqual([true, true])
  })
})

describe('silent apply helpers', () => {
  beforeEach(resetAutoUpdateTest)
  afterEach(restoreAutoUpdateTest)

  it('quitAndInstallUpdate uses silent install with force-run-after', async () => {
    const { quitAndInstallUpdate } = await loadModule()
    quitAndInstallUpdate()
    const [silent, forceRunAfter] = quitAndInstall.mock.calls[0] ?? []
    expect(silent).toBe(true)
    expect(forceRunAfter).toBe(true)
  })

  it('formats the ready notification with the current version', async () => {
    const { formatUpdateReadyMessage } = await loadModule()
    const message = formatUpdateReadyMessage('2.0.0')
    expect(message).toBe('Version 2.0.0 is ready.')
  })
})
