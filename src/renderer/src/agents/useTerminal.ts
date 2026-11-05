/**
 * A chat's terminal in the pane that shows it (`docs/design/chat-shells.md`, "In the app's window"). Showing the
 * chat attaches to it (`window.dm.terminals.attach`), which starts its CLI in main when none runs. A running
 * answer mounts one terminal emulator in the pane's host: sized to the pane, painted from main's snapshot of
 * the screen, then fed what the CLI prints after it. Hiding the chat (another chat, another view, a reload)
 * disposes the emulator; the PTY runs on in main, and the page's `LiveTerminals` keeps the port so the chat's
 * exit is still heard. Once the CLI has exited, `startAgain` attaches again, which starts it again (resuming its
 * session), or on a new session when asked.
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { TerminalAttachment, TerminalExit, TerminalHandle, TerminalState } from '../../../shared/agents/terminalApi'
import type { CommandResult } from '../../../shared/desktop/api'
import type { Scheduler } from '../app/scheduler'
import type { TerminalColors } from '../../../shared/agents/terminalColors'
import { LiveTerminalsContext, type LiveTerminals } from './liveTerminals'
import { inputChunks } from './terminalInput'
import { chatTerminalTheme, rootTokens, TERMINAL_FONT_TOKEN, terminalTheme, type TerminalTheme } from './terminalTheme'
import type { TerminalKit, TerminalSize, TerminalView } from './terminalView'

/** How long the pane's size must hold still before the grid is fitted again and the PTY resized. */
const RESIZE_SETTLE_MS = 80

/** How long after its last output a terminal still counts as at work (the Skitarii mascot drills for this long). */
export const OUTPUT_QUIET_MS = 1500

/** The longest terminal title shown: what the CLI sets is untrusted and may be any length. */
export const TITLE_MAX_LENGTH = 80

/** The title as shown: control characters (C0, DEL, C1) dropped, whitespace trimmed, cut to `TITLE_MAX_LENGTH` with an ellipsis. */
export function cleanTitle(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
  return clean.length > TITLE_MAX_LENGTH ? `${clean.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…` : clean
}

export const NOT_SHOWN = 'The terminal could not be shown.'

/** Where the pane's terminal is: `checking` while the attach is answered (main waits out a sign-in check). */
export type TerminalPhase =
  | { state: 'checking' }
  | { state: 'running' }
  /**
   * The CLI ended on its own; or main `stopped` it, saying why. `resumed`: it ran on an earlier session, which the
   * CLI may have refused, so a new session is offered.
   */
  | { state: 'exited' | 'stopped'; message: string; resumed: boolean }
  | { state: Exclude<TerminalState, 'running'>; message: string }

const CHECKING: TerminalPhase = { state: 'checking' }
const RUNNING: TerminalPhase = { state: 'running' }

function exitPhase(exit: TerminalExit): TerminalPhase {
  if (exit.message !== null) {
    return { state: 'stopped', message: exit.message, resumed: exit.resumed }
  }
  // node-pty reports signal 0 for a program that exited by itself.
  if (exit.signal !== null && exit.signal > 0) {
    return { state: 'exited', message: `The CLI exited on signal ${exit.signal}.`, resumed: exit.resumed }
  }
  // A CLI that fails on a session it was asked to resume has most likely refused it (a deleted session, or an old
  // chat's session it cannot continue); its own words are on the screen, and New session is offered with this.
  const refused = exit.resumed && exit.exitCode !== 0
  const message = refused
    ? `The CLI exited with code ${exit.exitCode} and may not have been able to continue this chat’s earlier session. New session starts a new one.`
    : `The CLI exited with code ${exit.exitCode}.`
  return { state: 'exited', message, resumed: exit.resumed }
}

/** A mounted emulator, and how to take it down again. */
export interface Shown {
  view: TerminalView
  hide(): void
}

interface ShowContext {
  element: HTMLElement
  terminal: TerminalHandle
  snapshot: string
  kit: TerminalKit
  scheduler: Scheduler
  /** The colors of the theme the pane shows; the app's palette when absent. */
  theme?: TerminalTheme
  onExit(exit: TerminalExit): void
  /** Called whenever the CLI prints something after the snapshot (not for the snapshot itself). */
  onActivity?(): void
  /** Called with the raw title the CLI sets over OSC 0 or 2. */
  onTitle?(title: string): void
}

