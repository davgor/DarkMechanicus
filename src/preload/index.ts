import { contextBridge, ipcRenderer } from 'electron'
import { CHAT_EVENT_CHANNEL, type ChatPushEvent, type ChatsApi } from '../shared/agents/chatApi'
import type { AutoUpdateState } from '../shared/autoUpdate/types'
import type { AgentDownloadProgress, DmApi } from '../shared/desktop/api'

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

/** Agent chats: one `chats:*` invoke per request (main validates each payload), plus pushed chat events. */
const chats: ChatsApi = {
  list: (folder) => ipcRenderer.invoke('chats:list', folder),
  create: (request) => ipcRenderer.invoke('chats:create', request),
  startOrchestrator: (request) => ipcRenderer.invoke('chats:startOrchestrator', request),
  open: (request) => ipcRenderer.invoke('chats:open', request),
  send: (request) => ipcRenderer.invoke('chats:send', request),
  stop: (request) => ipcRenderer.invoke('chats:stop', request),
  retryTurn: (request) => ipcRenderer.invoke('chats:retryTurn', request),
  setModel: (request) => ipcRenderer.invoke('chats:setModel', request),
  rename: (request) => ipcRenderer.invoke('chats:rename', request),
  delete: (request) => ipcRenderer.invoke('chats:delete', request),
  answerApproval: (request) => ipcRenderer.invoke('chats:answerApproval', request),
  models: (kind) => ipcRenderer.invoke('chats:models', kind),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: ChatPushEvent): void => {
      listener(event)
    }
    ipcRenderer.on(CHAT_EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(CHAT_EVENT_CHANNEL, handler)
  }
}

/** The narrow desktop bridge: every method is one `dm:*` or `agents:*` IPC invoke; main validates each payload. */
const dm: DmApi = {
  chats,
  listFolders: () => ipcRenderer.invoke('dm:listFolders'),
  pickFolder: () => ipcRenderer.invoke('dm:pickFolder'),
  untrackFolder: (path) => ipcRenderer.invoke('dm:untrackFolder', path),
  command: (folder, name, input) => ipcRenderer.invoke('dm:command', folder, name, input),
  getMcpConfig: (folder) => ipcRenderer.invoke('dm:getMcpConfig', folder),
  installSkills: (folder) => ipcRenderer.invoke('dm:installSkills', folder),
  connectClaudeCode: (folder, request) => ipcRenderer.invoke('dm:connectClaudeCode', folder, request),
  previewBoardRemoval: (folder) => ipcRenderer.invoke('dm:previewBoardRemoval', folder),
  removeBoardFiles: (folder, paths) => ipcRenderer.invoke('dm:removeBoardFiles', folder, paths),
  copyText: (text) => ipcRenderer.invoke('dm:copyText', text),
  openExternal: (url) => ipcRenderer.invoke('dm:openExternal', url),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  findAgent: (kind) => ipcRenderer.invoke('agents:find', kind),
  removeAgent: (kind) => ipcRenderer.invoke('agents:remove', kind),
  downloadAgent: (kind) => ipcRenderer.invoke('agents:download', kind),
  onAgentDownloadProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: AgentDownloadProgress): void => {
      listener(progress)
    }
    ipcRenderer.on('agents:downloadProgress', handler)
    return () => ipcRenderer.removeListener('agents:downloadProgress', handler)
  },
  agentStatus: (kind) => ipcRenderer.invoke('agents:status', kind),
  signInAgent: (kind) => ipcRenderer.invoke('agents:signIn', kind)
}

contextBridge.exposeInMainWorld('dm', dm)
