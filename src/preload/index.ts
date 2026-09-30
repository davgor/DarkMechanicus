import { contextBridge, ipcRenderer } from 'electron'
import type { AutoUpdateState } from '../shared/autoUpdate/types'
import type { DmApi } from '../shared/desktop/api'

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

/** The narrow desktop bridge: every method is one `dm:*` IPC invoke; main validates each payload. */
const dm: DmApi = {
  listFolders: () => ipcRenderer.invoke('dm:listFolders'),
  pickFolder: () => ipcRenderer.invoke('dm:pickFolder'),
  untrackFolder: (path) => ipcRenderer.invoke('dm:untrackFolder', path),
  command: (folder, name, input) => ipcRenderer.invoke('dm:command', folder, name, input),
  getMcpConfig: (folder) => ipcRenderer.invoke('dm:getMcpConfig', folder),
  installSkills: (folder) => ipcRenderer.invoke('dm:installSkills', folder),
  copyText: (text) => ipcRenderer.invoke('dm:copyText', text),
  openExternal: (url) => ipcRenderer.invoke('dm:openExternal', url)
}

contextBridge.exposeInMainWorld('dm', dm)
