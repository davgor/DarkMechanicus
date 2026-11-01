/**
 * Registers the `chats:*` IPC channels and delivers pushed chat events to the window. Each channel
 * forwards its one payload argument to a handler that validates it (it arrives from the renderer
 * and is untrusted). Register through the sender guard (`guardIpc`), like every other channel.
 */
import type { IpcMain } from 'electron'
import { CHAT_EVENT_CHANNEL, type ChatPushEvent } from '../../shared/agents/chatApi'
import type { ChatHandlers } from './chatHandlers'

export function registerChatIpc(ipcMain: Pick<IpcMain, 'handle'>, handlers: ChatHandlers): void {
  ipcMain.handle('chats:list', (_event, folder: unknown) => handlers.list(folder))
  ipcMain.handle('chats:create', (_event, request: unknown) => handlers.create(request))
  ipcMain.handle('chats:startOrchestrator', (_event, request: unknown) => handlers.startOrchestrator(request))
  ipcMain.handle('chats:read', (_event, request: unknown) => handlers.read(request))
  ipcMain.handle('chats:boundThreads', (_event, request: unknown) => handlers.boundThreads(request))
  ipcMain.handle('chats:boundTerminal', (_event, request: unknown) => handlers.boundTerminal(request))
  ipcMain.handle('chats:rename', (_event, request: unknown) => handlers.rename(request))
  ipcMain.handle('chats:delete', (_event, request: unknown) => handlers.delete(request))
}

/** What the push needs of a `BrowserWindow`. */
export interface ChatWindow {
  isDestroyed(): boolean
  webContents: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void }
}

/** Sends each chat event to every open window (the app has one: its own page). */
export function createChatPush(windows: () => readonly ChatWindow[]): (event: ChatPushEvent) => void {
  return (event) => {
    for (const window of windows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(CHAT_EVENT_CHANNEL, event)
      }
    }
  }
}
