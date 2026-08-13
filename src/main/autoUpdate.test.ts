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

describe('canStartUpdateCheck', () => {
  beforeEach(resetAutoUpdateTest)
  afterEach(restoreAutoUpdateTest)

  it('is false while busy or already downloaded', async () => {
    const { canStartUpdateCheck } = await loadModule()
    expect(canStartUpdateCheck('idle')).toBe(true)
    expect(canStartUpdateCheck('error')).toBe(true)
    expect(canStartUpdateCheck('checking')).toBe(false)
    expect(canStartUpdateCheck('available')).toBe(false)
    expect(canStartUpdateCheck('downloading')).toBe(false)
    expect(canStartUpdateCheck('downloaded')).toBe(false)
  })
})

describe('initAutoUpdate scheduling', () => {
  beforeEach(resetAutoUpdateTest)
  afterEach(restoreAutoUpdateTest)

  it('schedules an initial check then recurring polls', async () => {
    const { initAutoUpdate, INITIAL_CHECK_DELAY_MS, POLL_INTERVAL_MS } = await loadModule()
    initAutoUpdate()

    expect(checkForUpdates).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(INITIAL_CHECK_DELAY_MS)
    expect(checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(checkForUpdates).toHaveBeenCalledTimes(3)
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
    expect(checkForUpdates).toHaveBeenCalledTimes(1)

    const overlapping = checkForUpdatesNow()
    expect(checkForUpdates).toHaveBeenCalledTimes(1)

    resolveCheck?.()
    await overlapping
  })

  it('skips checks after an update is already downloaded', async () => {
    const handlers = new Map<string, (info?: { version: string }) => void>()
    on.mockImplementation((event: string, handler: (info?: { version: string }) => void) => {
      handlers.set(event, handler)
    })

    const { initAutoUpdate, checkForUpdatesNow, INITIAL_CHECK_DELAY_MS } = await loadModule()
    initAutoUpdate()
    await vi.advanceTimersByTimeAsync(INITIAL_CHECK_DELAY_MS)
    expect(checkForUpdates).toHaveBeenCalledTimes(1)

    handlers.get('update-downloaded')?.({ version: '9.0.0' })
    await checkForUpdatesNow()
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when auto-update is disabled', async () => {
    process.env['DISABLE_AUTO_UPDATE'] = '1'
    const { checkForUpdatesNow } = await loadModule()
    await checkForUpdatesNow()
    expect(checkForUpdates).not.toHaveBeenCalled()
  })
})

describe('silent apply helpers', () => {
  beforeEach(resetAutoUpdateTest)
  afterEach(restoreAutoUpdateTest)

  it('quitAndInstallUpdate uses silent install with force-run-after', async () => {
    const { quitAndInstallUpdate } = await loadModule()
    quitAndInstallUpdate()
    expect(quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('formats ready-state copy for silent restart apply', async () => {
    const { formatUpdateReadyMessage } = await loadModule()
    expect(formatUpdateReadyMessage('2.0.0')).toMatch(/restart/i)
    expect(formatUpdateReadyMessage('2.0.0')).toMatch(/silent|no installer/i)
  })
})
