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
  ipcMain.handle('git:fetch', (_event, folder: unknown, request: unknown) => handlers.fetch(folder, request))
  ipcMain.handle('git:pull', (_event, folder: unknown, request: unknown) => handlers.pull(folder, request))
  ipcMain.handle('git:push', (_event, folder: unknown, request: unknown) => handlers.push(folder, request))
  ipcMain.handle('git:cancelOperation', (_event, folder: unknown, operationId: unknown) => handlers.cancelOperation(folder, operationId))
  ipcMain.handle('git:getCloneParent', () => handlers.getCloneParent())
  ipcMain.handle('git:chooseCloneParent', () => handlers.chooseCloneParent())
  ipcMain.handle('git:clone', (_event, request: unknown) => handlers.clone(request))
  ipcMain.handle('git:listBranches', (_event, folder: unknown) => handlers.listBranches(folder))
  ipcMain.handle('git:checkBranchName', (_event, folder: unknown, name: unknown) => handlers.checkBranchName(folder, name))
  ipcMain.handle('git:createBranch', (_event, folder: unknown, request: unknown) => handlers.createBranch(folder, request))
  ipcMain.handle('git:switchBranch', (_event, folder: unknown, request: unknown) => handlers.switchBranch(folder, request))
  ipcMain.handle('git:renameBranch', (_event, folder: unknown, request: unknown) => handlers.renameBranch(folder, request))
  ipcMain.handle('git:deleteBranch', (_event, folder: unknown, request: unknown) => handlers.deleteBranch(folder, request))
  ipcMain.handle('git:mergeIntoCurrent', (_event, folder: unknown, request: unknown) => handlers.mergeIntoCurrent(folder, request))
  ipcMain.handle('git:listStashes', (_event, folder: unknown) => handlers.listStashes(folder))
  ipcMain.handle('git:restoreStash', (_event, folder: unknown, ref: unknown) => handlers.restoreStash(folder, ref))
  ipcMain.handle('git:discardStash', (_event, folder: unknown, ref: unknown) => handlers.discardStash(folder, ref))
  ipcMain.handle('git:getConflicts', (_event, folder: unknown) => handlers.getConflicts(folder))
  ipcMain.handle('git:resolveWith', (_event, folder: unknown, request: unknown) => handlers.resolveWith(folder, request))
  ipcMain.handle('git:markResolved', (_event, folder: unknown, request: unknown) => handlers.markResolved(folder, request))
  ipcMain.handle('git:abortMerge', (_event, folder: unknown) => handlers.abortMerge(folder))
  ipcMain.handle('git:commitMerge', (_event, folder: unknown, request: unknown) => handlers.commitMerge(folder, request))
  ipcMain.handle('git:abortOperation', (_event, folder: unknown) => handlers.abortOperation(folder))
  ipcMain.handle('git:openInEditor', (_event, folder: unknown, path: unknown) => handlers.openInEditor(folder, path))
  ipcMain.handle('git:getPullRequests', (_event, folder: unknown, request: unknown) => handlers.getPullRequests(folder, request))
  ipcMain.handle('git:checkoutPullRequest', (_event, folder: unknown, request: unknown) => handlers.checkoutPullRequest(folder, request))
  ipcMain.handle('git:getCompareUrl', (_event, folder: unknown) => handlers.getCompareUrl(folder))
  ipcMain.handle('git:getCommitUrl', (_event, folder: unknown, oid: unknown) => handlers.getCommitUrl(folder, oid))
}

/** What the broadcaster needs of a `BrowserWindow`. */
interface GitWindow {
  isDestroyed(): boolean
  webContents: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void }
}

/** Sends each progress event to every open window on `git:progress`. */
export function createProgressBroadcaster(windows: () => readonly GitWindow[]): (event: GitProgressEvent) => void {
  return (event) => {
    for (const window of windows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(GIT_PROGRESS_CHANNEL, event)
      }
    }
  }
}
