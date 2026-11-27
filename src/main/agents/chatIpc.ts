/**
 * Registers the `chats:*` and `chatMail:*` IPC channels and delivers pushed chat and chat mail events to the window.
 * Each channel forwards its one payload argument to a handler that validates it (it arrives from the renderer and is
 * untrusted). Register through the sender guard (`guardIpc`), like every other channel.
 */
import type { IpcMain } from 'electron'
import { CHAT_EVENT_CHANNEL, CHAT_MAIL_EVENT_CHANNEL, type ChatMailPushEvent, type ChatPushEvent } from '../../shared/agents/chatApi'
import type { ChatMailHandlers } from './agentMailDesktop'
import type { ChatHandlers } from './chatHandlers'

export function registerChatIpc(ipcMain: Pick<IpcMain, 'handle'>, handlers: ChatHandlers): void {
  ipcMain.handle('chats:list', (_event, folder: unknown) => handlers.list(folder))
  ipcMain.handle('chats:listAll', () => handlers.listAll())
  ipcMain.handle('chats:create', (_event, request: unknown) => handlers.create(request))
  ipcMain.handle('chats:startOrchestrator', (_event, request: unknown) => handlers.startOrchestrator(request))
  ipcMain.handle('chats:startTransferChat', (_event, request: unknown) => handlers.startTransferChat(request))
  ipcMain.handle('chats:startPlanner', (_event, request: unknown) => handlers.startPlanner(request))
  ipcMain.handle('chats:startKanbanCard', (_event, request: unknown) => handlers.startKanbanCard(request))
  ipcMain.handle('chats:kickBackKanbanCard', (_event, request: unknown) => handlers.kickBackKanbanCard(request))
  ipcMain.handle('chats:sendConversationMessage', (_event, request: unknown) => handlers.sendConversationMessage(request))
  ipcMain.handle('chats:conversationState', (_event, request: unknown) => handlers.conversationState(request))
  ipcMain.handle('chats:findTransferChat', (_event, request: unknown) => handlers.findTransferChat(request))
  ipcMain.handle('chats:transferPrompt', (_event, request: unknown) => handlers.transferPrompt(request))
  ipcMain.handle('chats:read', (_event, request: unknown) => handlers.read(request))
  ipcMain.handle('chats:boundThreads', (_event, request: unknown) => handlers.boundThreads(request))
  ipcMain.handle('chats:boundTerminal', (_event, request: unknown) => handlers.boundTerminal(request))
  ipcMain.handle('chats:rename', (_event, request: unknown) => handlers.rename(request))
  ipcMain.handle('chats:delete', (_event, request: unknown) => handlers.delete(request))
}

/** The person's side of chat mailboxes (`agentMailDesktop.ts`); bodies are only ever an invoke's answer, never pushed. */
export function registerChatMailIpc(ipcMain: Pick<IpcMain, 'handle'>, handlers: ChatMailHandlers): void {
  ipcMain.handle('chatMail:snapshot', (_event, folder: unknown) => handlers.snapshot(folder))
  ipcMain.handle('chatMail:state', (_event, request: unknown) => handlers.state(request))
  ipcMain.handle('chatMail:read', (_event, request: unknown) => handlers.read(request))
  ipcMain.handle('chatMail:markSeen', (_event, request: unknown) => handlers.markSeen(request))
}

/** What the push needs of a `BrowserWindow`. */
export interface ChatWindow {
  isDestroyed(): boolean
  webContents: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void }
}

export function sendToWindows(windows: readonly ChatWindow[], channel: string, event: unknown): void {
  for (const window of windows) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, event)
    }
  }
}

/** Sends each chat event to every open window (the app has one: its own page). */
export function createChatPush(windows: () => readonly ChatWindow[]): (event: ChatPushEvent) => void {
  return (event) => sendToWindows(windows(), CHAT_EVENT_CHANNEL, event)
}

/** Sends each chat mail event (metadata only) to every open window on `chatMail:event`. */
export function createChatMailPush(windows: () => readonly ChatWindow[]): (event: ChatMailPushEvent) => void {
  return (event) => sendToWindows(windows(), CHAT_MAIL_EVENT_CHANNEL, event)
}
