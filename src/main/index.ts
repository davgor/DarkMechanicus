import { app, BrowserWindow, ipcMain, shell, type IpcMain } from 'electron'
import { join } from 'node:path'
import { SKILLS } from '../mcp/skills'
import { initAutoUpdate, registerAutoUpdateHandlers } from './autoUpdate'
import { startDesktopBridge } from './desktop/bootstrap'
import { hardenWebContents, resolveAppUrl } from './desktop/navigation'
import { guardIpc } from './ipcGuard'
import { logger, setupGlobalErrorLogging } from './logger'
import { loadRendererContent, onActivateCreateWindow, onLastWindowClosed } from './windowPolicy'

setupGlobalErrorLogging()

/** The dev server in development (electron-vite sets it); otherwise the packaged page beside this bundle. */
const rendererUrl = process.env['ELECTRON_RENDERER_URL']
const rendererFile = join(__dirname, '../renderer/index.html')
/** The one page this app trusts: the window may only navigate within it, and IPC answers only it. */
const appUrl = resolveAppUrl(rendererUrl, rendererFile)

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
    backgroundColor: '#141310',
    title: 'Dark Mechanicus',
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
  startDesktopBridge(SKILLS, ipc)
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
