import { app, BrowserWindow, type IpcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { AutoUpdatePhase, AutoUpdateState } from '../shared/autoUpdate/types'
import { logger } from './logger'

/** Delay before the first update check after launch. */
export const INITIAL_CHECK_DELAY_MS = 8_000

/** How often to re-check while the app stays open. */
export const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000

let state: AutoUpdateState = {
  phase: 'idle',
  currentVersion: app.getVersion()
}

let checkInFlight = false

export function canStartUpdateCheck(phase: AutoUpdatePhase): boolean {
  return phase === 'idle' || phase === 'error' || phase === 'downloaded'
}

export function formatUpdateReadyMessage(version: string): string {
  return `Version ${version} is ready.`
}

function broadcastState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('autoUpdate:event', state)
    }
  }
}

function setState(patch: Partial<AutoUpdateState>): void {
  state = { ...state, ...patch }
  broadcastState()
}

export function getAutoUpdateState(): AutoUpdateState {
  return state
}

/**
 * Records a failed check or download. A re-check from `downloaded` that fails before a newer
 * version is announced keeps the ready update (and its "Restart now"): electron-updater only
 * clears its cached installer once it starts downloading a newer version. After that the
 * earlier installer is gone, so the failure becomes `error`, which lets the next manual or
 * scheduled check download the newest version again.
 */
function reportUpdateError(message: string): void {
  if (state.phase === 'downloaded') {
    return
  }
  setState({ phase: 'error', message })
}

export function isAutoUpdateEnabled(): boolean {
  return app.isPackaged && process.env['DISABLE_AUTO_UPDATE'] !== '1'
}

let beforeInstall: (() => void) | undefined

/**
 * Registers what runs synchronously when Restart now installs an update, before the app quits. A plain quit, which
 * installs a downloaded update through `autoInstallOnAppQuit`, never runs it.
 */
export function setBeforeInstall(hook: () => void): void {
  beforeInstall = hook
}

export function quitAndInstallUpdate(): void {
  try {
    beforeInstall?.()
  } catch (error) {
    logger.error('The before-install hook failed; installing anyway:', error)
  }
  autoUpdater.quitAndInstall(true, true)
}

export async function checkForUpdatesNow(): Promise<void> {
  if (!isAutoUpdateEnabled()) {
    return
  }
  if (checkInFlight || !canStartUpdateCheck(state.phase)) {
    return
  }

  checkInFlight = true
  try {
    await autoUpdater.checkForUpdates()
  } catch (error: unknown) {
    logger.error('Auto-update check failed:', error)
    reportUpdateError(error instanceof Error ? error.message : 'Update check failed')
  } finally {
    checkInFlight = false
  }
}

/** Registers the update channels on `ipc` (the sender-guarded registrar from `guardIpc`). */
export function registerAutoUpdateHandlers(ipc: Pick<IpcMain, 'handle'>): void {
  ipc.handle('autoUpdate:getState', () => getAutoUpdateState())
  ipc.handle('autoUpdate:quitAndInstall', () => {
    quitAndInstallUpdate()
  })
  ipc.handle('autoUpdate:checkForUpdates', () => checkForUpdatesNow())
}

function wireAutoUpdaterEvents(): void {
  // While a downloaded update is ready, a re-check keeps it (and "Restart now") on screen
  // until a newer version is actually found.
  autoUpdater.on('checking-for-update', () => {
    if (state.phase === 'downloaded') {
      return
    }
    setState({ phase: 'checking', message: undefined })
  })

  autoUpdater.on('update-available', (info) => {
    // electron-updater re-announces the version it already has cached, then re-emits update-downloaded.
    if (state.phase === 'downloaded' && info.version === state.availableVersion) {
      return
    }
    setState({
      phase: 'available',
      availableVersion: info.version,
      message: `Version ${info.version} is downloading…`
    })
  })

  autoUpdater.on('update-not-available', () => {
    if (state.phase === 'downloaded') {
      return
    }
    setState({
      phase: 'idle',
      availableVersion: undefined,
      downloadPercent: undefined,
      message: undefined
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    setState({
      phase: 'downloading',
      downloadPercent: Math.round(progress.percent)
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    setState({
      phase: 'downloaded',
      availableVersion: info.version,
      downloadPercent: 100,
      message: formatUpdateReadyMessage(info.version)
    })
  })

  autoUpdater.on('error', (error) => {
    logger.error('Auto-update error:', error)
    reportUpdateError(error.message)
  })
}

function scheduleUpdateChecks(): void {
  setTimeout(() => {
    void checkForUpdatesNow()
  }, INITIAL_CHECK_DELAY_MS)

  setInterval(() => {
    void checkForUpdatesNow()
  }, POLL_INTERVAL_MS)
}

export function initAutoUpdate(): void {
  if (!isAutoUpdateEnabled()) {
    logger.info('Auto-update disabled (dev build or DISABLE_AUTO_UPDATE=1)')
    return
  }

  autoUpdater.logger = logger
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  wireAutoUpdaterEvents()
  scheduleUpdateChecks()
}
