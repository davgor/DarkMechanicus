/**
 * The person's view of OMP chats' mailboxes (`window.dm.chats.mail`), held once for the whole page and keyed by
 * folder and chat, so a sidebar row and the open chat's header read the same counts without a poll timer each.
 * A folder becomes known with a snapshot (the catch-up, which also starts main's monitor of it) when it becomes
 * active, again after one of its chats is created, renamed or deleted, and again after a reload; pushes then keep it
 * current. Views of one chat are ordered by their `version`: an older one (a late snapshot, a delayed push) never
 * replaces a newer one. A folder that stops being active is dropped with everything in flight for it, so a late
 * answer or push for it changes nothing, and the next time it is active it is caught up from scratch.
 */
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import type { ChatMailApi, ChatMailPushEvent, ChatMailSnapshot, ChatMailState } from '../../../shared/agents/chatApi'

/** Where a folder's mailboxes stand: its first snapshot is out, it has one, or the last snapshot failed (the counts are the last known). */
type MailFolderStatus = 'loading' | 'ready' | 'error'

/** One chat's mailbox as the page knows it: no state while its folder is not active, its snapshot is out, or the chat has no mailbox. */
interface ChatMailView {
  status: MailFolderStatus | 'inactive'
  state: ChatMailState | null
}

interface FolderEntry {
  status: MailFolderStatus
  chats: Map<string, ChatMailState>
  /** The snapshot answer this folder waits for: any other one is stale. */
  ticket: object
  /** Chats a push or an answer told of since the awaited snapshot was asked for: kept even when it misses them. */
  touched: Set<string>
}

export interface AgentMailStore {
  /** Makes exactly these folders active: new ones are caught up, dropped ones forgotten with what is in flight for them. */
  track(paths: readonly string[]): void
  /** Asks a tracked folder's snapshot again (a missed push, a chat created or deleted); nothing for any other folder. */
  refresh(folder: string): Promise<void>
  /** A push or an answer: kept when its folder is active and it is newer than what is known of its chat. */
  apply(state: ChatMailState): void
  push(event: ChatMailPushEvent): void
  view(folder: string, chatId: string): ChatMailView
  subscribe(listener: () => void): () => void
  /** Forgets every folder: what is in flight answers into nothing. */
  dispose(): void
}

interface MailData {
  api: ChatMailApi
  folders: Map<string, FolderEntry>
  /** The version at which each chat's mailbox was removed: an older view of it is a late one. */
  removed: Map<string, number>
  views: Map<string, ChatMailView>
  listeners: Set<() => void>
}

const INACTIVE: ChatMailView = { status: 'inactive', state: null }

const keyOf = (folder: string, chatId: string): string => `${folder}\0${chatId}`

function changed(data: MailData): void {
  data.views.clear()
  for (const listener of data.listeners) listener()
}

function isNewer(data: MailData, entry: FolderEntry, state: ChatMailState): boolean {
  const known = entry.chats.get(state.chatId)
  const removedAt = data.removed.get(keyOf(state.folder, state.chatId)) ?? -1
  return (known === undefined || state.version > known.version) && state.version > removedAt
}

/** The snapshot replaces what the folder held, except chats a newer push or answer told of meanwhile. */
function takeSnapshot(data: MailData, entry: FolderEntry, snapshot: ChatMailSnapshot): void {
  const listed = new Set(snapshot.chats.map((state) => state.chatId))
  for (const chatId of entry.chats.keys()) {
    if (!listed.has(chatId) && !entry.touched.has(chatId)) entry.chats.delete(chatId)
  }
  for (const state of snapshot.chats) {
    if (state.folder === snapshot.folder && isNewer(data, entry, state)) entry.chats.set(state.chatId, state)
  }
}

async function refresh(data: MailData, folder: string): Promise<void> {
  const entry = data.folders.get(folder)
  if (entry === undefined) return
  const ticket = {}
  entry.ticket = ticket
  entry.touched = new Set()
  const result = await data.api.snapshot(folder).catch(() => null)
  if (data.folders.get(folder) !== entry || entry.ticket !== ticket) return
  if (result?.ok === true && result.data.folder === folder) {
    takeSnapshot(data, entry, result.data)
    entry.status = 'ready'
  } else {
    entry.status = 'error'
  }
  changed(data)
}

