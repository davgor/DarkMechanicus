/**
 * Registers the `github:*` IPC channels and broadcasts account changes to the windows. No channel
 * takes an argument from the renderer, and the broadcast is rebuilt field by field so nothing but the
 * login and name can reach a window. Register through the sender guard (`guardIpc`), like every other
 * channel.
 */
import type { IpcMain } from 'electron'
import { GITHUB_ACCOUNT_CHANGED_CHANNEL, type GithubAccountView } from '../../shared/github/api'
import type { GithubHandlers } from './handlers'

export function registerGithubIpc(ipcMain: Pick<IpcMain, 'handle'>, handlers: GithubHandlers): void {
  ipcMain.handle('github:getAccount', () => handlers.getAccount())
  ipcMain.handle('github:signIn', () => handlers.signIn())
  ipcMain.handle('github:signOut', () => handlers.signOut())
}

/** What the broadcaster needs of a `BrowserWindow`. */
interface GithubWindow {
  isDestroyed(): boolean
  webContents: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void }
}

interface GithubBroadcaster {
  accountChanged(account: GithubAccountView | null): void
}

export function createGithubBroadcaster(windows: () => readonly GithubWindow[]): GithubBroadcaster {
  return {
    accountChanged: (account) => {
      const payload = account === null ? null : { login: account.login, name: account.name }
      for (const window of windows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(GITHUB_ACCOUNT_CHANGED_CHANNEL, payload)
        }
      }
    }
  }
}
