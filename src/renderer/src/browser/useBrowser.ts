import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { BrowserApi, BrowserState } from '../../../shared/browser/browserApi'
import type { CommandResult } from '../../../shared/desktop/api'

/** The panel's commands that name only the chat. */
type ChatCommand = 'back' | 'forward' | 'reload' | 'stopAgent' | 'takeControl' | 'handBack' | 'closeSignIn'

interface BrowserCommands {
  command(name: ChatCommand): void
  navigate(url: string): void
  openSignIn(url: string): void
  setEnabled(enabled: boolean): void
}

export interface BrowserHandle extends BrowserCommands {
  /** The chat's browser as main last reported it; null until the first answer. */
  state: BrowserState | null
  /** The last failed command's or load's message, cleared by the next command. */
  error: string | null
}

/** Each command clears the last error, shows its own failure, then reads the state again, unless the chat changed meanwhile. */
function browserCommands({ api, folder, chatId, chat, setError, refresh }: {
  api: BrowserApi
  folder: string | null
  chatId: string
  chat: MutableRefObject<number>
  setError(message: string | null): void
  refresh(): Promise<void>
}): BrowserCommands {
  const run = (call: () => Promise<CommandResult<unknown>>): void => {
    const current = chat.current
    setError(null)
    void call().then((result) => {
      if (chat.current !== current) return
      if (!result.ok) setError(result.error.message)
      void refresh()
    })
  }
  const ref = { folder, chatId }
  return {
    command: (name) => run(() => api[name](ref)),
    navigate: (url) => run(() => api.navigate({ ...ref, url })),
    openSignIn: (url) => run(() => api.openSignIn({ ...ref, url })),
    setEnabled: (enabled) => run(() => api.setEnabled({ enabled }))
  }
}

/**
 * One chat's in-app browser: its state from `browser.state`, kept current by `browser:event` pushes for this chat,
 * and the panel's commands. After every command the state is read again, because main does not push after each one
 * (`setEnabled` pushes nothing, DM-870). A read never overwrites a push that arrived while it was in flight, and
 * nothing from a chat the panel left lands on the next one.
 */
export function useBrowser(folder: string | null, chatId: string, api: BrowserApi): BrowserHandle {
  const [state, setState] = useState<BrowserState | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Bumped by every push and every chat change; an answer read under an older value is stale. */
  const version = useRef(0)
  /** Bumped by every chat change (and unmount); a command's failure under an older value is not this chat's. */
  const chat = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const seen = version.current
    const result = await api.state({ folder, chatId })
    if (version.current !== seen) return
    if (result.ok) setState(result.data)
    else setError(result.error.message)
  }, [api, folder, chatId])

  useEffect(() => {
    version.current += 1
    chat.current += 1
    setState(null)
    setError(null)
    const unsubscribe = api.onEvent((pushed) => {
      if (pushed.folder !== folder || pushed.chatId !== chatId) return
      version.current += 1
      setState(pushed)
    })
    void refresh()
    return () => {
      version.current += 1
      chat.current += 1
      unsubscribe()
    }
  }, [api, folder, chatId, refresh])

  const commands = useMemo(() => browserCommands({ api, folder, chatId, chat, setError, refresh }), [api, folder, chatId, refresh])
  return { state, error, ...commands }
}
