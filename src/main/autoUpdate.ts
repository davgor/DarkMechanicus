import { app, BrowserWindow, ipcMain } from 'electron'
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
  return phase === 'idle' || phase === 'error'
}

export function formatUpdateReadyMessage(version: string): string {
  return `Version ${version} is ready. Restart to apply silently — no installer.`
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

export function isAutoUpdateEnabled(): boolean {
  return app.isPackaged && process.env['DISABLE_AUTO_UPDATE'] !== '1'
}

export function quitAndInstallUpdate(): void {
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
    setState({
      phase: 'error',
      message: error instanceof Error ? error.message : 'Update check failed'
    })
  } finally {
    checkInFlight = false
  }
}

export function registerAutoUpdateHandlers(): void {
  ipcMain.handle('autoUpdate:getState', () => getAutoUpdateState())
  ipcMain.handle('autoUpdate:quitAndInstall', () => {
    quitAndInstallUpdate()
  })
  ipcMain.handle('autoUpdate:checkForUpdates', () => checkForUpdatesNow())
}

function wireAutoUpdaterEvents(): void {
  autoUpdater.on('checking-for-update', () => {
    setState({ phase: 'checking', message: undefined })
  })

  autoUpdater.on('update-available', (info) => {
    setState({
      phase: 'available',
      availableVersion: info.version,
      message: `Version ${info.version} is downloading…`
    })
  })

  autoUpdater.on('update-not-available', () => {
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
    setState({
      phase: 'error',
      message: error.message
    })
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