/** Fits the view to its host, and resizes the PTY when the grid's size changed since the last time. */
function fitter(view: TerminalView, terminal: TerminalHandle): () => void {
  let sent: TerminalSize | null = null
  return () => {
    const size = view.fit()
    if (size !== null && (sent === null || size.cols !== sent.cols || size.rows !== sent.rows)) {
      sent = size
      terminal.resize(size.cols, size.rows)
    }
  }
}

/** Mounts the emulator for a running terminal (a chat's or a sign-in's) and wires it to the PTY; `hide` undoes all of it. */
export function showTerminal({ element, terminal, snapshot, kit, scheduler, theme, onExit, onActivity, onTitle }: ShowContext): Shown {
  const read = rootTokens(element.ownerDocument)
  const view = kit.create(element, { theme: theme ?? terminalTheme(read), fontFamily: read(TERMINAL_FONT_TOKEN) })
  const fit = fitter(view, terminal)
  // The PTY takes the pane's size before the snapshot is painted: a chat shown again in the same window gets
  // the screen at exactly the size it was serialized at, and a new size makes the CLI redraw after the snapshot.
  fit()
  if (snapshot !== '') {
    view.write(snapshot)
  }
  // Subscribing starts the port; what main sent since the snapshot waits in it until then.
  const stopOutput = terminal.onOutput((data) => {
    view.write(data)
    onActivity?.()
  })
  const stopTitle = view.onTitleChange((title) => onTitle?.(title))
  const stopInput = view.onInput((data) => {
    for (const chunk of inputChunks(data)) {
      terminal.write(chunk)
    }
  })
  const stopExit = terminal.onExit((exit) => {
    stopInput()
    onExit(exit)
  })
  let cancelFit = (): void => {}
  const stopWatching = kit.observeSize(element, () => {
    cancelFit()
    cancelFit = scheduler.after(RESIZE_SETTLE_MS, fit)
  })
  view.focus()
  return {
    view,
    hide: () => {
      stopWatching()
      cancelFit()
      stopExit()
      stopOutput()
      stopTitle()
      stopInput()
      view.dispose()
    }
  }
}

/** What an attach's answer asks of the pane: to show its running terminal, or the phase it ended in. */
type Answered = { show: { terminal: TerminalHandle; snapshot: string } } | { phase: TerminalPhase }

function answered(result: CommandResult<TerminalAttachment>): Answered {
  if (!result.ok) {
    return { phase: { state: 'failed', message: result.error.message } }
  }
  const { state, snapshot = '', message = NOT_SHOWN, terminal } = result.data
  if (state !== 'running') {
    return { phase: { state, message } }
  }
  return terminal === null ? { phase: { state: 'failed', message: NOT_SHOWN } } : { show: { terminal, snapshot } }
}

interface UseTerminalOptions {
  folder: string
  chatId: string
  /** The chat's agent id: an OMP chat's pane takes OMP's theme (`terminalTheme.ts`). */
  agent: string
  kit: TerminalKit
  scheduler: Scheduler
}

export interface TerminalModel {
  /** The element the emulator is mounted in; rendered whatever the phase. */
  host: RefObject<HTMLDivElement>
  phase: TerminalPhase
  /** The background of the theme the pane shows when it is not the app's (OMP's), so the frame around the terminal matches. */
  background: string | null
  /** The CLI printed something within `OUTPUT_QUIET_MS` (only tracked for an OMP chat, whose header shows it). */
  working: boolean
  /** The title the CLI set over OSC 0 or 2, cleaned for display; empty when none is set. */
  title: string
  /** Focuses the emulator, when one is shown. */
  focus(): void
  /** Attaches again once the CLI has exited, starting it again: resuming its session, or on a new one. */
  startAgain(options: { newSession: boolean }): void
}

/**
 * The pane's latest Start again, for the chat it was clicked in. It is forgotten when the pane shows another chat,
 * so a new session asked for once is never asked for again by showing the chat later.
 */
interface StartRequest {
  chatId: string
  newSession: boolean
}

/** The latest Start again of the shown chat (a new object per click, so each one attaches once more), and the click. */
function useStartAgain(chatId: string): { start: StartRequest | null; startAgain: TerminalModel['startAgain'] } {
  const [start, setStart] = useState<StartRequest | null>(null)
  if (start !== null && start.chatId !== chatId) {
    setStart(null)
  }
  const startAgain = useCallback((options: { newSession: boolean }) => setStart({ chatId, newSession: options.newSession }), [chatId])
  return { start: start?.chatId === chatId ? start : null, startAgain }
}

/** Hands the terminal to the page's registry, which hears its exit while the chat is not shown; without one, the pane owns it. */
function heldOrOwned(live: LiveTerminals | null, chatId: string, terminal: TerminalHandle | null): TerminalHandle | null {
  if (terminal === null || live === null) return terminal
  live.hold(chatId, terminal)
  return null
}