function track(data: MailData, paths: readonly string[]): void {
  const next = new Set(paths)
  let dropped = false
  for (const folder of data.folders.keys()) {
    if (!next.has(folder)) {
      data.folders.delete(folder)
      dropped = true
    }
  }
  for (const folder of next) {
    if (!data.folders.has(folder)) {
      data.folders.set(folder, { status: 'loading', chats: new Map(), ticket: {}, touched: new Set() })
      void refresh(data, folder)
    }
  }
  if (dropped) changed(data)
}

function apply(data: MailData, state: ChatMailState): void {
  const entry = data.folders.get(state.folder)
  if (entry === undefined || !isNewer(data, entry, state)) return
  entry.chats.set(state.chatId, state)
  entry.touched.add(state.chatId)
  changed(data)
}

function remove(data: MailData, folder: string, chatId: string, version: number): void {
  const entry = data.folders.get(folder)
  const known = entry?.chats.get(chatId)
  if (entry === undefined || (known !== undefined && known.version > version)) return
  const key = keyOf(folder, chatId)
  data.removed.set(key, Math.max(version, data.removed.get(key) ?? -1))
  entry.touched.delete(chatId)
  if (entry.chats.delete(chatId)) changed(data)
}

function view(data: MailData, folder: string, chatId: string): ChatMailView {
  const entry = data.folders.get(folder)
  if (entry === undefined) return INACTIVE
  const key = keyOf(folder, chatId)
  const cached = data.views.get(key)
  if (cached !== undefined) return cached
  const fresh = { status: entry.status, state: entry.chats.get(chatId) ?? null }
  data.views.set(key, fresh)
  return fresh
}

export function createAgentMailStore(api: ChatMailApi): AgentMailStore {
  const data: MailData = { api, folders: new Map(), removed: new Map(), views: new Map(), listeners: new Set() }
  return {
    track: (paths) => track(data, paths),
    refresh: (folder) => refresh(data, folder),
    apply: (state) => apply(data, state),
    push: (event) => (event.type === 'mail_state' ? apply(data, event.state) : remove(data, event.folder, event.chatId, event.version)),
    view: (folder, chatId) => view(data, folder, chatId),
    subscribe: (listener) => {
      data.listeners.add(listener)
      return () => {
        data.listeners.delete(listener)
      }
    },
    dispose: () => {
      data.folders.clear()
      changed(data)
    }
  }
}

/** The page's store, from the shell; none outside it (nothing then shows mail). */
export const AgentMailContext = createContext<AgentMailStore | null>(null)

const NO_CHANGES = (): (() => void) => () => {}

/** One chat's mailbox, as the page's store knows it now; a project-less chat (`folder` null) has none. */
export function useChatMail(folder: string | null, chatId: string): ChatMailView {
  const store = useContext(AgentMailContext)
  return useSyncExternalStore(store?.subscribe ?? NO_CHANGES, () => (folder === null ? undefined : store?.view(folder, chatId)) ?? INACTIVE)
}

/** The page's mail store, given the active folders: subscribed to main's pushes, and caught up again after a chat changes. */
export function useAgentMail(paths: readonly string[]): AgentMailStore {
  const [store] = useState(() => createAgentMailStore(window.dm.chats.mail))
  useEffect(() => {
    const stopMail = window.dm.chats.mail.onEvent(store.push)
    // A project-less chat has no mailbox: its changes leave every folder's mail as it is.
    const stopChats = window.dm.chats.onEvent((event) => {
      if (event.folder !== null) void store.refresh(event.folder)
    })
    return () => {
      stopMail()
      stopChats()
      store.dispose()
    }
  }, [store])
  const joined = paths.join('\0')
  useEffect(() => {
    store.track(joined === '' ? [] : joined.split('\0'))
  }, [store, joined])
  return store
}
