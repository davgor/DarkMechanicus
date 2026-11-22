/**
 * Registers the narrow `dm:*` and `agents:*` IPC surface. Each channel forwards its payload arguments
 * to one handler; the handlers validate them (they arrive from the renderer and are untrusted).
 * The `agents:*` channels take an agent id (`find` and `download`: a built-in kind; the folder default
 * channels: a tracked folder and an agent id; `addCustom` and `updateCustom`: a custom CLI's name (and,
 * for an edit, its id) and arguments) and nothing else: never a path to execute and never a credential.
 */
import type { IpcMain } from 'electron'
import type { DesktopHandlers } from './handlers'
import type { KnowledgeHandlers } from './knowledgeHandlers'
import type { YoloHandlers } from './yoloHandlers'

export function registerDesktopIpc(ipcMain: Pick<IpcMain, 'handle'>, handlers: DesktopHandlers): void {
  ipcMain.handle('dm:listFolders', () => handlers.listFolders())
  ipcMain.handle('dm:pickFolder', (_event, mode: unknown) => handlers.pickFolder(mode))
  ipcMain.handle('dm:untrackFolder', (_event, path: unknown) => handlers.untrackFolder(path))
  ipcMain.handle('dm:openTrackedFolder', (_event, folder: unknown, expectedPath: unknown) => handlers.openTrackedFolder(folder, expectedPath))
  ipcMain.handle('dm:command', (_event, folder: unknown, name: unknown, input: unknown) =>
    handlers.command(folder, name, input)
  )
  ipcMain.handle('dm:getMcpConfig', (_event, folder: unknown) => handlers.getMcpConfig(folder))
  ipcMain.handle('dm:installSkills', (_event, folder: unknown) => handlers.installSkills(folder))
  ipcMain.handle('dm:connectClaudeCode', (_event, folder: unknown, request: unknown) =>
    handlers.connectClaudeCode(folder, request)
  )
  ipcMain.handle('dm:previewBoardRemoval', (_event, folder: unknown) => handlers.previewBoardRemoval(folder))
  ipcMain.handle('dm:removeBoardFiles', (_event, folder: unknown, paths: unknown) =>
    handlers.removeBoardFiles(folder, paths)
  )
  ipcMain.handle('dm:copyText', (_event, text: unknown) => handlers.copyText(text))
  ipcMain.handle('dm:openExternal', (_event, url: unknown) => handlers.openExternal(url))
  ipcMain.handle('agents:list', () => handlers.listAgents())
  ipcMain.handle('agents:find', (_event, kind: unknown) => handlers.findAgent(kind))
  ipcMain.handle('agents:remove', (_event, id: unknown) => handlers.removeAgent(id))
  ipcMain.handle('agents:addCustom', (_event, request: unknown) => handlers.addCustomAgent(request))
  ipcMain.handle('agents:updateCustom', (_event, request: unknown) => handlers.updateCustomAgent(request))
  ipcMain.handle('agents:download', (_event, kind: unknown) => handlers.downloadAgent(kind))
  ipcMain.handle('agents:status', (_event, id: unknown) => handlers.agentStatus(id))
  ipcMain.handle('agents:folderDefault', (_event, folder: unknown) => handlers.folderDefaultAgent(folder))
  ipcMain.handle('agents:ompTerminalTheme', () => handlers.ompTerminalTheme())
  ipcMain.handle('agents:setFolderDefault', (_event, request: unknown) => handlers.setFolderDefaultAgent(request))
}

/**
 * Registers the `knowledge:*` channels. Status takes a tracked folder; choosing and clearing the overall repository take
 * nothing, so its path only ever comes from the native folder picker in main.
 */
export function registerKnowledgeIpc(ipcMain: Pick<IpcMain, 'handle'>, handlers: KnowledgeHandlers): void {
  ipcMain.handle('knowledge:status', (_event, folder: unknown) => handlers.knowledgeStatus(folder))
  ipcMain.handle('knowledge:choose-repository', () => handlers.chooseKnowledgeRepository())
  ipcMain.handle('knowledge:clear-repository', () => handlers.clearKnowledgeRepository())
}

/** Native elevation remains a separate narrow surface, not a generic desktop command. */
export function registerYoloIpc(ipcMain: Pick<IpcMain, 'handle'>, handlers: YoloHandlers): void {
  ipcMain.handle('dm:yolo', (_event, folder: unknown, grantId: unknown, action: unknown) => handlers.yolo(folder, grantId, action))
}
