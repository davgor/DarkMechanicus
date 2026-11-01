/**
 * One PTY per chat, keyed by chat id, running the chat's agent CLI (`docs/design/chat-shells.md`, question 1,
 * "Several chats", and question 3). PTYs live here whatever the renderer shows: attaching never stops one.
 *
 * **Attach** loads the chat from the chat store and starts its PTY when none runs; attaches that arrive while a
 * start is under way share it, so one chat never has two. A chat whose agent is not connected, or is a custom CLI
 * marked `needsReview` (its arguments were saved for a protocol server; `appDatabase.ts` v3), is refused with what
 * to do and nothing starts. Before a start, in this order:
 * 1. `resolveLaunchFolder`: a moved, deleted, swapped or untracked folder is refused with its `not_found`
 *    message, and nothing starts (no grant, no file);
 * 2. for a built-in agent, the CLI's own sign-in status: `signed_out` starts nothing. The check can take 30 s
 *    (Autonomous), so an attach made while it runs answers `checking`, and its listener hears how the start ended;
 * 3. `writeStartFiles`, the named pre-start step that writes the files the CLI is started with;
 * 4. the grant, issued through `chatGrants`;
 * 5. the grant's id, stored on the chat record (`grantIds` in `index.jsonl`), then the spawn.
 *
 * The folder check runs again before the grant and right before the spawn, since the folder can go away during
 * the sign-in check; a start cancelled (a deleted chat, a removed agent, quit) stops at its next step.
 *
 * The grant is revoked on every way out: the PTY exits, it is killed (a deleted chat, a removed agent, a folder
 * that moved, quit), the spawn fails, or the start is cancelled after the grant was issued (also when the grant
 * arrives after the cancel). A CLI that exits on its own has what it left running in its process group ended
 * (`killPtyTree`, asked from the exit). A chat being deleted starts nothing until its record is gone.
 *
 * **Screen.** Each PTY's output goes through a headless terminal of the same size (`terminalScreen.ts`). An
 * attach answers with its serialized snapshot and subscribes its listener at that same point in the output, so
 * the listener hears exactly what came after the snapshot; output reaches listeners once it is on the screen.
 * What a listener hears from an attach is held until that attach has answered.
 *
 * **Folder watch.** While a PTY runs its folder is checked again every minute, and when an attach finds it
 * running; a failed check stops it (tree killed, grant revoked) with the same `not_found` message.
 *
 * **Resume.** A start resumes the chat's earlier session when the CLI has one: Claude Code with `--resume <id>` once
 * its session file exists (`claudeSession.ts`), else with `--session-id <id>`, the id stored on the chat before
 * the spawn (a new UUID when it has none, or one that is not a UUID); Autonomous with `a8s resume` once the person
 * has typed into an earlier terminal of the chat (`sessionStarted` on the record). An attach that asks for a new
 * session clears the stored id and that flag before a start. An attach whose own start exits before it answered
 * (a resume the CLI refused) answers with the last screen and hears the exit, rather than starting it again.
 *
 * **Idle stop.** A PTY with no input and no output on its screen for 10 minutes is stopped (tree killed, grant
 * revoked) with the message `Stopped after 10 minutes idle.`; the next attach resumes it as above.
 *
 * **Kickoff and first paste** ("The orchestrator chat Start run opens"). `start` is Start run's (and Transfer with
 * agent's): it starts the chat's PTY with the kickoff, which goes only when the record's `kickoffSent` is not set and the start
 * is not a resume. Claude Code takes it as its positional prompt, and `kickoffSent` is stored with the grant's id
 * before the spawn. What the launch could not put on the command line (`pasteFirst`: the kickoff for every other
 * CLI, the instructions too for one with no instructions flag or behind a `.cmd`) is written once the CLI has drawn
 * its first screen and the screen has then taken no output for a second: as one bracketed paste, with every control
 * character but tab taken out, then Enter as a keypress of its own half a second later, as input the person typed
 * (so it marks the session started). A kickoff pasted stores `kickoffSent` once its Enter has gone. A PTY that
 * exits or is stopped first gets nothing more.
 *
 * **Quit.** `busy` and `dispose` go to `disposeBeforeQuit`: `dispose` stops new starts, cancels the ones under
 * way, kills every PTY tree and resolves once every PTY has reported its exit and every revoke and kill has
 * settled; the quit's own bound (5 s) holds.
 *
 * **Signed out.** When an orchestrator chat's CLI exits on its own (not a quit, an idle stop, a deleted chat, a removed
 * agent or a folder stop, which all set the stop message first), main runs the agent's status command, and only when
 * it says `signed_out` is a `running` or `paused` run the chat orchestrates paused with the reason `signed_out`,
 * through the desktop's own session (`runs`): that reason keeps the run's leases, so it is given on nothing looser.
 */
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import type { ChatRecord, ChatRole, DarkMechanicusCli } from '../../shared/agents/chat'
import type { AgentAuthStatus, AgentId, AgentView, BuiltInAgentKind } from '../../shared/desktop/api'
import { SIGNED_OUT_PAUSE_REASON, type RunState } from '../../shared/domain/status'
import type { ChatRef, ChatStore } from '../agents/chatStore'
import { resolveLaunchFolder, type LaunchFolderDeps } from '../agents/launchFolder'
import { killPtyTree, type PtyTree } from '../agents/processTree'
import { claudeSessionExists } from './claudeSession'
import { writeClaudeSettings } from './claudeSettingsFile'
import type { PtyExit, PtyHost, PtyProcess } from './ptyHost'
import { terminalLaunchSpec } from './terminalLaunchSpec'
import { writeTerminalFiles, type TerminalFiles } from './terminalFiles'
import { createTerminalScreen, type TerminalScreen } from './terminalScreen'

