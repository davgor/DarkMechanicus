import { contextBridge, ipcRenderer } from 'electron'
import type { AutoUpdateState } from '../shared/autoUpdate/types'

const autoUpdate = {
  getState: (): Promise<AutoUpdateState> => ipcRenderer.invoke('autoUpdate:getState'),
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('autoUpdate:checkForUpdates'),
  quitAndInstall: (): Promise<void> => ipcRenderer.invoke('autoUpdate:quitAndInstall'),
  onEvent: (listener: (state: AutoUpdateState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AutoUpdateState): void => {
      listener(state)
    }
    ipcRenderer.on('autoUpdate:event', handler)
    return () => ipcRenderer.removeListener('autoUpdate:event', handler)
  }
}

const appInfo = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion')
}

contextBridge.exposeInMainWorld('autoUpdate', autoUpdate)
contextBridge.exposeInMainWorld('appInfo', appInfo)

export type AutoUpdateApi = typeof autoUpdate
export type AppInfoApi = typeof appInfo
