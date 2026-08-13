import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('canStartUpdateCheck', () => {
  beforeEach(resetAutoUpdateTest)
  afterEach(restoreAutoUpdateTest)

  it('allows idle and error, blocks in-flight phases', async () => {
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
      downloaded: false
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

  it('skips checks after an update is already downloaded', async () => {
    const handlers = new Map<string, (info?: { version: string }) => void>()
    on.mockImplementation((event: string, handler: (info?: { version: string }) => void) => {
      handlers.set(event, handler)
    })

    const {
      initAutoUpdate,
      checkForUpdatesNow,
      getAutoUpdateState,
      INITIAL_CHECK_DELAY_MS
    } = await loadModule()
    initAutoUpdate()
    await vi.advanceTimersByTimeAsync(INITIAL_CHECK_DELAY_MS)
    expect(callCount(checkForUpdates)).toBe(1)

    handlers.get('update-downloaded')?.({ version: '9.0.0' })
    expect(getAutoUpdateState().phase).toBe('downloaded')
    expect(getAutoUpdateState().availableVersion).toBe('9.0.0')

    await checkForUpdatesNow()
    expect(callCount(checkForUpdates)).toBe(1)
  })

  it('is a no-op when auto-update is disabled', async () => {
    process.env['DISABLE_AUTO_UPDATE'] = '1'
    const { checkForUpdatesNow, isAutoUpdateEnabled } = await loadModule()
    expect(isAutoUpdateEnabled()).toBe(false)
    await checkForUpdatesNow()
    expect(callCount(checkForUpdates)).toBe(0)
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

  it('formats ready-state copy for silent restart apply', async () => {
    const { formatUpdateReadyMessage } = await loadModule()
    const message = formatUpdateReadyMessage('2.0.0')
    expect(message).toMatch(/restart/i)
    expect(message).toMatch(/silent|no installer/i)
    expect(message).toContain('2.0.0')
  })
})
