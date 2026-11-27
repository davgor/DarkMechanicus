import { contextBridge, ipcRenderer } from 'electron'
import {
  CHAT_EVENT_CHANNEL,
  CHAT_MAIL_EVENT_CHANNEL,
  type ChatMailApi,
  type ChatMailPushEvent,
  type ChatPushEvent,
  type ChatsApi
} from '../shared/agents/chatApi'
import { CULT_EVENT_CHANNEL, type CultPushEvent, type CultsApi } from '../shared/cults/cultApi'
import { AGENT_CHAT_CHANNELS, agentChatEventSchema, type AgentChatApi, type AgentChatEvent } from '../shared/agents/agentChat'
import type { AutoUpdateState } from '../shared/autoUpdate/types'
import type { AgentDownloadProgress, DmApi } from '../shared/desktop/api'
import type { CrossRepoCorrectionsApi } from '../shared/desktop/crossRepoCorrections'
import { SETTINGS_CHANNELS, type SettingsApi } from '../shared/desktop/notificationSettings'
import { NOTIFICATION_CHANNELS, navigateTargetSchema, type NotificationsApi } from '../shared/desktop/notifications'
import type { SourceCheckoutApi } from '../shared/desktop/sourceCheckout'
import { GIT_PROGRESS_CHANNEL, type GitApi, type GitProgressEvent } from '../shared/git/api'
import { GITHUB_ACCOUNT_CHANGED_CHANNEL, type GithubAccountView, type GithubApi } from '../shared/github/api'
import { createTerminalsApi } from './terminals'

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

/** Chat mailboxes as the person sees them: one `chatMail:*` invoke per method, plus metadata-only pushes. */
const mail: ChatMailApi = {
  snapshot: (folder) => ipcRenderer.invoke('chatMail:snapshot', folder),
  state: (request) => ipcRenderer.invoke('chatMail:state', request),
  read: (request) => ipcRenderer.invoke('chatMail:read', request),
  conversation: (request) => ipcRenderer.invoke('chatMail:conversation', request),
  markSeen: (request) => ipcRenderer.invoke('chatMail:markSeen', request),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: ChatMailPushEvent): void => {
      listener(event)
    }
    ipcRenderer.on(CHAT_MAIL_EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(CHAT_MAIL_EVENT_CHANNEL, handler)
  }
}

/** Agent chats: one `chats:*` invoke per request (main validates each payload), plus the pushed list changes and `mail`. */
const chats: ChatsApi = {
  list: (folder) => ipcRenderer.invoke('chats:list', folder),
  listAll: () => ipcRenderer.invoke('chats:listAll'),
  create: (request) => ipcRenderer.invoke('chats:create', request),
  startOrchestrator: (request) => ipcRenderer.invoke('chats:startOrchestrator', request),
  startTransferChat: (request) => ipcRenderer.invoke('chats:startTransferChat', request),
  startPlanner: (request) => ipcRenderer.invoke('chats:startPlanner', request),
  startKanbanCard: (request) => ipcRenderer.invoke('chats:startKanbanCard', request),
  kickBackKanbanCard: (request) => ipcRenderer.invoke('chats:kickBackKanbanCard', request),
  sendConversationMessage: (request) => ipcRenderer.invoke('chats:sendConversationMessage', request),
  conversationState: (request) => ipcRenderer.invoke('chats:conversationState', request),
  findTransferChat: (request) => ipcRenderer.invoke('chats:findTransferChat', request),
  transferPrompt: (request) => ipcRenderer.invoke('chats:transferPrompt', request),
  read: (request) => ipcRenderer.invoke('chats:read', request),
  boundThreads: (request) => ipcRenderer.invoke('chats:boundThreads', request),
  boundTerminal: (request) => ipcRenderer.invoke('chats:boundTerminal', request),
  rename: (request) => ipcRenderer.invoke('chats:rename', request),
  delete: (request) => ipcRenderer.invoke('chats:delete', request),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: ChatPushEvent): void => {
      listener(event)
    }
    ipcRenderer.on(CHAT_EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(CHAT_EVENT_CHANNEL, handler)
  },
  mail
}

