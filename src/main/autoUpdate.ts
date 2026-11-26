import { app, BrowserWindow, type IpcMain } from 'electron'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import type { AutoUpdatePhase, AutoUpdateState } from '../shared/autoUpdate/types'
import { logger } from './logger'
import {
  appBundlePathFromExecPath,
  discardStagedMacUpdate,
  downloadAndStageMacUpdate,
  canReplaceBundle,
  isInstallableLocation,
  startInstallHelper,
  sweepStaleMacUpdates,
  type StagedMacUpdate
} from './macUpdate'

const isMac = (): boolean => process.platform === 'darwin'

/** Staged macOS update waiting for "Restart now". Set only after the DMG is verified and unpacked. */
let stagedMacUpdate: StagedMacUpdate | undefined
/** Latched on the first "Restart now" so a second click cannot start a competing install. */
let macInstallStarted = false

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

function runBeforeInstall(): void {
  try {
    beforeInstall?.()
  } catch (error) {
    logger.error('The before-install hook failed; installing anyway:', error)
  }
}

export function quitAndInstallUpdate(): void {
  if (!isMac()) {
    runBeforeInstall()
    autoUpdater.quitAndInstall(true, true)
    return
  }
  if (macInstallStarted) {
    return
  }
  const targetApp = appBundlePathFromExecPath(process.execPath)
  if (!stagedMacUpdate || !targetApp) {
    throw new Error('No staged update to install from this build')
  }
  if (!isInstallableLocation(targetApp)) {
    throw new Error(`Cannot update an app running from ${targetApp}; move it to Applications first`)
  }
  if (!canReplaceBundle(targetApp)) {
    throw new Error(`Cannot replace ${targetApp}: its folder is not writable by this user`)
  }
  macInstallStarted = true
  runBeforeInstall()
  try {
    startInstallHelper(stagedMacUpdate, targetApp, process.pid)
  } catch (error: unknown) {
    macInstallStarted = false
    throw error
  }
  app.quit()
}

/**
 * macOS: reads `latest-mac.yml` through electron-updater (autoDownload is off there), then fetches
 * and verifies the DMG ourselves instead of letting electron-updater install it.
 */
async function checkMacUpdate(): Promise<void> {
  const result = await autoUpdater.checkForUpdates()
  // A restart clicked while this check was waiting on the network must not discard its staged app.
  if (macInstallStarted || !result?.isUpdateAvailable) {
    return
  }
  const { version, files } = result.updateInfo
  if (state.phase === 'downloaded' && version === state.availableVersion) {
    return
  }

  if (stagedMacUpdate) {
    discardStagedMacUpdate(stagedMacUpdate)
    stagedMacUpdate = undefined
  }
  setState({ phase: 'downloading', availableVersion: version, downloadPercent: 0, message: undefined })
  const staged = await downloadAndStageMacUpdate({
    version,
    files,
    arch: process.arch,
    stagingRoot: join(app.getPath('userData'), 'updates'),
    onProgress: (percent) => {
      setState({ phase: 'downloading', downloadPercent: percent })
    }
  })
  stagedMacUpdate = staged
  setState({
    phase: 'downloaded',
    availableVersion: version,
    downloadPercent: 100,
    message: formatUpdateReadyMessage(version)
  })
}

export async function checkForUpdatesNow(): Promise<void> {
  if (!isAutoUpdateEnabled()) {
    return
  }
  if (checkInFlight || macInstallStarted || !canStartUpdateCheck(state.phase)) {
    return
  }

  checkInFlight = true
  try {
    if (isMac()) {
      await checkMacUpdate()
    } else {
      await autoUpdater.checkForUpdates()
    }
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
  // macOS downloads and installs through checkMacUpdate; electron-updater must not fetch on its own.
  autoUpdater.autoDownload = !isMac()
  autoUpdater.autoInstallOnAppQuit = !isMac()
  if (isMac()) {
    // Staged copies from earlier sessions are never installed (nothing restarts into them), so remove them.
    sweepStaleMacUpdates(join(app.getPath('userData'), 'updates'))
  }
  wireAutoUpdaterEvents()
  scheduleUpdateChecks()
}
