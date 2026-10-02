/**
 * Registers the narrow `dm:*` IPC surface. Each channel forwards its payload arguments to one
 * handler; the handlers validate them (they arrive from the renderer and are untrusted).
 */
import type { IpcMain } from 'electron'
import type { DesktopHandlers } from './handlers'

export function registerDesktopIpc(ipcMain: Pick<IpcMain, 'handle'>, handlers: DesktopHandlers): void {
  ipcMain.handle('dm:listFolders', () => handlers.listFolders())
  ipcMain.handle('dm:pickFolder', () => handlers.pickFolder())
  ipcMain.handle('dm:untrackFolder', (_event, path: unknown) => handlers.untrackFolder(path))
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
}
