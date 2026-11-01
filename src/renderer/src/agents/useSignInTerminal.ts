/**
 * An agent's sign-in terminal where it is shown (`docs/design/chat-shells.md`, "Sign-in detection"): showing it asks
 * main for the agent's sign-in (`window.dm.terminals.signIn`, naming only the agent id), which runs the CLI's own login
 * in a PTY, and mounts one terminal emulator for it, as a chat's pane does. When the login ends on its own, the
 * agent's status is asked again (`agents:status`): signed in, or what the status says instead, with Sign in again.
 * Hiding it (Back, another screen) closes the terminal, which stops the login once nothing else shows it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { TerminalAttachment, TerminalHandle } from '../../../shared/agents/terminalApi'
import type { AgentAuthStatus, AgentId, CommandResult } from '../../../shared/desktop/api'
import { errorMessage } from '../api/dm'
import type { Scheduler } from '../app/scheduler'
import { useLatest } from '../app/useLatest'
import type { TerminalKit, TerminalView } from './terminalView'
import { NOT_SHOWN, showTerminal, type Shown } from './useTerminal'

/** Where the sign-in is: `checking` once the login has ended and the status is being asked. */
export type SignInPhase =
  | { state: 'starting' | 'running' | 'checking' }
  | { state: 'signed_in' | 'ended' | 'failed'; message: string }

interface UseSignInTerminalOptions {
  agent: AgentId
  kit: TerminalKit
  scheduler: Scheduler
  /** The status asked once the login has ended. */
  onStatus?(status: AgentAuthStatus): void
  /** That status says signed in. */
  onSignedIn?(): void
}

interface SignInTerminalModel {
  /** The element the emulator is mounted in; rendered whatever the phase. */
  host: RefObject<HTMLDivElement>
  phase: SignInPhase
  focus(): void
  /** Starts the sign-in once more, after it ended or could not start. */
  again(): void
}

const STARTING: SignInPhase = { state: 'starting' }

type Handlers = Pick<UseSignInTerminalOptions, 'onStatus' | 'onSignedIn'>

/** One showing of the sign-in terminal: whether it was torn down, what it opened and mounted, and where it reports. */
interface Showing {
  gone: boolean
  terminal: TerminalHandle | null
  shown: Shown | null
  setPhase(phase: SignInPhase): void
  handlers: { readonly current: Handlers }
}

/** Where a running sign-in terminal is mounted, and what drives its emulator. */
interface Place {
  agent: AgentId
  element: HTMLDivElement | null
  kit: TerminalKit
  scheduler: Scheduler
}

/** A running sign-in terminal with its element to mount in, or why it cannot be shown. */
type Mountable = { terminal: TerminalHandle; element: HTMLDivElement; snapshot: string } | { failure: string }

function mountable(result: CommandResult<TerminalAttachment>, element: HTMLDivElement | null): Mountable {
  if (!result.ok) return { failure: result.error.message }
  const { state, terminal, message, snapshot } = result.data
  if (state !== 'running' || terminal === null || element === null) return { failure: message ?? NOT_SHOWN }
  return { terminal, element, snapshot: snapshot ?? '' }
}

/** Asks the agent's status once its login ended on its own, and reports it: signed in, or what the status says instead. */
function checkStatus(agent: AgentId, showing: Showing): void {
  showing.setPhase({ state: 'checking' })
  window.dm.agentStatus(agent).then(
    (status) => {
      showing.handlers.current.onStatus?.(status)
      if (showing.gone) return
      if (status.state === 'signed_in') {
        showing.setPhase({ state: 'signed_in', message: status.reason })
        showing.handlers.current.onSignedIn?.()
      } else {
        showing.setPhase({ state: 'ended', message: status.reason })
      }
    },
    (error: unknown) => {
      if (!showing.gone) showing.setPhase({ state: 'ended', message: errorMessage(error) })
    }
  )
}

/** Mounts the terminal main's sign-in answered, or says why it could not; a showing already torn down just closes it. */
function answerSignIn(result: CommandResult<TerminalAttachment>, showing: Showing, place: Place): void {
  showing.terminal = result.ok ? result.data.terminal : null
  if (showing.gone) {
    showing.terminal?.close()
    return
  }
  const running = mountable(result, place.element)
  if ('failure' in running) {
    showing.terminal?.close()
    showing.setPhase({ state: 'failed', message: running.failure })
    return
  }
  showing.shown = showTerminal({
    ...running,
    kit: place.kit,
    scheduler: place.scheduler,
    // A login main stopped (the agent removed, quit) says why; one that ended on its own is checked.
    onExit: (exit) => (exit.message === null ? checkStatus(place.agent, showing) : showing.setPhase({ state: 'ended', message: exit.message }))
  })
  showing.setPhase({ state: 'running' })
}

export function useSignInTerminal({ agent, kit, scheduler, onStatus, onSignedIn }: UseSignInTerminalOptions): SignInTerminalModel {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<TerminalView | null>(null)
  const [phase, setPhase] = useState<SignInPhase>(STARTING)
  const [attempt, setAttempt] = useState(0)
  const handlers = useLatest({ onStatus, onSignedIn })
  useEffect(() => {
    const showing: Showing = { gone: false, terminal: null, shown: null, setPhase, handlers }
    setPhase(STARTING)
    window.dm.terminals.signIn(agent).then(
      (result) => {
        answerSignIn(result, showing, { agent, element: host.current, kit, scheduler })
        if (showing.shown !== null) view.current = showing.shown.view
      },
      (error: unknown) => {
        if (!showing.gone) setPhase({ state: 'failed', message: errorMessage(error) })
      }
    )
    return () => {
      showing.gone = true
      showing.shown?.hide()
      view.current = null
      showing.terminal?.close()
    }
  }, [agent, kit, scheduler, handlers, attempt])
  const focus = useCallback(() => view.current?.focus(), [])
  const again = useCallback(() => setAttempt((count) => count + 1), [])
  return { host, phase, focus, again }
}
