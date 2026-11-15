import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { CreateChatRequest, SummonChatRequest } from '../../../shared/agents/chatApi'
import { useLatest } from '../app/useLatest'
import { unwrapChat } from './chatCalls'

export interface ChatListState {
  status: 'loading' | 'ready' | 'error'
  chats: ChatRecord[]
}

const LOADING: ChatListState = { status: 'loading', chats: [] }

type Lists = Record<string, ChatListState>

type ListAction = { type: 'loaded'; path: string; chats: ChatRecord[] } | { type: 'failed'; path: string }

function listsReducer(lists: Lists, action: ListAction): Lists {
  if (action.type === 'loaded') {
    return { ...lists, [action.path]: { status: 'ready', chats: action.chats } }
  }
  return { ...lists, [action.path]: { status: 'error', chats: lists[action.path]?.chats ?? [] } }
}

/** The list for a folder, or a loading placeholder before its first response. */
export function chatsFor(lists: Lists, path: string): ChatListState {
  return lists[path] ?? LOADING
}

/** The chat lists of folders, each fetched with `reload`; a response that a newer request overtook is dropped. */
function useChatLists(onError: (error: unknown) => void): { lists: Lists; reload(path: string): Promise<void> } {
  const [lists, dispatch] = useReducer(listsReducer, {})
  const latest = useRef(new Map<string, object>())
  const report = useLatest(onError)
  const reload = useCallback(
    async (path: string): Promise<void> => {
      const ticket = {}
      latest.current.set(path, ticket)
      try {
        const chats = await unwrapChat(window.dm.chats.list(path))
        if (latest.current.get(path) === ticket) {
          dispatch({ type: 'loaded', path, chats })
        }
      } catch (error) {
        if (latest.current.get(path) === ticket) {
          dispatch({ type: 'failed', path })
          report.current(error)
        }
      }
    },
    [report]
  )
  return { lists, reload }
}

/** Fetches a folder's chats when it becomes active, and again each time it comes back after being left. */
function useActiveFolders(paths: readonly string[], reload: (path: string) => Promise<void>): void {
  const active = useRef(new Set<string>())
  const key = paths.join('\0')
  useEffect(() => {
    const next = new Set(paths)
    for (const path of next) {
      if (!active.current.has(path)) {
        void reload(path)
      }
    }
    active.current = next
    // The joined key stands in for `paths`, which is a new array on every render.
  }, [key, reload])
}

/** A chat created, renamed or deleted (here or in another window) names its folder: reload that folder's list when it is listed. */
function useChatEvents(lists: Lists, reload: (path: string) => Promise<void>): void {
  const current = useLatest(lists)
  useEffect(
    () =>
      window.dm.chats.onEvent((event) => {
        if (event.folder !== null && current.current[event.folder] !== undefined) {
          void reload(event.folder)
        }
      }),
    [current, reload]
  )
}

export interface ChatsModel {
  lists: Lists
  reload(path: string): Promise<void>
  /** Resolves with the new chat, or null after reporting why it could not be created. */
  create(request: CreateChatRequest | SummonChatRequest): Promise<ChatRecord | null>
  /** Resolves true once the title is changed, false after reporting why it was not. */
  rename(chat: ChatRecord, title: string): Promise<boolean>
  /** Resolves true once the chat is gone, false after reporting why it is not. */
  remove(chat: ChatRecord): Promise<boolean>
}

interface Reporter {
  reload(path: string): Promise<void>
  onError(error: unknown): void
}

/** Runs a change to one chat; either way its folder's list (a project-less chat has none) is fetched again, so it shows what is really stored. */
async function changeChat(deps: Reporter, folder: string | null, change: () => Promise<unknown>): Promise<boolean> {
  let done = true
  try {
    await change()
  } catch (error) {
    done = false
    deps.onError(error)
  }
  if (folder !== null) {
    await deps.reload(folder)
  }
  return done
}

/** The chats of every active folder, kept current, and the actions on them. */
export function useChats(options: { paths: readonly string[]; onError(error: unknown): void }): ChatsModel {
  const { lists, reload } = useChatLists(options.onError)
  useActiveFolders(options.paths, reload)
  useChatEvents(lists, reload)
  const report = useLatest(options.onError)
  const deps: Reporter = { reload, onError: (error) => report.current(error) }
  return {
    lists,
    reload,
    create: async (request) => {
      try {
        const chat = await unwrapChat(window.dm.chats.create(request))
        if (chat.folder !== null) {
          await reload(chat.folder)
        }
        return chat
      } catch (error) {
        report.current(error)
        return null
      }
    },
    rename: (chat, title) => changeChat(deps, chat.folder, () => unwrapChat(window.dm.chats.rename({ folder: chat.folder, chatId: chat.id, title }))),
    remove: (chat) => changeChat(deps, chat.folder, () => unwrapChat(window.dm.chats.delete({ folder: chat.folder, chatId: chat.id })))
  }
}

/**
 * Every chat that is not deleted (`chats.listAll`): each tracked folder's and the project-less ones. Fetched at first,
 * whenever the tracked folders change (an untracked folder's chats leave the list), and on every chat event, from this
 * window or another; a response that a newer request overtook is dropped.
 */
export function useAllChats(options: { tracked: readonly string[]; onError(error: unknown): void }): ChatListState {
  const [state, setState] = useState<ChatListState>(LOADING)
  const latest = useRef<object | null>(null)
  const report = useLatest(options.onError)
  const reload = useCallback(async (): Promise<void> => {
    const ticket = {}
    latest.current = ticket
    try {
      const chats = await unwrapChat(window.dm.chats.listAll())
      if (latest.current === ticket) {
        setState({ status: 'ready', chats })
      }
    } catch (error) {
      if (latest.current === ticket) {
        setState((previous) => ({ status: 'error', chats: previous.chats }))
        report.current(error)
      }
    }
  }, [report])
  const key = options.tracked.join('\0')
  useEffect(() => {
    void reload()
    // The joined key stands in for `tracked`, which is a new array on every render.
  }, [key, reload])
  useEffect(() => window.dm.chats.onEvent(() => void reload()), [reload])
  return state
}