/**
 * The attach, and, for an OMP chat, OMP's theme alongside it (read each time the chat is opened; a failed read is no
 * theme, and the pane keeps the app's palette).
 */
async function openChat(request: { folder: string; chatId: string; agent: string; newSession: boolean }): Promise<{ result: CommandResult<TerminalAttachment>; omp: TerminalColors | null }> {
  const { folder, chatId, agent, newSession } = request
  const omp = agent === 'omp' ? window.dm.ompTerminalTheme().catch(() => null) : Promise.resolve(null)
  const attach = window.dm.terminals.attach(folder, chatId, newSession ? { newSession: true } : undefined)
  const [result, theme] = await Promise.all([attach, omp])
  return { result, omp: theme }
}

/** The colors to show, and the background of the frame around the terminal when it is not the app's. */
function paneTheme(element: HTMLElement, agent: string, omp: TerminalColors | null): { theme: TerminalTheme; background: string | null } {
  const theme = chatTerminalTheme(rootTokens(element.ownerDocument), agent, omp)
  return { theme, background: agent === 'omp' && omp !== null ? (theme.background ?? null) : null }
}

/**
 * What the CLI's output tells: whether it printed within `OUTPUT_QUIET_MS` (only when `tracked`; `noteActivity` on each
 * output), and the title it set (`noteTitle`, cleaned for display). `resetActivity` clears both when the chat goes.
 */
function useOutputActivity(
  scheduler: Scheduler,
  tracked: boolean
): { working: boolean; title: string; noteActivity(): void; noteTitle(raw: string): void; resetActivity(): void } {
  const [working, setWorking] = useState(false)
  const [title, setTitle] = useState('')
  const noteTitle = useCallback((raw: string) => setTitle(cleanTitle(raw)), [])
  const stopQuiet = useRef<() => void>(() => undefined)
  const resetActivity = useCallback(() => {
    stopQuiet.current()
    setWorking(false)
    setTitle('')
  }, [])
  const noteActivity = useCallback(() => {
    if (!tracked) return
    setWorking(true)
    stopQuiet.current()
    stopQuiet.current = scheduler.after(OUTPUT_QUIET_MS, () => setWorking(false))
  }, [scheduler, tracked])
  return { working, title, noteActivity, noteTitle, resetActivity }
}

export function useTerminal({ folder, chatId, agent, kit, scheduler }: UseTerminalOptions): TerminalModel {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<TerminalView | null>(null)
  const live = useContext(LiveTerminalsContext)
  const [phase, setPhase] = useState<TerminalPhase>(CHECKING)
  const [background, setBackground] = useState<string | null>(null)
  const { working, title, noteActivity, noteTitle, resetActivity } = useOutputActivity(scheduler, agent === 'omp')
  const { start, startAgain } = useStartAgain(chatId)
  const newSession = start?.newSession === true
  useEffect(() => {
    let gone = false
    let shown: Shown | null = null
    /** The terminal this pane closes when it goes: its own, when no shell keeps the page's terminals. */
    let owned: TerminalHandle | null = null
    setPhase(CHECKING)
    setBackground(null)
    openChat({ folder, chatId, agent, newSession }).then(
      ({ result, omp }) => {
        owned = heldOrOwned(live, chatId, result.ok ? result.data.terminal : null)
        if (gone) {
          owned?.close()
          return
        }
        const answer = answered(result)
        const element = host.current
        if ('phase' in answer || element === null) {
          setPhase('phase' in answer ? answer.phase : { state: 'failed', message: NOT_SHOWN })
          return
        }
        const { theme, background: frame } = paneTheme(element, agent, omp)
        shown = showTerminal({ element, ...answer.show, kit, scheduler, theme, onExit: (exit) => setPhase(exitPhase(exit)), onActivity: noteActivity, onTitle: noteTitle })
        view.current = shown.view
        setBackground(frame)
        setPhase(RUNNING)
      },
      (error: unknown) => {
        if (!gone) setPhase({ state: 'failed', message: error instanceof Error ? error.message : String(error) })
      }
    )
    return () => {
      gone = true
      resetActivity()
      shown?.hide()
      view.current = null
      owned?.close()
    }
  }, [folder, chatId, agent, kit, scheduler, live, start, newSession, noteActivity, noteTitle, resetActivity])
  const focus = useCallback(() => view.current?.focus(), [])
  return { host, phase, background, working, title, focus, startAgain }
}
