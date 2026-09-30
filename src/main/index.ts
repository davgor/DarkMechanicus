import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { initAutoUpdate, registerAutoUpdateHandlers } from './autoUpdate'
import { startDesktopBridge } from './desktop/bootstrap'
import { hardenWebContents, resolveAppUrl } from './desktop/navigation'
import { logger, setupGlobalErrorLogging } from './logger'
import { loadRendererContent, onActivateCreateWindow, onLastWindowClosed } from './windowPolicy'
// TODO(integrator): replace this empty list with `import { SKILLS } from '../mcp/skills'` once
// src/mcp/skills.ts exists (its entries already satisfy the SkillDefinition shape).
const SKILLS: { name: string; description: string; body: string }[] = []

setupGlobalErrorLogging()

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

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const rendererFile = join(__dirname, '../renderer/index.html')
  hardenWebContents(mainWindow.webContents, {
    appUrl: resolveAppUrl(rendererUrl, rendererFile),
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

function registerAppVersionHandler(): void {
  ipcMain.handle('app:getVersion', () => app.getVersion())
}

app.whenReady().then(() => {
  registerAppVersionHandler()
  registerAutoUpdateHandlers()
  initAutoUpdate()
  startDesktopBridge(SKILLS)
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
