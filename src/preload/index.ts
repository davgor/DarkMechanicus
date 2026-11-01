import { contextBridge, ipcRenderer } from 'electron'
import { CHAT_EVENT_CHANNEL, type ChatPushEvent, type ChatsApi } from '../shared/agents/chatApi'
import type { AutoUpdateState } from '../shared/autoUpdate/types'
import type { AgentDownloadProgress, DmApi } from '../shared/desktop/api'
import { GIT_PROGRESS_CHANNEL, type GitApi, type GitProgressEvent } from '../shared/git/api'
import { GITHUB_ACCOUNT_CHANGED_CHANNEL, type GithubAccountView, type GithubApi } from '../shared/github/api'

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
  startTransferChat: (request) => ipcRenderer.invoke('chats:startTransferChat', request),
  findTransferChat: (request) => ipcRenderer.invoke('chats:findTransferChat', request),
  transferPrompt: (request) => ipcRenderer.invoke('chats:transferPrompt', request),
  open: (request) => ipcRenderer.invoke('chats:open', request),
  read: (request) => ipcRenderer.invoke('chats:read', request),
  send: (request) => ipcRenderer.invoke('chats:send', request),
  stop: (request) => ipcRenderer.invoke('chats:stop', request),
  threadBindings: (request) => ipcRenderer.invoke('chats:threadBindings', request),
  boundThreads: (request) => ipcRenderer.invoke('chats:boundThreads', request),
  retryTurn: (request) => ipcRenderer.invoke('chats:retryTurn', request),
  setModel: (request) => ipcRenderer.invoke('chats:setModel', request),
  rename: (request) => ipcRenderer.invoke('chats:rename', request),
  delete: (request) => ipcRenderer.invoke('chats:delete', request),
  answerApproval: (request) => ipcRenderer.invoke('chats:answerApproval', request),
  models: (agent) => ipcRenderer.invoke('chats:models', agent),
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
  removeAgent: (id) => ipcRenderer.invoke('agents:remove', id),
  addCustomAgent: (request) => ipcRenderer.invoke('agents:addCustom', request),
  updateCustomAgent: (request) => ipcRenderer.invoke('agents:updateCustom', request),
  downloadAgent: (kind) => ipcRenderer.invoke('agents:download', kind),
  onAgentDownloadProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: AgentDownloadProgress): void => {
      listener(progress)
    }
    ipcRenderer.on('agents:downloadProgress', handler)
    return () => ipcRenderer.removeListener('agents:downloadProgress', handler)
  },
  agentStatus: (id) => ipcRenderer.invoke('agents:status', id),
  signInAgent: (id) => ipcRenderer.invoke('agents:signIn', id),
  folderDefaultAgent: (folder) => ipcRenderer.invoke('agents:folderDefault', folder),
  setFolderDefaultAgent: (request) => ipcRenderer.invoke('agents:setFolderDefault', request)
}

contextBridge.exposeInMainWorld('dm', dm)

/** Source control: every method is one `git:*` IPC invoke; main validates each payload. */
const git: GitApi = {
  getState: (folder) => ipcRenderer.invoke('git:getState', folder),
  getWorkingDiff: (folder, request) => ipcRenderer.invoke('git:getWorkingDiff', folder, request),
  initRepository: (folder) => ipcRenderer.invoke('git:initRepository', folder),
  commit: (folder, request) => ipcRenderer.invoke('git:commit', folder, request),
  undoLastCommit: (folder) => ipcRenderer.invoke('git:undoLastCommit', folder),
  discardChanges: (folder, request) => ipcRenderer.invoke('git:discardChanges', folder, request),
  getHistory: (folder, request) => ipcRenderer.invoke('git:getHistory', folder, request),
  getCommitFiles: (folder, oid) => ipcRenderer.invoke('git:getCommitFiles', folder, oid),
  getCommitDiff: (folder, request) => ipcRenderer.invoke('git:getCommitDiff', folder, request),
  fetch: (folder, request) => ipcRenderer.invoke('git:fetch', folder, request),
  pull: (folder, request) => ipcRenderer.invoke('git:pull', folder, request),
  push: (folder, request) => ipcRenderer.invoke('git:push', folder, request),
  cancelOperation: (folder, operationId) => ipcRenderer.invoke('git:cancelOperation', folder, operationId),
  getCloneParent: () => ipcRenderer.invoke('git:getCloneParent'),
  chooseCloneParent: () => ipcRenderer.invoke('git:chooseCloneParent'),
  clone: (request) => ipcRenderer.invoke('git:clone', request),
  listBranches: (folder) => ipcRenderer.invoke('git:listBranches', folder),
  checkBranchName: (folder, name) => ipcRenderer.invoke('git:checkBranchName', folder, name),
  createBranch: (folder, request) => ipcRenderer.invoke('git:createBranch', folder, request),
  switchBranch: (folder, request) => ipcRenderer.invoke('git:switchBranch', folder, request),
  renameBranch: (folder, request) => ipcRenderer.invoke('git:renameBranch', folder, request),
  deleteBranch: (folder, request) => ipcRenderer.invoke('git:deleteBranch', folder, request),
  mergeIntoCurrent: (folder, request) => ipcRenderer.invoke('git:mergeIntoCurrent', folder, request),
  listStashes: (folder) => ipcRenderer.invoke('git:listStashes', folder),
  restoreStash: (folder, ref) => ipcRenderer.invoke('git:restoreStash', folder, ref),
  discardStash: (folder, ref) => ipcRenderer.invoke('git:discardStash', folder, ref),
  getConflicts: (folder) => ipcRenderer.invoke('git:getConflicts', folder),
  resolveWith: (folder, request) => ipcRenderer.invoke('git:resolveWith', folder, request),
  markResolved: (folder, request) => ipcRenderer.invoke('git:markResolved', folder, request),
  abortMerge: (folder) => ipcRenderer.invoke('git:abortMerge', folder),
  commitMerge: (folder, request) => ipcRenderer.invoke('git:commitMerge', folder, request),
  abortOperation: (folder) => ipcRenderer.invoke('git:abortOperation', folder),
  openInEditor: (folder, path) => ipcRenderer.invoke('git:openInEditor', folder, path),
  getPullRequests: (folder, request) => ipcRenderer.invoke('git:getPullRequests', folder, request),
  checkoutPullRequest: (folder, request) => ipcRenderer.invoke('git:checkoutPullRequest', folder, request),
  getCompareUrl: (folder) => ipcRenderer.invoke('git:getCompareUrl', folder),
  getCommitUrl: (folder, oid) => ipcRenderer.invoke('git:getCommitUrl', folder, oid),
  onProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: GitProgressEvent): void => {
      listener(event)
    }
    ipcRenderer.on(GIT_PROGRESS_CHANNEL, handler)
    return () => ipcRenderer.removeListener(GIT_PROGRESS_CHANNEL, handler)
  }
}

contextBridge.exposeInMainWorld('git', git)

/** GitHub: one `github:*` invoke per method; only the repository list takes an argument. The token never reaches this side. */
const github: GithubApi = {
  getAccount: () => ipcRenderer.invoke('github:getAccount'),
  signIn: () => ipcRenderer.invoke('github:signIn'),
  signOut: () => ipcRenderer.invoke('github:signOut'),
  listRepositories: (request) => ipcRenderer.invoke('github:listRepositories', request),
  onAccountChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, account: GithubAccountView | null): void => {
      listener(account)
    }
    ipcRenderer.on(GITHUB_ACCOUNT_CHANGED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(GITHUB_ACCOUNT_CHANGED_CHANNEL, handler)
  }
}

contextBridge.exposeInMainWorld('github', github)
