import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { initAutoUpdate, registerAutoUpdateHandlers } from './autoUpdate'
import { setupGlobalErrorLogging } from './logger'
import { loadRendererContent, onActivateCreateWindow, onLastWindowClosed } from './windowPolicy'

setupGlobalErrorLogging()

function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  loadRendererContent(
    process.env['ELECTRON_RENDERER_URL'],
    (url) => {
      mainWindow.loadURL(url)
    },
    () => {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
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