/** Cults: one `cults:*` invoke per request (main validates each argument), plus the pushed run snapshots. */
const cults: CultsApi = {
  list: () => ipcRenderer.invoke('cults:list'),
  get: (cultId) => ipcRenderer.invoke('cults:get', cultId),
  create: (input) => ipcRenderer.invoke('cults:create', input),
  update: (cultId, input) => ipcRenderer.invoke('cults:update', cultId, input),
  delete: (cultId) => ipcRenderer.invoke('cults:delete', cultId),
  models: (refresh) => ipcRenderer.invoke('cults:models', refresh),
  archetypes: () => ipcRenderer.invoke('cults:archetypes'),
  start: (cultId, overrides) => ipcRenderer.invoke('cults:start', cultId, overrides),
  pause: (runId) => ipcRenderer.invoke('cults:pause', runId),
  resume: (runId) => ipcRenderer.invoke('cults:resume', runId),
  stop: (runId) => ipcRenderer.invoke('cults:stop', runId),
  killNow: (runId) => ipcRenderer.invoke('cults:killNow', runId),
  raiseCap: (runId, cap) => ipcRenderer.invoke('cults:raiseCap', runId, cap),
  decidePetition: (petitionId, approve, granted) => ipcRenderer.invoke('cults:decidePetition', petitionId, approve, granted),
  dismissAcolyte: (runId, chatId) => ipcRenderer.invoke('cults:dismissAcolyte', runId, chatId),
  runs: (cultId) => ipcRenderer.invoke('cults:runs', cultId),
  pipeline: (runId, request) => ipcRenderer.invoke('cults:pipeline', runId, request),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: CultPushEvent): void => {
      listener(event)
    }
    ipcRenderer.on(CULT_EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(CULT_EVENT_CHANNEL, handler)
  }
}

/**
 * Every agent-chat view shares one IPC listener, held while any view listens: each push is parsed once and handed to
 * each view, so the channel's listener count stays at one however many chats are open.
 */
const agentChatListeners = new Set<(event: AgentChatEvent) => void>()
function forwardAgentChatEvent(_event: Electron.IpcRendererEvent, event: unknown): void {
  const parsed = agentChatEventSchema.safeParse(event)
  if (parsed.success) for (const listener of agentChatListeners) listener(parsed.data)
}

const agentChat: AgentChatApi = {
  start: (request) => ipcRenderer.invoke(AGENT_CHAT_CHANNELS.start, request),
  send: (request) => ipcRenderer.invoke(AGENT_CHAT_CHANNELS.send, request),
  interrupt: (request) => ipcRenderer.invoke(AGENT_CHAT_CHANNELS.interrupt, request),
  stop: (request) => ipcRenderer.invoke(AGENT_CHAT_CHANNELS.stop, request),
  answer: (request) => ipcRenderer.invoke(AGENT_CHAT_CHANNELS.answer, request),
  setSurface: (request) => ipcRenderer.invoke(AGENT_CHAT_CHANNELS.setSurface, request),
  snapshot: (request) => ipcRenderer.invoke(AGENT_CHAT_CHANNELS.snapshot, request),
  onEvent: (listener) => {
    // A fresh wrapper per call, so one function subscribed twice is two subscriptions.
    const subscription = (event: AgentChatEvent): void => listener(event)
    if (agentChatListeners.size === 0) ipcRenderer.on(AGENT_CHAT_CHANNELS.event, forwardAgentChatEvent)
    agentChatListeners.add(subscription)
    return () => {
      if (agentChatListeners.delete(subscription) && agentChatListeners.size === 0) {
        ipcRenderer.removeListener(AGENT_CHAT_CHANNELS.event, forwardAgentChatEvent)
      }
    }
  },
  models: (request) => ipcRenderer.invoke(AGENT_CHAT_CHANNELS.models, request),
  setModel: (request) => ipcRenderer.invoke(AGENT_CHAT_CHANNELS.setModel, request),
  attention: (request) => ipcRenderer.invoke(AGENT_CHAT_CHANNELS.attention, request),
  stageImage: (request) => ipcRenderer.invoke(AGENT_CHAT_CHANNELS.stageImage, request),
  attachEvidence: (request) => ipcRenderer.invoke(AGENT_CHAT_CHANNELS.attachEvidence, request)
}