/** How often a running PTY's folder is checked again. */
const FOLDER_CHECK_MS = 60_000
/** How long a PTY may go with no input and no output before it is stopped. */
const IDLE_MS = 10 * 60_000
/** The size a PTY starts at, until the pane that shows it sends its own. */
const START_COLS = 80
const START_ROWS = 24
/** How long the CLI's first screen must take no output before the first paste goes. */
const SETTLE_MS = 1_000
/** The marks a bracketed paste is sent between, and the Enter that submits it. */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const ENTER = '\r'
/** How long after the first paste its Enter goes, as a keypress of its own. */
const ENTER_DELAY_MS = 500
/** What a CLI writes to turn bracketed paste on: the sign its input is live, which the first paste waits for. */
const BRACKETED_PASTE_ON = '\x1b[?2004h'

const QUITTING = 'The app is quitting, so the terminal was stopped.'
const DELETED = 'The chat was deleted, so its terminal was stopped.'
const AGENT_REMOVED = "The chat's agent was removed, so its terminal was stopped."
const IDLE_STOPPED = 'Stopped after 10 minutes idle.'

/** How a start ended without a PTY. */
type NotStartedState = 'refused' | 'signed_out' | 'failed'

/** What an attach answers. */
export type TerminalAttach =
  | { state: 'running'; pid: number; snapshot: string }
  /** The sign-in check is still running; the listener hears how the start ends. */
  | { state: 'checking' }
  | { state: NotStartedState; message: string }

/** What a chat's listeners hear. */
export type TerminalEvent =
  | { kind: 'started'; pid: number }
  | { kind: 'output'; data: string }
  /**
   * The PTY ended; `message` says why when main stopped it (a folder that moved, a deleted chat, idle, quit), and
   * `resumed` whether it was started on an earlier session of the chat (which the CLI may have refused).
   */
  | { kind: 'exited'; exitCode: number; signal: number | null; message: string | null; resumed: boolean }
  | { kind: 'not_started'; state: NotStartedState; message: string }

export type TerminalListener = (event: TerminalEvent) => void

/** How an attach starts the chat's CLI when none runs: `newSession` forgets the session a start would resume. */
export interface AttachOptions {
  newSession?: boolean
}

/** Start run's (and Transfer with agent's) start: the kickoff, which goes with it when it is the chat's first (`kickoffSent` unset). */
interface StartOptions {
  kickoff: string
}

/** What `start` answers: the PTY runs (it may have exited since), or why it did not start. */
type TerminalStart = { state: 'running'; pid: number } | { state: NotStartedState; message: string }

export interface TerminalSessions {
  /** Starts the chat's PTY when none runs, and subscribes `listener` to the chat; see the module comment. */
  attach(ref: ChatRef, listener?: TerminalListener, options?: AttachOptions): Promise<TerminalAttach>
  /**
   * Start run's start: the chat's PTY when none runs, with the kickoff (see the module comment), resolving once it
   * runs or did not start, past the sign-in check. Subscribes no one.
   */
  start(ref: ChatRef, options: StartOptions): Promise<TerminalStart>
  /** Stops `listener` hearing the chat. */
  detach(chatId: string, listener: TerminalListener): void
  /** Input for the chat's running PTY, as typed; nothing when none runs. Input counts as activity. */
  write(chatId: string, data: string): void
  /** Resizes the chat's running PTY and its screen together. */
  resize(chatId: string, cols: number, rows: number): void
  /**
   * Deletes a chat with its terminal: kills its PTY (or cancels its start), then runs `remove` (the chat store's
   * delete) once the kill has settled, refusing every start of the chat until `remove` has settled.
   */
  deleteChat(ref: ChatRef, remove: () => Promise<void>): Promise<void>
  /** Kills the PTYs of every chat of a removed agent, and cancels their starts. */
  endAgent(id: AgentId): Promise<void>
  /** True while a PTY runs, a start is under way, or a revoke or kill has not settled. */
  busy(): boolean
  /** Quit: see the module comment. */
  dispose(): Promise<void>
}

interface TerminalTimers {
  /** Runs `callback` every `ms`; the returned function stops it. */
  repeat(callback: () => void, ms: number): () => void
  /** Runs `callback` once after `ms`; the returned function cancels it. */
  after(callback: () => void, ms: number): () => void
  /** Milliseconds on a clock that never goes back. */
  now(): number
}

/** The runs an orchestrator chat acts on, through the desktop's own session: the only one that may pause with `signed_out`. */
interface OrchestratorRuns {
  getRun(folder: string, runId: string): Promise<{ state: RunState } | null>
  pauseRun(folder: string, input: { runId: string; reason: string }): Promise<unknown>
}

