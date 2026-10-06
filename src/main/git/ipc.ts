/**
 * Registers the `git:*` IPC channels and broadcasts git progress to the windows. Each channel forwards
 * its payload arguments to a handler that validates them (they arrive from the renderer and are
 * untrusted). Register through the sender guard (`guardIpc`), like every other channel.
 */
import type { IpcMain } from 'electron'
import { GIT_PROGRESS_CHANNEL, type GitProgressEvent } from '../../shared/git/api'
import type { GitHandlers } from './handlers'

export function registerGitIpc(ipcMain: Pick<IpcMain, 'handle'>, handlers: GitHandlers): void {
  ipcMain.handle('git:getState', (_event, folder: unknown) => handlers.getState(folder))
  ipcMain.handle('git:getWorkingDiff', (_event, folder: unknown, request: unknown) => handlers.getWorkingDiff(folder, request))
  ipcMain.handle('git:initRepository', (_event, folder: unknown) => handlers.initRepository(folder))
  ipcMain.handle('git:commit', (_event, folder: unknown, request: unknown) => handlers.commit(folder, request))
  ipcMain.handle('git:undoLastCommit', (_event, folder: unknown) => handlers.undoLastCommit(folder))
  ipcMain.handle('git:getHistory', (_event, folder: unknown, request: unknown) => handlers.getHistory(folder, request))
  ipcMain.handle('git:getCommitFiles', (_event, folder: unknown, oid: unknown) => handlers.getCommitFiles(folder, oid))
  ipcMain.handle('git:getCommitDiff', (_event, folder: unknown, request: unknown) => handlers.getCommitDiff(folder, request))
  ipcMain.handle('git:discardChanges', (_event, folder: unknown, request: unknown) => handlers.discardChanges(folder, request))
}

/** What the broadcaster needs of a `BrowserWindow`. */
interface GitWindow {
  isDestroyed(): boolean
  webContents: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void }
}

/** Sends each progress event to every open window on `git:progress`. Later operations call it. */
export function createProgressBroadcaster(windows: () => readonly GitWindow[]): (event: GitProgressEvent) => void {
  return (event) => {
    for (const window of windows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(GIT_PROGRESS_CHANNEL, event)
      }
    }
  }
}