/** The local Dark Mechanicus source checkout: `pick` takes nothing (main shows the dialog), `associate` a tracked folder. */
const sourceCheckout: SourceCheckoutApi = {
  get: () => ipcRenderer.invoke('sourceCheckout:get'),
  pick: () => ipcRenderer.invoke('sourceCheckout:pick'),
  associate: (folder) => ipcRenderer.invoke('sourceCheckout:associate', folder),
  clear: () => ipcRenderer.invoke('sourceCheckout:clear')
}

/** Corrective work a folder's retro asks of the chosen Dark Mechanicus checkout; the renderer never names the target. */
const crossRepoCorrections: CrossRepoCorrectionsApi = {
  preview: (folder, input) => ipcRenderer.invoke('corrections:previewCrossRepo', folder, input),
  create: (folder, input) => ipcRenderer.invoke('corrections:createCrossRepo', folder, input),
  retry: (folder, key) => ipcRenderer.invoke('corrections:retryCrossRepo', folder, key),
  withdraw: (folder, input) => ipcRenderer.invoke('corrections:withdrawCrossRepo', folder, input),
  list: (folder, filter) => ipcRenderer.invoke('corrections:listCrossRepo', folder, filter),
  collectResults: (folder, key) => ipcRenderer.invoke('corrections:collectCrossRepo', folder, key)
}

/** The notification and approval settings: main validates `next` and asks the person to confirm a loosening change. */
const settings: SettingsApi = {
  getNotifications: () => ipcRenderer.invoke(SETTINGS_CHANNELS.getNotifications),
  setNotifications: (next) => ipcRenderer.invoke(SETTINGS_CHANNELS.setNotifications, next)
}

/** OS notifications: `raise` sends ids only (main reads every title); a navigate push that is not a valid target is dropped. */
const notifications: NotificationsApi = {
  raise: (request) => ipcRenderer.invoke(NOTIFICATION_CHANNELS.raise, request),
  onNavigate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, target: unknown): void => {
      const parsed = navigateTargetSchema.safeParse(target)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(NOTIFICATION_CHANNELS.navigate, handler)
    return () => ipcRenderer.removeListener(NOTIFICATION_CHANNELS.navigate, handler)
  }
}

/**
 * The narrow desktop bridge: every method is one `dm:*`, `agents:*` or `knowledge:*` IPC invoke; main validates each payload.
 * `terminals` adds `terminals:attach`, `agents:signIn` and the port main posts for a running chat or sign-in terminal;
 * `sourceCheckout` the `sourceCheckout:*` channels; `crossRepoCorrections` the `corrections:*CrossRepo` channels.
 */