export interface TerminalSessionsDeps {
  store: Pick<ChatStore, 'getChat' | 'updateChat'>
  /** The connected agent with this id, or null. */
  agentFor: (id: AgentId) => AgentView | null
  folders: LaunchFolderDeps
  /** The CLI's own sign-in status (`getAgentAuthStatus`). */
  checkAuth: (kind: BuiltInAgentKind, executablePath: string) => Promise<AgentAuthStatus>
  /** The `dm` invocation pinned to `folder`, without a grant: what the start files name. */
  cliFor: (folder: string) => DarkMechanicusCli
  runs: OrchestratorRuns
  issueChatCli: (folder: string, grant: { role: ChatRole; allowSave: boolean; label: string }) => Promise<{ cli: DarkMechanicusCli; grantId: string }>
  /** Never throws (`chatGrants.ts`). */
  revokeChatGrant: (grantId: string) => Promise<void>
  /** The PTY host; rejects when PTYs cannot run here (no prebuild, a helper that cannot run). */
  host: () => Promise<PtyHost>
  /** Ends a PTY's process tree; `killPtyTree` by default. */
  killTree?: (tree: PtyTree) => Promise<boolean>
  userData: string
  platform: NodeJS.Platform
  /** main's `process.env`. */
  env: Readonly<Record<string, string | undefined>>
  newSessionId?: () => string
  timers?: TerminalTimers
  onError?: (error: unknown) => void
}

interface Subscriber {
  listener: TerminalListener
  /** What it heard before its attach answered; null once released. */
  held: TerminalEvent[] | null
}

/** The one paste a start asked for (`pasteFirst`), waiting for the CLI's first screen to settle. */
interface FirstPaste {
  text: string
  /** Whether it carries the kickoff, so `kickoffSent` is stored once it is written. */
  kickoff: boolean
  /** Whether the CLI has turned bracketed paste on, which starts the wait. */
  armed: boolean
  /** The end of the output before that, too short to hold the whole sequence. */
  seen: string
  /** When the screen last took output (`timers.now`), once armed. */
  lastOutput: number
  /** Cancels the timer that waits for the screen to settle, and once the paste is written, the one for its Enter. */
  cancel: () => void
}

/** A chat whose PTY is running (or has just exited and is still putting its last output on the screen). */
interface Live {
  kind: 'live'
  chat: ChatRecord
  pty: PtyProcess
  screen: TerminalScreen
  tree: PtyTree
  grantId: string
  /** Why main stopped it, once it has; null while it runs on, or when it exited on its own. */
  stopMessage: string | null
  exited: boolean
  /** Settles when the PTY has reported its exit. */
  ended: Promise<void>
  /** Settles once the exit is on the screen, has been told to listeners, and the chat can start again. */
  closed: Promise<void>
  /** The screen it ended with and its exit, once closed. */
  last: { snapshot: string; exit: Extract<TerminalEvent, { kind: 'exited' }> } | null
  /** Whether it was started on an earlier session of the chat. */
  resumed: boolean
  /** Whether its first input still has to mark the chat's session started (`sessionStarted`). */
  marksStarted: boolean
  /** When it last had input, or output on its screen (`timers.now`). */
  lastActive: number
  /** The paste still to be written; null when the start asked for none, once written, and once stopped or exited. */
  firstPaste: FirstPaste | null
  revoke: () => Promise<void>
  /** Ends the folder watch, the idle timer, and the wait for the first paste. */
  stopWatch: () => void
}

type StartOutcome = { state: 'running'; live: Live } | { state: NotStartedState; message: string }

/** A start under way. */
interface Starting {
  kind: 'starting'
  agentId: AgentId
  /** `checking` until the sign-in check has answered. */
  phase: 'checking' | 'preparing'
  done: Promise<StartOutcome>
  cancel: (message: string) => void
}

interface Manager {
  deps: Required<Omit<TerminalSessionsDeps, 'onError'>>
  onError: (error: unknown) => void
  entries: Map<string, Live | Starting>
  listeners: Map<string, Map<TerminalListener, Subscriber>>
  /** Revokes and kills not yet settled: the quit waits for them before the workspaces close. */
  pending: Set<Promise<unknown>>
  /** Chats being deleted, which nothing may start. */
  deleting: Set<string>
  closing: boolean
}

