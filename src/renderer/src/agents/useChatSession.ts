import { useCallback, useEffect, useReducer, useState, type Dispatch } from 'react'
import type { ApprovalDecision, ChatRecord } from '../../../shared/agents/chat'
import type { ChatRequestRef } from '../../../shared/agents/chatApi'
import type { AgentKind } from '../../../shared/desktop/api'
import { errorMessage } from '../api/dm'
import { unwrapChat } from './chatCalls'
import { openSession, reduceSession, type ChatAuth, type SessionAction, type SessionState } from './chatViewModel'

interface Opened {
  state: SessionState
  /** Fetches the transcript again after a failed opening. */
  reopen(): void
  push: Dispatch<SessionAction>
}

/**
 * Opens a chat and keeps its transcript current. It subscribes to the push channel before asking
 * for the stored transcript, so nothing pushed while the request is in flight is lost; the
 * reducer replays those events on top of the stored items. The subscription ends with the view. Shared with
 * the views that follow one thread of a chat (an attempt's Activity tab, the orchestrator feed), which pass
 * `'read'`: that fetches the same view without starting the agent or writing to the chat store, which
 * `'open'` (the chat view itself, and the default) does.
 */
export function useOpenedChat(ref: ChatRequestRef, load: 'open' | 'read' = 'open'): Opened {
  const { folder, chatId } = ref
  const [state, dispatch] = useReducer(reduceSession, chatId, openSession)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    const unsubscribe = window.dm.chats.onEvent((event) => {
      if (current) dispatch({ type: 'push', event })
    })
    unwrapChat(window.dm.chats[load]({ folder, chatId })).then(
      (view) => {
        if (current) dispatch({ type: 'opened', view })
      },
      (error: unknown) => {
        if (current) dispatch({ type: 'failed', message: errorMessage(error) })
      }
    )
    return () => {
      current = false
      unsubscribe()
    }
  }, [folder, chatId, load, attempt])
  const reopen = useCallback(() => {
    dispatch({ type: 'reopen' })
    setAttempt((count) => count + 1)
  }, [])
  return { state, reopen, push: dispatch }
}

/**
 * A chat whose stored transcript says its agent's sign-in was lost asks the agent's own status whether it
 * still is, once, as it opens; what the main process pushes afterwards is newer and wins.
 */
function useSignInCheck(agent: AgentKind, asking: boolean, push: Dispatch<SessionAction>): void {
  useEffect(() => {
    if (!asking) {
      return undefined
    }
    let current = true
    window.dm.agentStatus(agent).then(
      (status) => {
        if (current) push({ type: 'agent_checked', state: status.state })
      },
      () => {
        if (current) push({ type: 'agent_checked', state: 'unknown' })
      }
    )
    return () => {
      current = false
    }
  }, [asking, agent, push])
}

/** The two answers of a sign-in card: the agent was seen signed in, and the turn it cut short is sent again. */
function useSignInActions(chat: ChatRecord, state: SessionState, push: Dispatch<SessionAction>): Pick<ChatSession, 'retryTurn' | 'signedIn'> {
  const { folder, id: chatId, agent } = chat
  useSignInCheck(agent, state.phase === 'ready' && state.auth.agent === 'checking', push)
  const retryTurn = useCallback(async (): Promise<void> => {
    await unwrapChat(window.dm.chats.retryTurn({ folder, chatId }))
    push({ type: 'retried' })
  }, [folder, chatId, push])
  const signedIn = useCallback(() => push({ type: 'push', event: { type: 'agent_auth', chatId, agent, state: 'signed_in' } }), [chatId, agent, push])
  return { retryTurn, signedIn }
}

interface ChatSession {
  phase: SessionState['phase']
  entries: SessionState['entries']
  /** What is known about the agent's sign-in, and whether a turn is waiting to be retried. */
  auth: ChatAuth
  /** Why the chat could not be opened. */
  openError: string | null
  /** A turn is running, or the message that starts one is being handed over. */
  running: boolean
  /** Stop was pressed and has not been answered yet. */
  stopping: boolean
  /** A model switch is being made. */
  switching: boolean
  /** The model the chat runs on from the next turn. */
  model: string | null
  /** Why the last send, stop or switch failed; cleared when the next one starts. */
  actionError: string | null
  /** Resolves true once the message is stored, false after saying why it was not. */
  send(text: string): Promise<boolean>
  stop(): Promise<void>
  switchModel(model: string): Promise<void>
  /** Sends the person's decision for a waiting request; rejects with why it was not accepted, which the card shows. */
  answerApproval(requestId: string, decision: ApprovalDecision): Promise<void>
  /** Sends the message a sign-in cut short, once; rejects with why it was refused, which the card shows. */
  retryTurn(): Promise<void>
  /** A sign-in prompt in the chat saw the agent's status say signed in. */
  signedIn(): void
  reopen(): void
}

/** Flags that say an action is in flight, and the failure of the last one. */
function useActions(): {
  sending: boolean
  stopping: boolean
  switching: boolean
  error: string | null
  run: <T>(flag: 'sending' | 'stopping' | 'switching', call: () => Promise<T>) => Promise<T | null>
} {
  const [flags, setFlags] = useState({ sending: false, stopping: false, switching: false })
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async <T>(flag: 'sending' | 'stopping' | 'switching', call: () => Promise<T>): Promise<T | null> => {
    setError(null)
    setFlags((current) => ({ ...current, [flag]: true }))
    try {
      return await call()
    } catch (failure) {
      setError(errorMessage(failure))
      return null
    } finally {
      setFlags((current) => ({ ...current, [flag]: false }))
    }
  }, [])
  return { ...flags, error, run }
}

/**
 * Everything the chat view needs from the main process: the transcript as it streams, whether a
 * turn is running, and the actions on the chat. A turn's end comes only from the main process's
 * `turn` event, so the composer cannot be enabled by an action that merely returned.
 */
export function useChatSession(chat: ChatRecord): ChatSession {
  const { folder, id: chatId } = chat
  const { state, reopen, push } = useOpenedChat({ folder, chatId })
  const actions = useActions()
  const [model, setModel] = useState(chat.model)
  // A list that was reloaded with another model (this chat changed elsewhere) wins over what this view last chose.
  useEffect(() => {
    setModel(chat.model)
  }, [chat.model])
  const ref: ChatRequestRef = { folder, chatId }
  const answerApproval = useCallback(
    async (requestId: string, decision: ApprovalDecision): Promise<void> => {
      await unwrapChat(window.dm.chats.answerApproval({ folder, chatId, requestId, decision }))
    },
    [folder, chatId]
  )
  const signIn = useSignInActions(chat, state, push)
  return {
    phase: state.phase,
    entries: state.entries,
    auth: state.auth,
    openError: state.error,
    running: state.running || actions.sending,
    stopping: actions.stopping,
    switching: actions.switching,
    model,
    actionError: actions.error,
    reopen,
    answerApproval,
    ...signIn,
    send: async (text) => {
      const item = await actions.run('sending', () => unwrapChat(window.dm.chats.send({ ...ref, text })))
      if (item !== null) push({ type: 'sent', item })
      return item !== null
    },
    stop: async () => {
      await actions.run('stopping', () => unwrapChat(window.dm.chats.stop(ref)))
    },
    switchModel: async (next) => {
      const updated = await actions.run('switching', () => unwrapChat(window.dm.chats.setModel({ ...ref, model: next })))
      if (updated !== null) setModel(updated.model)
    }
  }
}
