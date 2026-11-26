/**
 * Where a clicked OS notification lands. Main pushes a validated `NavigateTarget` (`window.dm.notifications.onNavigate`);
 * the shell subscribes once and opens the chat that holds the card, the epic's Agent tab or its checkpoint.
 */
import { useEffect } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { NavigateTarget } from '../../../shared/desktop/notifications'
import { sameFolder } from '../../../shared/git/paths'
import type { ShellActions } from './shellActions'
import { useLatest } from './useLatest'

type NavigateActions = Pick<ShellActions, 'selectFolder' | 'selectEpic' | 'selectChat' | 'openThread' | 'openChat' | 'openEpicAgent' | 'openEpicCheckpoint'>

interface NavigateContext {
  folders: readonly TrackedFolderView[]
  /** Every loaded chat: those of the tracked folders and the project-less ones. */
  chats: readonly ChatRecord[]
  actions: NavigateActions
}

/** The tracked folder a target names, as the shell spells it; null for a folder that is not tracked. */
function trackedPath(folders: readonly TrackedFolderView[], folder: string): string | null {
  return folders.find((tracked) => sameFolder(tracked.path, folder))?.path ?? null
}

/**
 * Opens a chat of a tracked folder. An epic-bound one opens on its epic's Agent tab with itself selected and no thread,
 * because a worker's pending prompt card lives in the owning chat. Any other opens in its folder, at its thread when named.
 */
function openFolderChat(chat: ChatRecord, path: string, threadId: string | undefined, actions: NavigateActions): void {
  if (chat.epicId !== undefined && chat.epicId !== '') actions.openEpicAgent(path, chat.epicId, chat.id)
  else if (threadId === undefined) actions.selectChat(path, chat.id)
  else actions.openThread(path, chat.id, threadId)
}

/**
 * Opens a chat target: a project-less chat on its own, a folder chat through `openFolderChat`. A chat no loaded list
 * holds opens the folder the target names; one whose folder is not tracked opens nothing.
 */
function openChatTarget(target: Extract<NavigateTarget, { kind: 'chat' }>, { folders, chats, actions }: NavigateContext): void {
  const chat = chats.find((candidate) => candidate.id === target.chatId)
  if (chat === undefined) {
    const fallback = target.folder === null ? null : trackedPath(folders, target.folder)
    if (fallback !== null) actions.selectFolder(fallback)
  } else if (chat.folder === null) {
    actions.openChat(chat)
  } else {
    const path = trackedPath(folders, chat.folder)
    if (path !== null) openFolderChat(chat, path, target.threadId, actions)
  }
}

/** Opens what a clicked notification names, ignoring a target whose folder is not tracked. */
function routeNavigate(target: NavigateTarget, context: NavigateContext): void {
  if (target.kind === 'chat') {
    openChatTarget(target, context)
    return
  }
  const path = trackedPath(context.folders, target.folder)
  if (path === null) return
  if (target.kind === 'checkpoint') context.actions.openEpicCheckpoint(path, target.epicId)
  else context.actions.selectEpic(path, target.epicId)
}

/** Subscribes once to clicked-notification pushes, routing each with the newest shell state, and unsubscribes on unmount. */
export function useNotificationNavigate(context: NavigateContext): void {
  const latest = useLatest(context)
  useEffect(() => window.dm.notifications.onNavigate((target) => routeNavigate(target, latest.current)), [latest])
}