const nodeTimers: TerminalTimers = {
  repeat: (callback, ms) => {
    const interval = setInterval(callback, ms)
    interval.unref()
    return () => {
      clearInterval(interval)
    }
  },
  after: (callback, ms) => {
    const timeout = setTimeout(callback, ms)
    timeout.unref()
    return () => {
      clearTimeout(timeout)
    }
  },
  now: () => performance.now()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emitTo(manager: Manager, subscriber: Subscriber, event: TerminalEvent): void {
  if (subscriber.held !== null) {
    subscriber.held.push(event)
    return
  }
  try {
    subscriber.listener(event)
  } catch (error) {
    manager.onError(error)
  }
}

function emit(manager: Manager, chatId: string, event: TerminalEvent): void {
  for (const subscriber of manager.listeners.get(chatId)?.values() ?? []) {
    emitTo(manager, subscriber, event)
  }
}

/**
 * Subscribes `listener` at this point of the chat's output. What it hears is held until the attach has answered:
 * released on a later turn of the event loop, after the caller's `await` has run.
 */
function subscribe(manager: Manager, chatId: string, listener: TerminalListener): Subscriber {
  const chat = manager.listeners.get(chatId) ?? new Map<TerminalListener, Subscriber>()
  manager.listeners.set(chatId, chat)
  // A listener attaching again is subscribed afresh, at this snapshot.
  const subscriber: Subscriber = { listener, held: [] }
  chat.set(listener, subscriber)
  setImmediate(() => {
    const held = subscriber.held ?? []
    subscriber.held = null
    if (chat.get(listener) === subscriber) {
      for (const event of held) {
        emitTo(manager, subscriber, event)
      }
    }
  })
  return subscriber
}

/** Keeps `work` where a quit can wait for it, until it settles. */
function track<T>(manager: Manager, work: Promise<T>): Promise<T> {
  manager.pending.add(work)
  const settled = (): void => {
    manager.pending.delete(work)
  }
  work.then(settled, settled)
  return work
}

/** Revokes `grantId`; never rejects. */
function revokeGrant(manager: Manager, grantId: string): Promise<void> {
  return track(
    manager,
    manager.deps.revokeChatGrant(grantId).catch((error: unknown) => {
      manager.onError(error)
    })
  )
}

/** Ends the PTY's process tree; never rejects. */
function killTree(manager: Manager, live: Live): Promise<unknown> {
  return track(
    manager,
    manager.deps.killTree(live.tree).catch((error: unknown) => {
      manager.onError(error)
    })
  )
}

/**
 * The pre-start step: the files the chat's CLI is started with, written before its grant is issued, so a failed
 * write issues nothing. The instructions and, on macOS, the chat's `dm` launcher; for Claude also its settings
 * file with the memory guards (`claudeSettingsFile.ts`), passed as `files.claudeSettings`.
 */
async function writeStartFiles(manager: Manager, chat: ChatRecord, agent: AgentView, folder: string): Promise<TerminalFiles> {
  const { userData, platform } = manager.deps
  const cli = manager.deps.cliFor(folder)
  const files = await writeTerminalFiles({
    userData,
    chatId: chat.id,
    platform,
    folder,
    cli,
    role: chat.role,
    allowSave: chat.allowSave,
    orchestratesRun: chat.runId !== undefined
  })
  if (agent.kind !== 'claude') {
    return files
  }
  return { ...files, claudeSettings: await writeClaudeSettings({ userData, chatId: chat.id, platform, folder, cli, home: homedir(), tmp: tmpdir() }) }
}

/** Stops a running PTY for `message`: the folder watch ends, the grant is revoked, and the tree is killed. Never rejects. */
function stop(manager: Manager, live: Live, message: string): Promise<unknown> {
  live.stopWatch()
  void live.revoke()
  if (live.exited) {
    return Promise.resolve()
  }
  live.stopMessage ??= message
  return killTree(manager, live)
}

/** Whether the chat's folder still passes the launch check; a running PTY is stopped with its message when not. */
function folderStillValid(manager: Manager, live: Live): string | null {
  try {
    resolveLaunchFolder(live.chat, manager.deps.folders)
    return null
  } catch (error) {
    const message = messageOf(error)
    void stop(manager, live, message)
    return message
  }
}

/** After a PTY's exit: once the output still going onto the screen has been told, the exit is told last and the chat can start again. */
function closeAfterExit(manager: Manager, live: Live, exit: PtyExit, reportClosed: () => void): void {
  live.screen.snapshot((snapshot) => {
    if (manager.entries.get(live.chat.id) === live) {
      manager.entries.delete(live.chat.id)
    }
    const exited = { kind: 'exited', exitCode: exit.exitCode, signal: exit.signal, message: live.stopMessage, resumed: live.resumed } as const
    live.last = { snapshot, exit: exited }
    emit(manager, live.chat.id, exited)
    live.screen.dispose()
    reportClosed()
  })
}

/**
 * The watches on a running PTY; answers the function that ends them, which also gives up the first paste. Its
 * folder is checked every minute. It is stopped once it has gone `IDLE_MS` with no activity: a timer set for the
 * earliest moment it can be idle, checked against `lastActive` when it fires, so activity costs a timestamp and
 * not a new timer.
 */
function watchLive(manager: Manager, live: Live): () => void {
  const { timers } = manager.deps
  const stopFolderWatch = timers.repeat(() => {
    folderStillValid(manager, live)
  }, FOLDER_CHECK_MS)
  let stopIdleWatch: () => void = () => {}
  const check = (): void => {
    const quiet = timers.now() - live.lastActive
    if (quiet >= IDLE_MS) {
      void stop(manager, live, IDLE_STOPPED)
    } else {
      stopIdleWatch = timers.after(check, IDLE_MS - quiet)
    }
  }
  stopIdleWatch = timers.after(check, IDLE_MS)
  return () => {
    stopFolderWatch()
    stopIdleWatch()
    live.firstPaste?.cancel()
    live.firstPaste = null
  }
}

/** `text` as one bracketed paste, as xterm.js pastes: newlines as CR, and every other control character but tab taken out. */
function bracketedPaste(text: string): string {
  return `${PASTE_START}${text.replace(/\r?\n/g, '\r').replace(/[^\P{Cc}\t\r]/gu, '')}${PASTE_END}`
}

/**
 * Writes the first paste as input the person typed, then Enter as its own keypress `ENTER_DELAY_MS` later
 * (Autonomous takes an Enter that arrives with the paste as part of it, verified live); the kickoff is stored as
 * sent once the Enter has gone.
 */
function writeFirstPaste(manager: Manager, live: Live, paste: FirstPaste): void {
  writeInput(manager, live, bracketedPaste(paste.text))
  paste.cancel = manager.deps.timers.after(() => {
    live.firstPaste = null
    writeInput(manager, live, ENTER)
    if (paste.kickoff) {
      try {
        manager.deps.store.updateChat(live.chat, { kickoffSent: true })
      } catch (error) {
        manager.onError(error)
      }
    }
  }, ENTER_DELAY_MS)
}

/**
 * The screen took `data` while the first paste waits. The wait starts once the CLI has turned bracketed paste on
 * (`BRACKETED_PASTE_ON`, which a TUI sends when its input is live; Autonomous goes quiet for seconds while it starts
 * before it does, verified live), and the paste goes once the screen has then taken nothing for `SETTLE_MS` (the
 * timer is set for the earliest moment, then checked against `lastOutput`, as the idle stop's is). A CLI that never
 * turns it on is pasted nothing.
 */
function settleFirstPaste(manager: Manager, live: Live, paste: FirstPaste, data: string): void {
  const { timers } = manager.deps
  if (!paste.armed) {
    // Kept short of a whole sequence, so one split across two chunks is still found.
    const seen = paste.seen + data
    if (!seen.includes(BRACKETED_PASTE_ON)) {
      paste.seen = seen.slice(-(BRACKETED_PASTE_ON.length - 1))
      return
    }
  }
  paste.lastOutput = timers.now()
  if (paste.armed) {
    return
  }
  paste.armed = true
  const check = (): void => {
    const quiet = timers.now() - paste.lastOutput
    if (quiet >= SETTLE_MS) {
      writeFirstPaste(manager, live, paste)
    } else {
      paste.cancel = timers.after(check, SETTLE_MS - quiet)
    }
  }
  paste.cancel = timers.after(check, SETTLE_MS)
}

interface Started {
  pty: PtyProcess
  screen: TerminalScreen
  grantId: string
  resumed: boolean
  marksStarted: boolean
  /** The launch's `pasteFirst`, and whether the kickoff is in it; null when there is none. */
  firstPaste: Pick<FirstPaste, 'text' | 'kickoff'> | null
}

/** Output the screen has taken: activity for the idle stop, told to listeners, and the first paste's wait goes on. */
function tookOutput(manager: Manager, live: Live, data: string): void {
  live.lastActive = manager.deps.timers.now()
  emit(manager, live.chat.id, { kind: 'output', data })
  if (live.firstPaste !== null) {
    settleFirstPaste(manager, live, live.firstPaste, data)
  }
}

/** Tracks a PTY just spawned, with the screen made for it: nothing here can fail, so no PTY runs untracked. */
function startLive(manager: Manager, chat: ChatRecord, started: Started): Live {
  const { pty, screen, grantId } = started
  let reportEnded: () => void = () => {}
  let reportClosed: () => void = () => {}
  const ended = new Promise<void>((resolve) => {
    reportEnded = resolve
  })
  const closed = new Promise<void>((resolve) => {
    reportClosed = resolve
  })
  let revoked: Promise<void> | null = null
  const live: Live = {
    kind: 'live',
    chat,
    pty,
    screen,
    grantId,
    stopMessage: null,
    exited: false,
    ended,
    closed,
    last: null,
    resumed: started.resumed,
    marksStarted: started.marksStarted,
    lastActive: manager.deps.timers.now(),
    firstPaste: started.firstPaste === null ? null : { ...started.firstPaste, armed: false, seen: '', lastOutput: 0, cancel: () => {} },
    tree: { pid: pty.pid, kill: () => pty.kill(), exited: ended, hasExited: () => live.exited },
    revoke: () => (revoked ??= revokeGrant(manager, grantId)),
    stopWatch: () => {}
  }
  wireLive(manager, live, reportEnded, reportClosed)
  live.stopWatch = watchLive(manager, live)
  return live
}

/**
 * Wires a just-tracked PTY: its output goes to the screen and the attached views, and its exit ends the entry (the
 * grant revoked, its process group killed, an orchestrator's run paused when it signed out) before `reportClosed`.
 */
function wireLive(manager: Manager, live: Live, reportEnded: () => void, reportClosed: () => void): void {
  const { pty, screen, chat } = live
  const stopData = pty.onData((data) => {
    screen.write(data, () => {
      tookOutput(manager, live, data)
    })
  })
  const stopExit = pty.onExit((exit) => {
    live.exited = true
    reportEnded()
    live.stopWatch()
    void live.revoke()
    // Asked now, while the group's id can only be the CLI's: ends what it left running in its process group.
    void killTree(manager, live)
    if (live.stopMessage === null) {
      void track(manager, pauseIfSignedOut(manager, chat))
    }
    stopData()
    stopExit()
    closeAfterExit(manager, live, exit, reportClosed)
  })
}

/** After an orchestrator chat's CLI exited on its own: pauses its run with `signed_out` when the status says signed out. Never rejects. */
async function pauseIfSignedOut(manager: Manager, chat: ChatRecord): Promise<void> {
  const agent = manager.deps.agentFor(chat.agent)
  if (chat.runId === undefined || agent === null || agent.kind === 'custom') {
    return
  }
  try {
    const status = await manager.deps.checkAuth(agent.kind, agent.executablePath)
    if (status.state !== 'signed_out' || manager.closing) {
      return
    }
    await pauseRunIfActive(manager, chat.folder, chat.runId)
  } catch (error) {
    manager.onError(error)
  }
}

/** Pauses the run with `signed_out` while it is running or already paused; a finished or missing run is left alone. */
async function pauseRunIfActive(manager: Manager, folder: string, runId: string): Promise<void> {
  const run = await manager.deps.runs.getRun(folder, runId)
  if (run?.state === 'running' || run?.state === 'paused') {
    await manager.deps.runs.pauseRun(folder, { runId, reason: SIGNED_OUT_PAUSE_REASON })
  }
}

/** Input for the chat's running PTY: activity for the idle stop, and the first input marks its session started. */
function writeInput(manager: Manager, live: Live, data: string): void {
  live.pty.write(data)
  live.lastActive = manager.deps.timers.now()
  if (live.marksStarted) {
    live.marksStarted = false
    try {
      manager.deps.store.updateChat(live.chat, { sessionStarted: true })
    } catch (error) {
      manager.onError(error)
    }
  }
}

/** What a cancelled step answers, and the error a cancelled start is thrown out with. */
const CANCELLED = Symbol('cancelled')
class Cancelled extends Error {}
/** Thrown out of a start whose folder failed the launch check at a later step; the start is refused with its message. */
class FolderRefused extends Error {}

/** `work`'s result unless the start is cancelled first; a result that arrives after the cancel goes to `late`. */
type Step = <T>(work: Promise<T>, late?: (value: T) => void) => Promise<T>

/** One start: the chat, its agent, its checked folder, its entry, and the kickoff Start run gave it (else null). */
interface StartContext {
  manager: Manager
  chat: ChatRecord
  agent: AgentView
  folder: string
  starting: Starting
  kickoff: string | null
}

/** Makes `starting` cancellable: each step gives way to a cancel at once (a sign-in check can take 30 s). */
function cancellableSteps(starting: Starting): { step: Step; cancelled: () => string | null } {
  let cancelled: string | null = null
  let wake: () => void = () => {}
  const cancelSignal = new Promise<typeof CANCELLED>((resolve) => {
    wake = () => resolve(CANCELLED)
  })
  starting.cancel = (message) => {
    cancelled ??= message
    wake()
  }
  const step: Step = async (work, late) => {
    const settled = work.then((value) => ({ value }))
    // A step given up on may still fail later; that is no longer this start's failure.
    settled.catch(() => {})
    const won = await Promise.race([settled, cancelSignal])
    if (won === CANCELLED) {
      settled.then(({ value }) => late?.(value), () => {})
      throw new Cancelled()
    }
    if (cancelled !== null) {
      late?.(won.value)
      throw new Cancelled()
    }
    return won.value
  }
  return { step, cancelled: () => cancelled }
}

/**
 * The launch check again, at a later step of a start: the folder can be moved, swapped or untracked while the
 * sign-in check runs (up to 30 s), and nothing may then be issued or started for it.
 */
function recheckFolder(context: StartContext): void {
  try {
    resolveLaunchFolder(context.chat, context.manager.deps.folders)
  } catch (error) {
    throw new FolderRefused(messageOf(error))
  }
}

/** The steps before a spawn, in their order (see the module comment). */
async function runStart(context: StartContext, step: Step): Promise<StartOutcome> {
  const { manager, chat, agent, folder, starting } = context
  if (agent.kind !== 'custom') {
    const status = await step(manager.deps.checkAuth(agent.kind, agent.executablePath).catch((): AgentAuthStatus | null => null))
    if (status?.state === 'signed_out') {
      return { state: 'signed_out', message: status.reason }
    }
    starting.phase = 'preparing'
  }
  const files = await step(writeStartFiles(manager, chat, agent, folder))
  recheckFolder(context)
  const grant = { role: chat.role, allowSave: chat.allowSave, label: `${agent.displayName} · ${chat.title}` }
  const issued = await step(manager.deps.issueChatCli(folder, grant), ({ grantId }) => {
    void revokeGrant(manager, grantId)
  })
  try {
    return { state: 'running', live: await spawnWithGrant(context, files, issued, step) }
  } catch (error) {
    void revokeGrant(manager, issued.grantId)
    throw error
  }
}

function startSteps(context: StartContext): Promise<StartOutcome> {
  const { step, cancelled } = cancellableSteps(context.starting)
  return runStart(context, step).catch((error: unknown): StartOutcome => {
    if (error instanceof FolderRefused) {
      return { state: 'refused', message: error.message }
    }
    return { state: 'failed', message: error instanceof Cancelled ? (cancelled() ?? QUITTING) : messageOf(error) }
  })
}

/** Whether the chat's CLI has a session a start resumes: Claude's session file, else the chat's flag. */
function sessionStarted(manager: Manager, chat: ChatRecord, agent: AgentView, folder: string): boolean {
  if (agent.kind !== 'claude') {
    return chat.sessionStarted === true
  }
  return chat.sessionId !== null && claudeSessionExists({ env: manager.deps.env, platform: manager.deps.platform, folder, sessionId: chat.sessionId })
}

/**
 * Builds the launch, stores the grant's id, the session id the CLI runs under and a kickoff on its command line
 * (`kickoffSent`) on the chat, then spawns; throws on any failure (the caller revokes).
 */
async function spawnWithGrant(context: StartContext, files: TerminalFiles, issued: { cli: DarkMechanicusCli; grantId: string }, step: Step): Promise<Live> {
  const { manager, chat, agent, folder } = context
  const spec = terminalLaunchSpec({
    chat: { ...chat, sessionStarted: sessionStarted(manager, chat, agent, folder), kickoffSent: chat.kickoffSent === true },
    kickoff: context.kickoff,
    agent,
    folder,
    cli: issued.cli,
    files,
    platform: manager.deps.platform,
    env: manager.deps.env,
    newSessionId: manager.deps.newSessionId
  })
  const host = await step(manager.deps.host())
  // The last await is behind: from this check to the spawn nothing else runs.
  recheckFolder(context)
  const stored = manager.deps.store.getChat(chat)?.grantIds ?? []
  manager.deps.store.updateChat(chat, {
    grantIds: [...stored, issued.grantId],
    ...(spec.sessionId === null ? {} : { sessionId: spec.sessionId }),
    ...(spec.kickoffIn === 'args' ? { kickoffSent: true } : {})
  })
  const screen = createTerminalScreen(START_COLS, START_ROWS)
  let pty: PtyProcess
  try {
    pty = host.spawn({ file: spec.file, args: spec.commandLine ?? spec.args, cwd: spec.cwd, env: spec.env, cols: START_COLS, rows: START_ROWS })
  } catch (error) {
    screen.dispose()
    throw error
  }
  const marksStarted = agent.kind !== 'claude' && agent.kind !== 'custom' && chat.sessionStarted !== true
  const firstPaste = spec.pasteFirst === null ? null : { text: spec.pasteFirst, kickoff: spec.kickoffIn === 'paste' }
  return startLive(manager, chat, { pty, screen, grantId: issued.grantId, resumed: spec.resumed, marksStarted, firstPaste })
}

/** Why a custom CLI marked `needsReview` (its arguments were saved for a protocol server) starts no chat, and what to do. */
function needsReviewMessage(agent: AgentView): string {
  return `${agent.displayName} was saved with arguments for a chat protocol the app no longer speaks, so it does not start until you review them. Open it under Agents and choose Review arguments.`
}

/** Begins the chat's start, or refuses it at once when its folder or agent fails; see `AttachOptions` and `StartOptions`. */
function beginStart(manager: Manager, found: ChatRecord, options: AttachOptions & Partial<StartOptions>): Starting | { state: 'refused'; message: string } {
  let chat = found
  if (manager.deleting.has(chat.id)) {
    return { state: 'refused', message: DELETED }
  }
  let folder: string
  try {
    folder = resolveLaunchFolder(chat, manager.deps.folders)
  } catch (error) {
    return { state: 'refused', message: messageOf(error) }
  }
  const agent = manager.deps.agentFor(chat.agent)
  if (agent === null) {
    return { state: 'refused', message: `No connected agent has the id ${chat.agent}. Connect it under Agents first.` }
  }
  if (agent.needsReview) {
    return { state: 'refused', message: needsReviewMessage(agent) }
  }
  if (options.newSession === true) {
    chat = manager.deps.store.updateChat(chat, { sessionId: null, sessionStarted: false })
  }
  const starting: Starting = {
    kind: 'starting',
    agentId: agent.id,
    phase: agent.kind === 'custom' ? 'preparing' : 'checking',
    done: Promise.resolve({ state: 'failed', message: QUITTING }),
    cancel: () => {}
  }
  manager.entries.set(chat.id, starting)
  starting.done = startSteps({ manager, chat, agent, folder, starting, kickoff: options.kickoff ?? null }).then((outcome) => {
    if (manager.entries.get(chat.id) === starting) {
      if (outcome.state === 'running' && !outcome.live.exited) {
        manager.entries.set(chat.id, outcome.live)
      } else {
        manager.entries.delete(chat.id)
      }
    }
    emit(manager, chat.id, outcome.state === 'running' ? { kind: 'started', pid: outcome.live.pty.pid } : { kind: 'not_started', ...outcome })
    return outcome
  })
  return starting
}

/** The running PTY's snapshot, with `listener` subscribed at the same point of the output. */
function attachLive(manager: Manager, live: Live, listener: TerminalListener | undefined): Promise<TerminalAttach> {
  if (live.stopMessage !== null) {
    return Promise.resolve({ state: 'refused', message: live.stopMessage })
  }
  const refused = folderStillValid(manager, live)
  if (refused !== null) {
    return Promise.resolve({ state: 'refused', message: refused })
  }
  return new Promise((resolve) => {
    live.screen.snapshot((snapshot) => {
      if (listener !== undefined) {
        subscribe(manager, live.chat.id, listener)
      }
      resolve({ state: 'running', pid: live.pty.pid, snapshot })
    })
  })
}

/**
 * The answer for a PTY the attach waited to start, which exited before the answer (a CLI that refused its resume):
 * the screen it ended with, and its exit told to `listener` after the answer, as a PTY that exits later would be.
 */
async function attachEnded(manager: Manager, live: Live, listener: TerminalListener | undefined): Promise<TerminalAttach> {
  await live.closed
  const last = live.last ?? { snapshot: '', exit: { kind: 'exited', exitCode: 0, signal: null, message: live.stopMessage, resumed: live.resumed } }
  if (listener !== undefined) {
    emitTo(manager, subscribe(manager, live.chat.id, listener), last.exit)
  }
  return { state: 'running', pid: live.pty.pid, snapshot: last.snapshot }
}

/** What an attach makes of the chat's entry: an answer, or a PTY that had exited before it came, to be waited out. */
async function attachEntry(manager: Manager, chat: ChatRecord, listener: TerminalListener | undefined, options: AttachOptions): Promise<TerminalAttach | Live> {
  const entry = manager.entries.get(chat.id) ?? beginStart(manager, chat, options)
  if (!('kind' in entry)) {
    return entry
  }
  if (entry.kind === 'live') {
    return entry.exited ? entry : attachLive(manager, entry, listener)
  }
  if (entry.phase === 'checking') {
    if (listener !== undefined) {
      subscribe(manager, chat.id, listener)
    }
    return { state: 'checking' }
  }
  const outcome = await entry.done
  if (outcome.state !== 'running') {
    return outcome
  }
  return outcome.live.exited ? attachEnded(manager, outcome.live, listener) : attachLive(manager, outcome.live, listener)
}

async function attach(manager: Manager, ref: ChatRef, listener: TerminalListener | undefined, options: AttachOptions): Promise<TerminalAttach> {
  for (;;) {
    if (manager.closing) {
      return { state: 'failed', message: QUITTING }
    }
    // Read on each round: the chat may have been deleted while its last PTY exited.
    const chat = manager.deps.store.getChat(ref)
    if (chat === null) {
      return { state: 'refused', message: `No chat ${ref.id} in ${ref.folder}.` }
    }
    const answer = await attachEntry(manager, chat, listener, options)
    if (!('kind' in answer)) {
      return answer
    }
    // A PTY that had exited before this attach came: once the exit has been told, the chat starts again.
    await answer.closed
  }
}

/** `TerminalSessions.start`: a PTY that already runs (or has just exited) answers as running, and gets no kickoff. */
async function start(manager: Manager, ref: ChatRef, options: StartOptions): Promise<TerminalStart> {
  if (manager.closing) {
    return { state: 'failed', message: QUITTING }
  }
  const chat = manager.deps.store.getChat(ref)
  if (chat === null) {
    return { state: 'refused', message: `No chat ${ref.id} in ${ref.folder}.` }
  }
  const entry = manager.entries.get(chat.id) ?? beginStart(manager, chat, { kickoff: options.kickoff })
  if (!('kind' in entry)) {
    return entry
  }
  const outcome = entry.kind === 'live' ? { state: 'running' as const, live: entry } : await entry.done
  return outcome.state === 'running' ? { state: 'running', pid: outcome.live.pty.pid } : outcome
}

/**
 * Ends a chat's entry for `message`: a running PTY is stopped at once (before this returns); a start is cancelled,
 * and its PTY stopped when it got that far. Resolves with the PTY and its kill, or null when there was none.
 */
function endEntry(manager: Manager, entry: Live | Starting, message: string): Promise<{ live: Live; kill: Promise<unknown> } | null> {
  if (entry.kind === 'live') {
    return Promise.resolve({ live: entry, kill: stop(manager, entry, message) })
  }
  entry.cancel(message)
  return entry.done.then((outcome) => (outcome.state === 'running' ? { live: outcome.live, kill: stop(manager, outcome.live, message) } : null))
}

/** Ends the chat's start or PTY for `message`; resolves once the kill has settled. */
async function endTerminal(manager: Manager, chatId: string, message: string): Promise<void> {
  const entry = manager.entries.get(chatId)
  if (entry !== undefined) {
    await (await endEntry(manager, entry, message))?.kill
  }
}

/** `TerminalSessions.deleteChat`. */
async function deleteChat(manager: Manager, ref: ChatRef, remove: () => Promise<void>): Promise<void> {
  const chat = manager.deps.store.getChat(ref)
  if (chat === null) {
    // Nothing of it runs here; the store's delete answers for a chat it does not have.
    await remove()
    return
  }
  manager.deleting.add(chat.id)
  try {
    await endTerminal(manager, chat.id, DELETED)
    await remove()
  } finally {
    manager.deleting.delete(chat.id)
  }
}

async function endAgent(manager: Manager, id: AgentId): Promise<void> {
  const chats = [...manager.entries].filter(([, entry]) => (entry.kind === 'live' ? entry.chat.agent : entry.agentId) === id)
  await Promise.all(chats.map(([chatId]) => endTerminal(manager, chatId, AGENT_REMOVED)))
}

async function dispose(manager: Manager): Promise<void> {
  manager.closing = true
  const ending = [...manager.entries.values()].map(async (entry) => {
    await (await endEntry(manager, entry, QUITTING))?.live.ended
  })
  await Promise.all(ending)
  await Promise.all(manager.pending)
}

export function createTerminalSessions(deps: TerminalSessionsDeps): TerminalSessions {
  const { onError, ...rest } = deps
  const manager: Manager = {
    deps: {
      ...rest,
      killTree: deps.killTree ?? ((tree) => killPtyTree(tree)),
      newSessionId: deps.newSessionId ?? randomUUID,
      timers: deps.timers ?? nodeTimers
    },
    onError: onError ?? (() => {}),
    entries: new Map(),
    listeners: new Map(),
    pending: new Set(),
    deleting: new Set(),
    closing: false
  }
  const running = (chatId: string): Live | null => {
    const entry = manager.entries.get(chatId)
    return entry?.kind === 'live' && !entry.exited ? entry : null
  }
  return {
    attach: (ref, listener, options = {}) => attach(manager, ref, listener, options),
    start: (ref, options) => start(manager, ref, options),
    detach: (chatId, listener) => {
      manager.listeners.get(chatId)?.delete(listener)
    },
    write: (chatId, data) => {
      const live = running(chatId)
      if (live !== null) {
        writeInput(manager, live, data)
      }
    },
    resize: (chatId, cols, rows) => {
      const live = running(chatId)
      if (live !== null) {
        live.pty.resize(cols, rows)
        live.screen.resize(cols, rows)
      }
    },
    deleteChat: (ref, remove) => deleteChat(manager, ref, remove),
    endAgent: (id) => endAgent(manager, id),
    busy: () => manager.entries.size > 0 || manager.pending.size > 0,
    dispose: () => dispose(manager)
  }
}

/** `chats` with deleting a chat killing its terminal first: the record goes only once the kill has settled, and nothing starts it meanwhile. */
export function endingTerminals<T extends { deleteChat(ref: ChatRef): Promise<void> }>(chats: T, terminals: Pick<TerminalSessions, 'deleteChat'>): T {
  return { ...chats, deleteChat: (ref: ChatRef) => terminals.deleteChat(ref, () => chats.deleteChat(ref)) }
}