const dm: DmApi = {
  agentChat,
  forgeSetup: {
    provision: (input, operationId) => ipcRenderer.invoke('forgeSetup:provision', input, operationId),
    provisioning: () => ipcRenderer.invoke('forgeSetup:provisioning'),
    resumeProvision: id => ipcRenderer.invoke('forgeSetup:resumeProvision', id),
    recipebook: world => ipcRenderer.invoke('forgeSetup:recipebook', world),
    saveRecipebook: (world, edit) => ipcRenderer.invoke('forgeSetup:saveRecipebook', world, edit),
    project: member => ipcRenderer.invoke('forgeSetup:project', member),
    saveWorkflow: (member, edit) => ipcRenderer.invoke('forgeSetup:saveWorkflow', member, edit),
    refresh: member => ipcRenderer.invoke('forgeSetup:refresh', member),
    prepare: (member, agent) => ipcRenderer.invoke('forgeSetup:prepare', member, agent),
    run: (member, expectedSha256, expectedCheckout) => ipcRenderer.invoke('forgeSetup:run', member, expectedSha256, expectedCheckout)
  },
  forge: {
    memberStatus: (root, member) => ipcRenderer.invoke('forge:memberStatus', root, member),
    connect: (folder, repository, publish) => ipcRenderer.invoke('forge:connect', folder, repository, publish),
    restore: (member, mode) => ipcRenderer.invoke('forge:restore', member, mode),
    pickConvert: world => ipcRenderer.invoke('forge:pickConvert', world),
    convert: (world, source, options) => options === undefined
      ? ipcRenderer.invoke('forge:convert', world, source)
      : ipcRenderer.invoke('forge:convert', world, source, options),
    status: folder => ipcRenderer.invoke('forge:status', folder),
    sync: folder => ipcRenderer.invoke('forge:sync', folder),
    create: (folder) => ipcRenderer.invoke('forge:create', folder),
    add: (folder, repository, name) => ipcRenderer.invoke('forge:add', folder, repository, name),
    interval: (folder, minutes) => ipcRenderer.invoke('forge:interval', folder, minutes)
  },
  setTelegramEnabled: (enabled) => ipcRenderer.invoke('telegram:setEnabled', enabled),
  telegramStatus: () => ipcRenderer.invoke('telegram:status'),
  pairTelegram: () => ipcRenderer.invoke('telegram:pair'),
  chats,
  cults,
  terminals: createTerminalsApi(ipcRenderer),
  sourceCheckout,
  crossRepoCorrections,
  settings,
  listFolders: () => ipcRenderer.invoke('dm:listFolders'),
  onFoldersChanged: (receive) => {
    const handler = (): void => receive()
    ipcRenderer.on('forge:foldersChanged', handler)
    return () => ipcRenderer.removeListener('forge:foldersChanged', handler)
  },
  pickFolder: (mode) => ipcRenderer.invoke('dm:pickFolder', mode),
  untrackFolder: (path) => ipcRenderer.invoke('dm:untrackFolder', path),
  openTrackedFolder: (folder, expectedPath) => ipcRenderer.invoke('dm:openTrackedFolder', folder, expectedPath),
  command: (folder, name, input) => ipcRenderer.invoke('dm:command', folder, name, input),
  approveLearningCard: (folder, input) => ipcRenderer.invoke('dm:approveLearningCard', folder, input),
  getMcpConfig: (folder) => ipcRenderer.invoke('dm:getMcpConfig', folder),
  installSkills: (folder) => ipcRenderer.invoke('dm:installSkills', folder),
  connectClaudeCode: (folder, request) => ipcRenderer.invoke('dm:connectClaudeCode', folder, request),
  previewBoardRemoval: (folder) => ipcRenderer.invoke('dm:previewBoardRemoval', folder),
  removeBoardFiles: (folder, paths) => ipcRenderer.invoke('dm:removeBoardFiles', folder, paths),
  yolo: (folder, grantId, action) => ipcRenderer.invoke('dm:yolo', folder, grantId, action),
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
  folderDefaultAgent: (folder) => ipcRenderer.invoke('agents:folderDefault', folder),
  ompTerminalTheme: () => ipcRenderer.invoke('agents:ompTerminalTheme'),
  setFolderDefaultAgent: (request) => ipcRenderer.invoke('agents:setFolderDefault', request),
  knowledgeStatus: (folder) => ipcRenderer.invoke('knowledge:status', folder),
  chooseKnowledgeRepository: () => ipcRenderer.invoke('knowledge:choose-repository'),
  clearKnowledgeRepository: () => ipcRenderer.invoke('knowledge:clear-repository'),
  notifications
}

contextBridge.exposeInMainWorld('dm', dm)

/** Source control: every method is one `git:*` IPC invoke; main validates each payload. */
const git: GitApi = {
  getTarget: (folder) => ipcRenderer.invoke('git:getTarget', folder),
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
