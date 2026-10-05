import { app, BrowserWindow, ipcMain, shell, type IpcMain } from 'electron'
import { join } from 'node:path'
import appIcon from '../../build/icon.png?asset'
import { SKILLS } from '../mcp/skills'
import { initAutoUpdate, registerAutoUpdateHandlers } from './autoUpdate'
import { startDesktopBridge } from './desktop/bootstrap'
import { hardenWebContents, resolveAppUrl } from './desktop/navigation'
import { guardIpc } from './ipcGuard'
import { logger, setupGlobalErrorLogging } from './logger'
import { disposeBeforeQuit } from './quitDisposal'
import { loadRendererContent, onActivateCreateWindow, onLastWindowClosed } from './windowPolicy'

setupGlobalErrorLogging()

/** The dev server in development (electron-vite sets it); otherwise the packaged page beside this bundle. */
const rendererUrl = process.env['ELECTRON_RENDERER_URL']
const rendererFile = join(__dirname, '../renderer/index.html')
/** The one page this app trusts: the window may only navigate within it, and IPC answers only it. */
const appUrl = resolveAppUrl(rendererUrl, rendererFile)
/** The longest quitting waits for agent processes to be disposed. */
const QUIT_DISPOSE_TIMEOUT_MS = 5_000

function openLinkInBrowser(url: string): void {
  shell.openExternal(url).catch((error: unknown) => {
    logger.warn('Could not open external link:', error)
  })
}

function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    // The theme's --bg (renderer styles.css), so nothing else shows before the page paints.
    backgroundColor: '#151211',
    title: 'Dark Mechanicus',
    icon: appIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Keep the configured title; otherwise the page's <title> replaces it on load.
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
  })

  hardenWebContents(mainWindow.webContents, {
    appUrl,
    openExternal: openLinkInBrowser
  })

  loadRendererContent(
    rendererUrl,
    (url) => {
      mainWindow.loadURL(url)
    },
    () => {
      mainWindow.loadFile(rendererFile)
    }
  )
  return mainWindow
}

function registerAppVersionHandler(ipc: Pick<IpcMain, 'handle'>): void {
  ipc.handle('app:getVersion', () => app.getVersion())
}

app.whenReady().then(() => {
  app.dock?.setIcon(appIcon)
  // Every IPC handler is registered through the guard: it answers only the app page's top frame.
  const ipc = guardIpc(ipcMain, {
    appUrl,
    onRefused: (channel, senderUrl) => {
      logger.warn(`Refused IPC call on ${channel} from ${senderUrl}`)
    }
  })
  registerAppVersionHandler(ipc)
  registerAutoUpdateHandlers(ipc)
  initAutoUpdate()
  const bridge = startDesktopBridge(SKILLS, ipc)
  // Agent chat processes are children of this app: dispose every one before it exits.
  disposeBeforeQuit(app, {
    busy: () => bridge.chats.liveCount() > 0,
    dispose: () => bridge.chats.disposeAll(),
    timeoutMs: QUIT_DISPOSE_TIMEOUT_MS,
    onError: (error) => {
      logger.error('Could not dispose agent chats on quit:', error)
    }
  })
  createMainWindow()

  app.on('activate', () => {
    onActivateCreateWindow(BrowserWindow.getAllWindows().length, createMainWindow)
  })
})

app.on('window-all-closed', () => {
  onLastWindowClosed(process.platform, () => {
    app.quit()
  })
})
