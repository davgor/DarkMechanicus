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
 * 4. the grant, issued through `chatGrants` for the chat's trusted identity: an OMP chat's grant comes back already
 *    bound to the chat's mailbox (`chatMailboxes.ts`), so no Skitarii CLI ever runs on an unbound grant;
 * 5. the grant's id and the mailbox's id, stored on the chat record (`grantIds`, `endpointId` in `index.jsonl`), then
 *    the spawn.
 *
 * The folder check runs again before the grant and right before the spawn, since the folder can go away during
 * the sign-in check; a start cancelled (a deleted chat, a removed agent, an untracked folder, quit) stops at its next
 * step, and a grant that arrives after the cancel is revoked, its mailbox binding closed with it, and never spawned.
 *
 * The grant is revoked on every way out: the PTY exits, it is killed (a deleted chat, a removed agent, a folder
 * that moved, quit), the spawn fails, or the start is cancelled after the grant was issued (also when the grant
 * arrives after the cancel). A CLI that exits on its own has what it left running in its process group ended
 * (`killPtyTree`, asked from the exit). A chat being deleted starts nothing until its record is gone.
 *
 * **Project-less chats** (`folder` null, summoned from the AGENTS section) start in their own scratch folder
 * (`scratchFolder.ts`, made at the start), so no folder check applies to them. Instead of one grant they hold one per
 * tracked, set-up folder (`reachFolders`, read at the start; `chatReach.ts`), issued together (`issueReachCli`) and
 * stored, renewed, bound for naming and revoked together on every way out above. With no such folder it starts with no
 * grant at all, and its instructions say no folder is tracked yet; a folder tracked later is reached from its next start.
 * A project-less chat has no mailbox: none of its grants is bound to one, and it gets no mail client descriptor.
 *
 * **Screen.** Each PTY's output goes through a headless terminal of the same size (`terminalScreen.ts`). An
 * attach answers with its serialized snapshot and subscribes its listener at that same point in the output, so
 * the listener hears exactly what came after the snapshot; output reaches listeners once it is on the screen.
 * What a listener hears from an attach is held until that attach has answered.
 * Main's persistent emulator also answers its supported terminal control queries directly to the PTY,
 * independent of selection or attaches. Panes suppress those automatic replies (`terminalQueryResponses.ts`),
 * so there is one response owner even for a query split across attach/detach. These are not user input.
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
 * **No idle stop.** A PTY runs until its CLI exits or main stops it (a deleted chat, a removed agent, a folder that
 * moved, quit). A quiet one may be running a long command or waiting on its workers, so going quiet never stops it.
 * While it runs its grant is renewed every hour (`renewChatGrant`), to the grant's length from then, so a chat that
 * runs for days keeps its role, and one whose app died loses it within that length; and it holds the computer awake
 * (`keepAwake`, given back once when it is stopped or exits), so going to sleep does not pause it either.
 *
 * **Kickoff and pastes** ("The orchestrator chat Start run opens"). `start` is Start run's (and Transfer with
 * agent's, and Play's for a Kanban card): it starts the chat's PTY with the kickoff, which goes only when the record's
 * `kickoffSent` is not set and the start is not a resume. Claude Code takes it as its positional prompt, and
 * `kickoffSent` is stored with the grant's id before the spawn. What the launch could not put on the command line
 * (`pasteFirst`: the kickoff for every other CLI, the instructions too for one with no instructions flag or behind a
 * `.cmd`) is the PTY's first paste. `paste` is Kick back's: it adds a paste (the masked kick-back message) to the
 * chat's running PTY, after any paste still waiting, or starts the PTY as an attach does (a resume when the CLI has a
 * session, never with the kickoff) and adds it there. Every paste is written once the CLI has turned bracketed paste
 * on and the screen has then taken no output for a second, one at a time: as one bracketed paste, with every control
 * character but tab taken out, then Enter as a keypress of its own half a second later, as input the person typed (so
 * it marks the session started). A kickoff pasted stores `kickoffSent` once its Enter has gone. A PTY that exits or
 * is stopped first gets nothing more: what still waits in it is dropped.
 *
 * **Untrack.** `releaseFolder` refuses every start in the folder, stops its PTYs and cancels its starts, waits for
 * their kills and revokes, and only then runs the untrack itself (suspending the mailboxes, forgetting the folder and
 * closing its workspace), so nothing of the folder runs or binds after it is forgotten. Its mailboxes keep their mail.
 *
 * **Quit.** `busy` and `dispose` go to `disposeBeforeQuit`: `dispose` stops new starts, cancels the ones under
 * way, kills every PTY tree and resolves once every PTY has reported its exit and every revoke and kill has
 * settled; the quit's own bound (5 s) holds. Mailboxes keep their mail: only deleting a chat deletes its mailbox.
 *
 * **Signed out.** When an orchestrator chat's CLI exits on its own (not a quit, a deleted chat, a removed agent or a
 * folder stop, which all set the stop message first), main runs the agent's status command, and only when
 * it says `signed_out` is a `running` or `paused` run the chat orchestrates paused with the reason `signed_out`,
 * through the desktop's own session (`runs`): that reason keeps the run's leases, so it is given on nothing looser.
 */
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { LIMITS } from '../../core/schemas'
import type { ChatRecord, ChatRole, DarkMechanicusCli } from '../../shared/agents/chat'
import type { AgentAuthStatus, AgentId, AgentView, BuiltInAgentKind } from '../../shared/desktop/api'
import { SIGNED_OUT_PAUSE_REASON, type RunState } from '../../shared/domain/status'
import type { GrantChat, IssuedChatCli } from '../agents/chatGrants'
import { mailboxChat } from '../agents/chatMailboxOperations'
import { reachTargets, type ReachTarget } from '../agents/chatReach'
import { forgeReachFolders } from '../desktop/forgeContext'
import type { ChatRef, ChatStore } from '../agents/chatStore'
import { resolveLaunchFolder, type LaunchFolderDeps } from '../agents/launchFolder'
import { ensureScratchFolder } from '../agents/scratchFolder'
import { killPtyTree, type PtyTree } from '../agents/processTree'
import { readCultRules } from '../cults/cultRules'
import { claudeSessionExists } from './claudeSession'
import { ompAgentDir } from '../desktop/ompTheme'
import { installSkitariiTheme } from './ompSkitariiTheme'
import { ompSessionId, writeOmpFiles } from './ompSession'
import { writeClaudeSettings } from './claudeSettingsFile'
import type { PtyExit, PtyHost, PtyProcess } from './ptyHost'
import { terminalLaunchSpec, type TerminalLaunchSpec } from './terminalLaunchSpec'
import { removeDmClientDescriptor, writeDmClientDescriptor, writeRecoveryClientDescriptor, writeWorldMailDescriptor, writeTerminalFiles, type TerminalFiles } from './terminalFiles'
import { createTerminalScreen, type TerminalScreen } from './terminalScreen'
import { DomainError } from '../../core/errors'

/** How often a running PTY's folder is checked again. */
const FOLDER_CHECK_MS = 60_000
/** How often a running PTY's grant is renewed. */
const GRANT_RENEW_MS = 60 * 60_000
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
const SWITCHING = 'The chat is switching to the GUI, so its terminal was stopped.'
const AGENT_REMOVED = "The chat's agent was removed, so its terminal was stopped."
const UNTRACKED = "The chat's folder was untracked, so its terminal was stopped."
const ENDED = 'The chat was ended, so its terminal was stopped.'

/** Why a chat named by `ref` cannot be found. */
function noChat(ref: ChatRef): string {
  return `No chat ${ref.id} in ${ref.folder ?? 'the project-less chats'}.`
}

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
   * The PTY ended; `message` says why when main stopped it (a folder that moved, a deleted chat, quit), and
   * `resumed` whether it was started on an earlier session of the chat (which the CLI may have refused).
   */
  | { kind: 'exited'; exitCode: number; signal: number | null; message: string | null; resumed: boolean }
  | { kind: 'not_started'; state: NotStartedState; message: string }

export type TerminalListener = (event: TerminalEvent) => void

/** How an attach starts the chat's CLI when none runs: `newSession` forgets the session a start would resume. */
export interface AttachOptions {
  newSession?: boolean
}

/** Start run's (and Transfer with agent's, and Play's) start: the kickoff, which goes with it when it is the chat's first (`kickoffSent` unset). */
interface StartOptions {
  kickoff: string
  forgeSetupAuthorization?: symbol
}

/** What `start` and `paste` answer: the PTY runs (it may have exited since), or why it did not start. */
export type TerminalStart = { state: 'running'; pid: number } | { state: NotStartedState; message: string }

export interface TerminalSessions {
  /** Starts the chat's PTY when none runs, and subscribes `listener` to the chat; see the module comment. */
  attach(ref: ChatRef, listener?: TerminalListener, options?: AttachOptions): Promise<TerminalAttach>
  /**
   * Start run's start: the chat's PTY when none runs, with the kickoff (see the module comment), resolving once it
   * runs or did not start, past the sign-in check. Subscribes no one.
   */
  start(ref: ChatRef, options: StartOptions): Promise<TerminalStart>
  /**
   * Kick back's paste: `text` is pasted into the chat's PTY as typed input, after whatever paste is still waiting, and
   * submitted (see "Pastes" in the module comment). A chat with no PTY is started first, as an attach starts it (a
   * resume when the CLI has a session, never with the kickoff). Resolves once the text waits in a running PTY, or
   * with why it cannot: a PTY that exits or is stopped before its input is live drops it. Subscribes no one.
   */
  paste(ref: ChatRef, text: string, contextId?: string): Promise<TerminalStart>
  /** Stops `listener` hearing the chat. */
  detach(chatId: string, listener: TerminalListener): void
  /** Input for the chat's running PTY, as typed; nothing when none runs. */
  write(chatId: string, data: string): void
  /** Resizes the chat's running PTY and its screen together. */
  resize(chatId: string, cols: number, rows: number): void
  /**
   * Deletes a chat with its terminal: kills its PTY (or cancels its start), then runs `remove` (the chat store's
   * delete) once the kill has settled, refusing every start of the chat until `remove` has settled.
   */
  deleteChat(ref: ChatRef, remove: () => Promise<void>): Promise<void>
  /**
   * Untrack: refuses every start of the folder's chats, stops their PTYs and cancels their starts, waits until their
   * kills and revokes have settled, then runs `forget` (the untrack itself) before starts are let through again.
   */
  releaseFolder(folder: string, forget: () => unknown, relatedFolders?: readonly string[]): Promise<void>
  /** Kills the PTYs of every chat of a removed agent, and cancels their starts. */
  endAgent(id: AgentId): Promise<void>
  /**
   * Ends one chat's terminal (a cult member's end): with `graceful`, the PTY gets `withinMs` to exit on its own (see
   * `GracefulEnd`); then, or at once, its start is cancelled or its tree killed (`killPtyTree`) and its grants revoked.
   * Resolves once the kill has settled.
   */
  endChat(chatId: string, graceful?: GracefulEnd): Promise<void>
  /**
   * Adds a grant issued while the chat runs (a cult petition's folder grant) to its running PTY, so it is renewed with
   * the others and revoked when the PTY ends. False, and nothing held, when no PTY of the chat runs on: revoke it then.
   */
  attachGrant(chatId: string, grantId: string): boolean
  /**
   * Takes an attached grant back from the chat's running PTY; false when none runs, it is being stopped (its revoke,
   * which took the grant, has run) or it does not hold the grant.
   */
  detachGrant(chatId: string, grantId: string): boolean
  /** Tells `listener` the chat id of every PTY that exits, however it ended; the returned function stops that. */
  onExit(listener: (chatId: string) => void): () => void
  /** Tells `listener` the chat id of every launch that has just started running (a new generation); the returned function stops that. */
  onLaunch(listener: (chatId: string) => void): () => void
  /** The running launch's generation (its descriptor's and grant binding's); null while no PTY of the chat runs. */
  generationOf(chatId: string): string | null
  /** True while a PTY runs, a start is under way, or a revoke or kill has not settled. */
  /** Observed live PTY only; a queued start or stored chat is not a running agent. */
  /** Delivers advisory context only to an already live terminal. */
  pasteIfRunning(chat: ChatRef, text: string): void
  activeChats(): ChatRecord[]
  isRunning(chatId: string): boolean
  /** Includes a reserved start and cleanup: neither surface may overlap the other's ownership. */
  isLive(ref: ChatRef): boolean
  /** The running owner's launch generation, which a confirmed surface switch must name; null when no PTY runs. */
  owner(ref: ChatRef): string | null
  /**
   * Freezes exactly the `generation` owner (no input, no restart), then joins its close, tree kill and grant revocation.
   * A replaced or exited owner refuses `busy` untouched; a failed cleanup keeps the chat fenced. The vendor session is kept.
   */
  stop(ref: ChatRef, generation: string): Promise<void>
  busy(): boolean
  /** Quit: see the module comment. */
  dispose(): Promise<void>
}

/** A graceful end: ask the CLI to exit, type its exit keys if it still runs, and give it `withinMs` in all. */
export interface GracefulEnd {
  /** Asks the CLI to exit through a trusted channel (a cult member's control file); it may not settle. */
  request?: () => Promise<void>
  /** The CLI's exit keys (Ctrl+D for OMP), typed `inputAfterMs` after the request when the PTY still runs. */
  input: string
  /** At once when absent or 0. */
  inputAfterMs?: number
  withinMs: number
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

/** What a chat's grants carry: its role, Allow save, and the label the person sees in the folder's grant list. */
interface GrantOptions {
  role: ChatRole
  allowSave: boolean
  label: string
  /** False for a cult Magos: it saves only with Allow save, never through the run-ownership exception (DM-738). */
  runSave?: boolean
}

/**
 * A chat grant's label: `<display name> · <title>`, the title cut so the label stays within the grant label
 * limit, and never cut between the halves of a surrogate pair.
 */
function grantLabel(displayName: string, title: string): string {
  const label = `${displayName} · ${title}`
  if (label.length <= LIMITS.grantLabel) {
    return label
  }
  const cut = label.slice(0, LIMITS.grantLabel)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

export interface TerminalSessionsDeps {
  store: Pick<ChatStore, 'getChat' | 'updateChat'>
  /** The connected agent with this id, or null. */
  agentFor: (id: AgentId) => AgentView | null
  folders: LaunchFolderDeps
  /** The CLI's own sign-in status (`getAgentAuthStatus`). */
  checkAuth: (kind: BuiltInAgentKind, executablePath: string) => Promise<AgentAuthStatus>
  /** The `dm` invocation pinned to `folder` (to none for null: a project-less chat's), without a grant: what the start files name. */
  cliFor: (folder: string | null) => DarkMechanicusCli
  runs: OrchestratorRuns
  /** Issues the chat's grant, bound to its mailbox when it has one, before anything is spawned (`chatGrants.ts`). */
  issueChatCli: (folder: string, grant: GrantOptions, chat: GrantChat) => Promise<IssuedChatCli>
  /** A project-less chat's grants, one per target folder, each token written to its file, bound to no mailbox (`chatGrants.ts`). */
  issueReachCli: (targets: readonly ReachTarget[], grant: GrantOptions, ownerFolder?: string, chat?: GrantChat) => Promise<{ cli: DarkMechanicusCli; grantIds: string[] }>
  /** The canonical paths of the tracked folders set up for Dark Mechanicus: what a project-less chat reaches. */
  reachFolders: () => string[]
  /** Desktop-validated HEAD members, used only by a world-root conflict resolver. */
  forgeResolverFolders?: (root: string) => readonly string[]
  /** Never throws (`chatGrants.ts`). */
  revokeChatGrant: (grantId: string) => Promise<void>
  /** Moves a running PTY's grant's expiry on; never throws (`chatGrants.ts`). */
  renewChatGrant: (grantId: string) => Promise<void>
  /** The PTY host; rejects when PTYs cannot run here (no prebuild, a helper that cannot run). */
  host: () => Promise<PtyHost>
  /** Ends a PTY's process tree; `killPtyTree` by default. */
  killTree?: (tree: PtyTree) => Promise<boolean>
  /** Keeps the computer awake while a PTY runs, until the returned function is called (`keepAwake.ts`); nothing by default. */
  keepAwake?: () => () => void
  userData: string
  /** The Skitarii OMP extension's entry file (`skitariiExtensionPath`), loaded by every OMP chat with `-e`. */
  ompExtension: string
  platform: NodeJS.Platform
  /** main's `process.env`. */
  env: Readonly<Record<string, string | undefined>>
  newSessionId?: () => string
  timers?: TerminalTimers
  onError?: (error: unknown) => void
  onChatChanged?: (ref: ChatRef) => void
  /** Main wires the GUI owner's reservation/live-process check. */
  agentChatLive?: (ref: ChatRef) => boolean
  /** Durably reserves uncertain board input BEFORE any physical write; false means already observed or reserved. */
  beforeContextPaste?: (chat: ChatRecord, messageId: string, content: string) => boolean
  /** Recovery startup checks exact source identity and the live initiating authority at every launch fence. */
  assertRecoveryLaunch?: (chat: ChatRecord) => string | void | Promise<string | void>
  assertForgeSetupLaunch?: (chat: ChatRecord, authorization?: symbol) => string
  /** Binds only a tracked live PTY, never a persisted historical grant id. */
  bindChatGrant?: (grantId: string, identity: { folder: string | null; chatId: string; generation: string; runId?: string; cardId?: string }) => unknown
}

interface Subscriber {
  listener: TerminalListener
  /** What it heard before its attach answered; null once released. */
  held: TerminalEvent[] | null
}

/** A paste waiting for the CLI's input: the launch's `pasteFirst`, or one `paste` asked for (Kick back's comment). */
interface Paste {
  text: string
  /** Whether it carries the kickoff, so `kickoffSent` is stored once its Enter has gone. */
  kickoff: boolean
  contextId?: string
}

/** A running PTY's pastes, written one at a time once its input is live and its screen has settled. */
interface PasteQueue {
  /** The pastes still to be written, in order. */
  waiting: Paste[]
  /** Whether the CLI has turned bracketed paste on: the sign its input is live, which every paste waits for. */
  inputLive: boolean
  /** Until then, the end of the output, too short to hold the whole sequence. */
  seen: string
  /** When the screen last took output (`timers.now`). */
  lastOutput: number
  /** Whether a paste has been written and its Enter has not gone yet. */
  entering: boolean
  /** Cancels the timer the queue waits on (the screen to settle, or a paste's Enter); null while none is set. */
  cancel: (() => void) | null
}

/** A chat whose PTY is running (or has just exited and is still putting its last output on the screen). */
interface Live {
  /** Member projects granted to a world-level chat, stopped if any is untracked. */
  scopeFolders: readonly string[]
  readonly generation: string
  /** The launch's mail client descriptor (`writeDmClientDescriptor`), removed when it ends; null when it has none. */
  readonly dmClient: string | null
  kind: 'live'
  chat: ChatRecord
  pty: PtyProcess
  screen: TerminalScreen
  tree: PtyTree
  /** The grants it runs on: one for a folder chat, one per reached folder for a project-less chat, and any attached. */
  grantIds: string[]
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
  /** Its pastes: the launch's `pasteFirst` first, then any `paste`; emptied once it is stopped or has exited. */
  pastes: PasteQueue
  /** Board input reservations, not receipts; scoped to this live host so dropped input can retry after its exit. */
  contextPastes?: Map<string, string>
  revoke: () => Promise<void>
  killing?: Promise<unknown>
  /** Tree kills asked so far (`KILL_ATTEMPTS` at most), and whether the last allowed one failed and was logged. */
  killAttempts?: number
  killsExhausted?: boolean
  retirement?: Promise<void>
  revocationError?: unknown
  /** Stopped for a confirmed surface switch: the chat stays fenced until this owner has fully retired. */
  handoff?: boolean
  /** Ends the folder watch, the grant's renewal, the hold that keeps the computer awake, and the wait for the pastes. */
  stopWatch: () => void
}

type StartOutcome = { state: 'running'; live: Live } | { state: NotStartedState; message: string }

/** A start under way. */
interface Starting {
  scopeFolders: readonly string[]
  kind: 'starting'
  agentId: AgentId
  /** The chat's canonical folder, for `releaseFolder`; null for a project-less chat, which no untrack releases. */
  folder: string | null
  /** `checking` until the sign-in check has answered. */
  phase: 'checking' | 'preparing'
  done: Promise<StartOutcome>
  cancel: (message: string) => void
}

interface Manager {
  deps: Required<Omit<TerminalSessionsDeps, 'onError' | 'onChatChanged' | 'bindChatGrant' | 'beforeContextPaste' | 'assertRecoveryLaunch' | 'assertForgeSetupLaunch' | 'forgeResolverFolders'>> & Pick<TerminalSessionsDeps, 'onChatChanged' | 'bindChatGrant' | 'beforeContextPaste' | 'assertRecoveryLaunch' | 'assertForgeSetupLaunch' | 'forgeResolverFolders'>
  onError: (error: unknown) => void
  entries: Map<string, Live | Starting>
  /** Owners whose screen closed before their process-tree cleanup or grant revocation. */
  retiring: Set<Live>
  listeners: Map<string, Map<TerminalListener, Subscriber>>
  /** Revokes and kills not yet settled: the quit waits for them before the workspaces close. */
  pending: Set<Promise<unknown>>
  /** Chats being deleted, which nothing may start. */
  deleting: Set<string>
  /** Folders being untracked, in which nothing may start. */
  releasing: Set<string>
  closing: boolean
  exitListeners: Set<(chatId: string) => void>
  launchListeners: Set<(chatId: string) => void>
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
function revokeGrant(manager: Manager, grantId: string, failed?: (error: unknown) => void): Promise<void> {
  return track(
    manager,
    manager.deps.revokeChatGrant(grantId).catch((error: unknown) => {
      failed?.(error)
      manager.onError(error)
    })
  )
}

/** How many tree kills one PTY gets at most: its stop or exit, then retries of a failed retirement. */
const KILL_ATTEMPTS = 3

/**
 * Ends the PTY's process tree; never rejects. A kill in flight or settled is shared until a failed retirement forgets
 * it; once `KILL_ATTEMPTS` kills have been asked, no further one is: the answer is false and the owner stays fenced.
 */
function killTree(manager: Manager, live: Live): Promise<unknown> {
  if (live.killing !== undefined) return live.killing
  if ((live.killAttempts ?? 0) >= KILL_ATTEMPTS) return Promise.resolve(false)
  live.killAttempts = (live.killAttempts ?? 0) + 1
  live.killing = track(
    manager,
    manager.deps.killTree(live.tree).catch((error: unknown) => {
      manager.onError(error)
    })
  )
  return live.killing
}

/** Logged once, when the last allowed kill of a PTY's tree has failed: nothing asks again, and the chat stays fenced. */
function killsExhausted(manager: Manager, live: Live): void {
  if (live.killsExhausted === true || (live.killAttempts ?? 0) < KILL_ATTEMPTS) return
  live.killsExhausted = true
  manager.onError(new Error(`The terminal process tree of chat ${live.chat.id} (pid ${live.tree.pid}) did not stop after ${KILL_ATTEMPTS} kill attempts; ` +
    'it is not retried, and the chat cannot start again until the app restarts.'))
}

/**
 * The pre-start step: the files the chat's CLI is started with, written before its grant is issued, so a failed
 * write issues nothing. The instructions and, on macOS, the chat's `dm` launcher; for Claude also its settings
 * file with the memory guards (`claudeSettingsFile.ts`), passed as `files.claudeSettings`.
 */
function hasLaunchMailbox(context: StartContext): boolean {
  return context.agent.kind === 'omp' && (context.reach === undefined || context.chat.folder !== null)
}

/** A cult member starts only with the rules its launcher wrote (`cultLauncher.ts`): a missing file fails the start. */
async function cultRulesOf(userData: string, chat: ChatRecord): Promise<{ cultRules?: string }> {
  return chat.cultRunId === undefined ? {} : { cultRules: await readCultRules(userData, chat.id) }
}

async function writeStartFiles(context: StartContext, repairCheckout: string | undefined): Promise<TerminalFiles> {
  const { manager, chat, agent, folder, reach, newSession: fresh } = context
  const { userData, platform } = manager.deps
  const cli = manager.deps.cliFor(reach === undefined ? folder : null)
  const cultRules = await cultRulesOf(userData, chat)
  const files = await writeTerminalFiles({
    forgeResolver: chat.forgeResolver !== undefined,
    userData,
    chatId: chat.id,
    platform,
    folder,
    cli,
    role: chat.role,
    allowSave: chat.allowSave,
    orchestratesRun: chat.runId !== undefined,
    nameFirstPrompt: chat.titleStatus === 'pending',
    // A project-less chat has no mailbox, so no mail guidance.
    skitariiMail: hasLaunchMailbox(context),
    ...(chat.transferEpicId === undefined ? {} : { transferEpicId: chat.transferEpicId }),
    ...(chat.cardId === undefined ? {} : { cardId: chat.cardId }),
    conversation: chat.conversation,
    ...(reach === undefined ? {} : { reach }),
    ...cultRules
  })
  if (agent.kind === 'omp') {
    // OMP's folder is where its themes are read (`ompSkitariiTheme.ts`); the home is main's env on macOS, where os.homedir() reads it too.
    await installSkitariiTheme(ompAgentDir(manager.deps.env, platform === 'win32' ? undefined : manager.deps.env['HOME']))
    return { ...files, omp: { ...(await writeOmpFiles(userData, chat.id, { fresh, role: chat.role })), extension: manager.deps.ompExtension } }
  }
  if (agent.kind !== 'claude') {
    return files
  }
  return { ...files, claudeSettings: await writeClaudeSettings({ userData, chatId: chat.id, platform, folder, cli, repairCheckout, home: homedir(), tmp: tmpdir(), ...(reach === undefined ? {} : { projectless: true as const }) }) }
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

/**
 * Retains the old owner's identity until all three independently completing barriers have settled; a failed kill or
 * revocation fails at once and keeps the owner fenced. A failed retirement is not kept: the next stop, start or exit
 * asks again (a fresh tree kill, at most `KILL_ATTEMPTS` in all, and revocation), and the first success releases ownership.
 */
function retire(manager: Manager, live: Live): Promise<void> {
  if (live.retirement) return live.retirement
  manager.retiring.add(live)
  let killFailed = false
  const killed = killTree(manager, live).then(result => {
    if (result === true) return
    killFailed = true
    const error = new Error('The terminal process tree did not stop.')
    // A kill that threw has already reported itself (`killTree`); one that answered false has not. Exhausted, nothing ran.
    if (result === false && live.killsExhausted !== true) manager.onError(error)
    killsExhausted(manager, live)
    throw error
  })
  const revoked = live.revoke().then(() => {
    if (live.revocationError !== undefined) throw live.revocationError
  })
  const retirement = Promise.all([killed, live.closed, revoked]).then(() => {
    manager.retiring.delete(live)
  }, (error: unknown) => {
    // Forget the failed attempt so the next retirement asks again; the owner stays fenced meanwhile.
    live.retirement = undefined
    if (killFailed) live.killing = undefined
    throw error
  })
  live.retirement = retirement
  void retirement.catch(() => undefined)
  return retirement
}

/**
 * Before a start: asks again for the chat's owners whose cleanup failed (an in-flight cleanup is left to finish).
 * The first success releases ownership; a repeated failure reports itself and stays fenced for the next stop, start or exit.
 * Answers null, at once, when no owner of the chat waits for a retry: an attach then takes its snapshot in the same
 * turn as the call, so output written right after the call reaches its listener and not the snapshot.
 */
function retryRetirements(manager: Manager, chatId: string): Promise<void> | null {
  const failed = [...manager.retiring].filter(live => live.chat.id === chatId && live.retirement === undefined)
  if (failed.length === 0) return null
  return Promise.all(failed.map(live => retire(manager, live).catch(() => undefined))).then(() => undefined)
}

/**
 * Where the chat's CLI starts: its tracked folder as the launch check passes it (`resolveLaunchFolder`, which throws its
 * `not_found` refusal), or a project-less chat's own scratch folder, made when it is missing.
 */
function launchFolder(manager: Manager, chat: ChatRecord): string {
  return chat.folder === null ? ensureScratchFolder(manager.deps.userData, chat.id) : resolveLaunchFolder({ folder: chat.folder }, manager.deps.folders)
}

function launchReach(manager: Manager, chat: ChatRecord, folder: string): readonly ReachTarget[] | undefined {
  const scoped = chat.folder === null ? manager.deps.reachFolders() : forgeScope(manager, chat, folder)
  return scoped === undefined ? undefined : reachTargets(ensureScratchFolder(manager.deps.userData, chat.id), scoped)
}

function forgeScope(manager: Manager, chat: ChatRecord, folder: string): string[] | undefined {
  const cached = chat.forgeResolver === folder ? manager.deps.forgeResolverFolders?.(folder) : undefined
  return forgeReachFolders(folder, manager.deps.reachFolders(), cached)
}

function worldScope(chat: ChatRecord, reach: readonly ReachTarget[] | undefined): readonly string[] {
  return chat.folder !== null && reach !== undefined ? reach.map(target => target.folder) : []
}

/** A world chat may keep its original member grants only while those members remain in scope. */
function assertForgeScope(manager: Manager, chat: ChatRecord, members: readonly string[]): void {
  if (chat.folder === null || members.length === 0) return
  const current = forgeScope(manager, chat, chat.folder)
  if (current === undefined || members.some(folder => !current.includes(folder) || manager.releasing.has(folder))) throw new Error(UNTRACKED)
}

/** Whether the chat's folder still passes the launch check; a running PTY is stopped with its message when not. */
function folderStillValid(manager: Manager, live: Live): string | null {
  try {
    launchFolder(manager, live.chat)
    assertForgeScope(manager, live.chat, live.scopeFolders)
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

/** Renews each of `grantIds`; never rejects. Kept for the quit, so its workspace is not closed under it. */
function renewGrants(manager: Manager, grantIds: readonly string[]): Promise<unknown> {
  return track(
    manager,
    Promise.all(
      grantIds.map((grantId) =>
        manager.deps.renewChatGrant(grantId).catch((error: unknown) => {
          manager.onError(error)
        })
      )
    )
  )
}

/**
 * The watches on a running PTY; answers the function that ends them, which also gives up the pastes still waiting and
 * the hold that keeps the computer awake (once, though a stop and then the exit both end them). Its folder is checked
 * every minute, and its grants are renewed every `GRANT_RENEW_MS`.
 */
function watchLive(manager: Manager, live: Live): () => void {
  const { timers } = manager.deps
  const stopFolderWatch = timers.repeat(() => {
    folderStillValid(manager, live)
  }, FOLDER_CHECK_MS)
  const stopRenewal = timers.repeat(() => {
    void renewGrants(manager, live.grantIds)
  }, GRANT_RENEW_MS)
  let release: (() => void) | null = manager.deps.keepAwake()
  return () => {
    stopFolderWatch()
    stopRenewal()
    release?.()
    release = null
    live.pastes.cancel?.()
    live.pastes.cancel = null
    live.pastes.waiting = []
  }
}

/** `text` as one bracketed paste, as xterm.js pastes: newlines as CR, and every other control character but tab taken out. */
function bracketedPaste(text: string): string {
  return `${PASTE_START}${text.replace(/\r?\n/g, '\r').replace(/[^\P{Cc}\t\r]/gu, '')}${PASTE_END}`
}

function resumeWaitingPastes(manager: Manager, live: Live): void {
  if (live.pastes.waiting.length === 0) return
  live.pastes.cancel = manager.deps.timers.after(() => {
    live.pastes.cancel = null
    writePastes(manager, live)
  }, 0)
}

function reserveContextPaste(manager: Manager, live: Live, next: Paste): boolean {
  if (next.contextId === undefined) return true
  try {
    if (manager.deps.beforeContextPaste === undefined) throw new Error('The durable board-input transport is unavailable.')
    const reserved = manager.deps.beforeContextPaste(live.chat, next.contextId, next.text)
    if (!reserved) resumeWaitingPastes(manager, live)
    return reserved
  } catch (error) {
    manager.onError(error)
    void stop(manager, live, `The board input could not be recorded safely; no message was sent. ${messageOf(error)}`)
    return false
  }
}

/** Claims a first-message insertion before writing; ambiguous exits never replay it. */
function submitPaste(manager: Manager, live: Live, next: Paste): void {
  const queue = live.pastes
  if (!reserveContextPaste(manager, live, next)) return
  queue.entering = true
  if (next.kickoff && live.chat.firstPrompt !== undefined) {
    try {
      manager.deps.store.updateChat(live.chat, { firstPromptDelivery: 'uncertain' })
    } catch (error) {
      manager.onError(error)
      void stop(manager, live, 'The first prompt could not be recorded safely; no message was sent. Its full text is saved in this chat.')
      return
    }
  }
  try {
    writeInput(manager, live, bracketedPaste(next.text))
  } catch (error) {
    manager.onError(error)
    void stop(manager, live, `The queued prompt could not be delivered: ${messageOf(error)}. Its saved first-message text remains available; uncertain input is not automatically resent.`)
    manager.deps.onChatChanged?.(live.chat)
    return
  }
  queue.cancel = manager.deps.timers.after(() => {
    queue.cancel = null
    queue.entering = false
    try {
      writeInput(manager, live, ENTER)
    } catch (error) {
      manager.onError(error)
      void stop(manager, live, `The queued prompt could not be submitted: ${messageOf(error)}. Its saved first-message text remains available; uncertain input is not automatically resent.`)
      manager.deps.onChatChanged?.(live.chat)
      return
    }
    queue.lastOutput = manager.deps.timers.now()
    if (next.kickoff) {
      try {
        manager.deps.store.updateChat(live.chat, { kickoffSent: true, ...(live.chat.firstPrompt === undefined ? {} : { firstPromptDelivery: 'submitted' }) })
        manager.deps.onChatChanged?.(live.chat)
      } catch (error) {
        manager.onError(error)
      }
    }
    writePastes(manager, live)
  }, ENTER_DELAY_MS)
}

/**
 * Writes the next waiting paste once the PTY can take it: its CLI has turned bracketed paste on (`BRACKETED_PASTE_ON`,
 * which a TUI sends when its input is live; Autonomous goes quiet for seconds while it starts before it does, verified
 * live), no earlier paste is still waiting for its Enter, and the screen has then taken nothing for `SETTLE_MS` (the
 * timer is set for the earliest moment, then checked against `lastOutput`, so output costs a timestamp and not a new
 * timer). The paste is
 * written as input the person typed, then Enter as its own keypress `ENTER_DELAY_MS` later (Autonomous takes an
 * Enter that arrives with the paste as part of it, verified live); a kickoff is stored as sent once its Enter has
 * gone. The next paste waits for the screen to settle again, counted from that Enter at the earliest, so it never
 * lands while the CLI is still taking the text before it. A CLI that never turns bracketed paste on is pasted nothing.
 */
function writePastes(manager: Manager, live: Live): void {
  const queue = live.pastes
  const next = queue.waiting[0]
  if (next === undefined || !queue.inputLive || queue.entering || queue.cancel !== null || live.exited || live.stopMessage !== null) {
    return
  }
  const { timers } = manager.deps
  const quiet = timers.now() - queue.lastOutput
  if (quiet < SETTLE_MS) {
    queue.cancel = timers.after(() => {
      queue.cancel = null
      writePastes(manager, live)
    }, SETTLE_MS - quiet)
    return
  }
  queue.waiting.shift()
  submitPaste(manager, live, next)
}

/** The screen took `data`: the pastes' wait goes on, and once the CLI turns bracketed paste on, the first can go. */
function pasteSawOutput(manager: Manager, live: Live, data: string): void {
  const queue = live.pastes
  queue.lastOutput = manager.deps.timers.now()
  if (queue.inputLive) {
    return
  }
  // Kept short of a whole sequence, so one split across two chunks is still found.
  const seen = queue.seen + data
  if (!seen.includes(BRACKETED_PASTE_ON)) {
    queue.seen = seen.slice(-(BRACKETED_PASTE_ON.length - 1))
    return
  }
  queue.inputLive = true
  queue.seen = ''
  writePastes(manager, live)
}

interface Started {
  scopeFolders: readonly string[]
  pty: PtyProcess
  screen: TerminalScreen
  grantIds: readonly string[]
  resumed: boolean
  marksStarted: boolean
  /** The launch's `pasteFirst`, and whether the kickoff is in it; null when there is none. */
  firstPaste: Paste | null
  /** The launch's generation, which its grant binding and mail client descriptor name. */
  generation: string
  dmClient: string | null
}

/** Output the screen has taken: told to listeners, and the pastes' wait goes on. */
function tookOutput(manager: Manager, live: Live, data: string): void {
  emit(manager, live.chat.id, { kind: 'output', data })
  pasteSawOutput(manager, live, data)
}

/** Tracks a PTY just spawned, with the screen made for it: nothing here can fail, so no PTY runs untracked. */
function startLive(manager: Manager, chat: ChatRecord, started: Started): Live {
  const { pty, screen, grantIds } = started
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
    scopeFolders: started.scopeFolders,
    kind: 'live',
    generation: started.generation,
    dmClient: started.dmClient,
    chat,
    pty,
    screen,
    grantIds: [...grantIds],
    stopMessage: null,
    exited: false,
    ended,
    closed,
    last: null,
    resumed: started.resumed,
    marksStarted: started.marksStarted,
    pastes: { waiting: started.firstPaste === null ? [] : [started.firstPaste], inputLive: false, seen: '', lastOutput: 0, entering: false, cancel: null },
    tree: { pid: pty.pid, kill: () => pty.kill(), exited: ended, hasExited: () => live.exited },
    revoke: () => {
      if (revoked === null) {
        live.revocationError = undefined
        // A failed revocation is asked again by the next call rather than remembered. `live.grantIds`, not the
        // launch's: a cult upgrade attached to the running PTY (`attachGrant`) is revoked with it.
        revoked = Promise.all(live.grantIds.map((grantId) => revokeGrant(manager, grantId, error => { live.revocationError = error }))).then(() => {
          if (live.revocationError !== undefined) revoked = null
        })
      }
      return revoked
    },
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
  const stopResponse = screen.onResponse((data) => {
    if (live.exited || live.stopMessage !== null) return
    try {
      pty.write(data)
    } catch (error) {
      manager.onError(error)
    }
  })
  const stopData = pty.onData((data) => {
    screen.write(data, () => {
      tookOutput(manager, live, data)
    })
  })
  const stopExit = pty.onExit((exit) => {
    live.exited = true
    reportEnded()
    try {
      const stored = manager.deps.store.getChat(chat)
      if (stored?.titleStatus === 'pending' && stored.firstPromptDelivery === 'submitted') {
        manager.deps.store.updateChat(chat, { title: 'Chat naming failed', titleStatus: 'failed', titleError: 'The selected agent exited before reporting an inferred title.' })
      }
      if (stored?.firstPrompt !== undefined) manager.deps.onChatChanged?.(chat)
    } catch (error) {
      manager.onError(error)
    }
    live.stopWatch()
    void live.revoke()
    if (live.dmClient !== null) void dropDmClient(manager, live.dmClient)
    // Asked now, while the group's id can only be the CLI's: ends what it left running in its process group.
    void retire(manager, live)
    // An exit is also a chance to retry an earlier owner's failed cleanup; this owner's own retirement is in flight.
    void retryRetirements(manager, chat.id)
    if (live.stopMessage === null) {
      void track(manager, pauseIfSignedOut(manager, chat))
    }
    tellExit(manager, live)
    stopData()
    stopResponse()
    stopExit()
    closeAfterExit(manager, live, exit, reportClosed)
  })
}

/** After an orchestrator chat's CLI exited on its own: pauses its run with `signed_out` when the status says signed out. Never rejects. */
async function pauseIfSignedOut(manager: Manager, chat: ChatRecord): Promise<void> {
  const agent = manager.deps.agentFor(chat.agent)
  if (chat.runId === undefined || chat.folder === null || agent === null || agent.kind === 'custom') {
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

/** Input for the chat's running PTY; the first input marks its session started. */
function writeInput(manager: Manager, live: Live, data: string): void {
  live.pty.write(data)
  if (live.marksStarted) {
    live.marksStarted = false
    try {
      manager.deps.store.updateChat(live.chat, { sessionStarted: true })
    } catch (error) {
      manager.onError(error)
    }
  }
}

/**
 * What a start issued: the chat's `dm` invocation, its grants (one for a folder chat, one per reached folder for a
 * project-less chat) and the mailbox a folder OMP chat's grant was bound to (null for every other chat).
 */
interface IssuedGrants {
  cli: DarkMechanicusCli
  grantIds: readonly string[]
  endpointId: string | null
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
  /** A project-less chat's folders and token files, read when the start began; absent for a chat of a folder. */
  reach: readonly ReachTarget[] | undefined
  starting: Starting
  kickoff: string | null
  forgeSetupAuthorization?: symbol
  /** The start forgets the chat's earlier session (the pane's new session after a refused resume). */
  newSession: boolean
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

/** Whether the chat's folder is being untracked; a project-less chat belongs to none. */
function releasing(manager: Manager, chat: ChatRecord): boolean {
  return chat.folder !== null && manager.releasing.has(chat.folder)
}

/**
 * The launch check again, at a later step of a start: the folder can be moved, swapped or untracked while the
 * sign-in check runs (up to 30 s), and nothing may then be issued or started for it.
 */
function assertLocalStart(context: StartContext): void {
  if (releasing(context.manager, context.chat)) throw new FolderRefused(UNTRACKED)
  launchFolder(context.manager, context.chat)
  assertForgeScope(context.manager, context.chat, context.starting.scopeFolders)
}

async function recheckFolder(context: StartContext): Promise<string | undefined> {
  try {
    assertLocalStart(context)
    const codeCheckout = await verifiedStartDirectory(context)
    assertLocalStart(context)
    return codeCheckout ?? undefined
  } catch (error) {
    throw new FolderRefused(messageOf(error))
  }
}

function verifiedStartDirectory(context: StartContext): string | void | Promise<string | void> {
  const { chat, manager } = context
  if (chat.forgeSetup !== undefined) return verifiedForgeSetupDirectory(context)
  if (chat.repairIncidentId === undefined) return undefined
  const verify = manager.deps.assertRecoveryLaunch
  if (verify === undefined) throw new Error('Repair startup authority is unavailable.')
  return verify(chat)
}

function verifiedForgeSetupDirectory(context: StartContext): string {
  const verify = context.manager.deps.assertForgeSetupLaunch
  if (verify === undefined) throw new Error('Forge setup launch authority is unavailable.')
  return verify(context.chat, context.forgeSetupAuthorization)
}

function assertSpawnLocation(context: StartContext, expectedDirectory: string | undefined): void {
  try {
    assertLocalStart(context)
    if (context.chat.forgeSetup !== undefined && verifiedForgeSetupDirectory(context) !== expectedDirectory) {
      throw new Error('The Forge setup checkout changed before launch.')
    }
  } catch (error) { throw new FolderRefused(messageOf(error)) }
}

async function startAuthRefusal(context: StartContext, step: Step): Promise<{ state: 'signed_out'; message: string } | null> {
  const { manager, chat, agent, starting } = context
  if (agent.kind === 'custom') {
    return chat.forgeResolver === undefined ? null :
      { state: 'signed_out', message: 'The resolver agent does not support sign-in verification.' }
  }
  const status = await step(manager.deps.checkAuth(agent.kind, agent.executablePath).catch((): AgentAuthStatus | null => null))
  const state = status?.state
  if (state === 'signed_out' || (chat.forgeResolver !== undefined && state !== 'signed_in')) {
    return { state: 'signed_out', message: status?.reason ?? 'The resolver agent sign-in could not be verified.' }
  }
  starting.phase = 'preparing'
  return null
}

/** The steps before a spawn, in their order (see the module comment). */
async function runStart(context: StartContext, step: Step): Promise<StartOutcome> {
  const { manager, chat, agent, folder } = context
  const refusal = await startAuthRefusal(context, step)
  if (refusal !== null) return refusal
  const repairCheckout = await step(recheckFolder(context))
  const files = await step(writeStartFiles(context, repairCheckout))
  await step(recheckFolder(context))
  const grant = {
    role: chat.role, allowSave: chat.allowSave, label: grantLabel(agent.displayName, chat.title), ...(chat.cultRole === 'magos' ? { runSave: false } : {})
  }
  const revokeAll = (grantIds: readonly string[]): void => {
    for (const grantId of grantIds) {
      void revokeGrant(manager, grantId)
    }
  }
  const identity = { ...mailboxChat(chat), kind: agent.kind }
  // A project-less chat with no folder to reach starts with no grant: its instructions say so. It has no mailbox.
  const issuing: Promise<IssuedGrants> =
    context.reach === undefined
      ? manager.deps.issueChatCli(folder, grant, identity).then(({ cli, grantId, endpointId }) => ({ cli, grantIds: [grantId], endpointId }))
      : context.reach.length === 0
        ? Promise.resolve({ cli: manager.deps.cliFor(null), grantIds: [], endpointId: null })
        : manager.deps.issueReachCli(context.reach, grant, chat.folder ?? undefined, chat.folder === null ? undefined : identity).then(({ cli, grantIds }) => ({ cli, grantIds, endpointId: null }))
  const issued = await step(issuing, ({ grantIds }) => {
    revokeAll(grantIds)
  })
  try {
    return { state: 'running', live: await spawnWithGrant(context, files, issued, step) }
  } catch (error) {
    revokeAll(issued.grantIds)
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

/** Whether the chat's first input marks its session started: only for a CLI whose session file the app cannot read (not Claude's, not OMP's). */
function marksSessionStarted(agent: AgentView, chat: ChatRecord): boolean {
  return agent.kind !== 'claude' && agent.kind !== 'omp' && agent.kind !== 'custom' && chat.sessionStarted !== true
}

/**
 * The chat as the launch sees it. For OMP the session id is whatever its session file in the chat's own folder says
 * (the CLI mints it, so nothing is stored up front); a folder with no file means there is no session to resume.
 */
function launchChat({ manager, chat, agent, folder }: StartContext, files: TerminalFiles, repairCheckout: string | undefined): ChatRecord & { sessionStarted: boolean } {
  if (agent.kind === 'omp') {
    const found = files.omp === undefined ? null : ompSessionId(files.omp.sessionDir)
    return { ...chat, sessionId: found ?? chat.sessionId, sessionStarted: found !== null }
  }
  return { ...chat, sessionStarted: sessionStarted(manager, chat, agent, repairCheckout ?? folder) }
}

/** Whether the chat's CLI has a session a start resumes: Claude's session file, else the chat's flag. */
function sessionStarted(manager: Manager, chat: ChatRecord, agent: AgentView, folder: string): boolean {
  if (agent.kind !== 'claude') {
    return chat.sessionStarted === true
  }
  return chat.sessionId !== null && claudeSessionExists({ env: manager.deps.env, platform: manager.deps.platform, folder, sessionId: chat.sessionId })
}

/** The PTY is already tracked before any post-spawn record write can fail. */
function finishArgumentPrompt(manager: Manager, chat: ChatRecord, live: Live): void {
  try {
    manager.deps.store.updateChat(chat, { firstPromptDelivery: 'submitted' })
    manager.deps.onChatChanged?.(chat)
  } catch (error) {
    manager.onError(error)
    void stop(manager, live, 'The first prompt was handed to the agent, but its delivery record could not be finalized. It will not be automatically resent.')
  }
}

/** Record launch authority and ambiguous argument delivery atomically before starting the process. */
function recordLaunch({ manager, chat }: StartContext, spec: TerminalLaunchSpec, issued: IssuedGrants, firstArgument: boolean): void {
  const stored = manager.deps.store.getChat(chat)?.grantIds ?? []
  manager.deps.store.updateChat(chat, {
    grantIds: [...stored, ...issued.grantIds],
    ...(issued.endpointId === null ? {} : { endpointId: issued.endpointId }),
    ...(spec.sessionId === null ? {} : { sessionId: spec.sessionId }),
    ...(spec.kickoffIn === 'args' ? { kickoffSent: true } : {}),
    ...(firstArgument ? { firstPromptDelivery: 'uncertain' as const } : {})
  })
}

/** Removes a launch's mail client descriptor; never rejects. */
function dropDmClient(manager: Manager, path: string): Promise<void> {
  return track(
    manager,
    removeDmClientDescriptor(path).catch((error: unknown) => {
      manager.onError(error)
    })
  )
}

/**
 * The files with the launch's mail client descriptor, for an OMP chat whose grant was bound to its mailbox
 * (`issued.endpointId`): written once the grant is issued and before the spawn, so it names this launch's generation.
 */
async function withDmClient(context: StartContext, files: TerminalFiles, issued: IssuedGrants, generation: string): Promise<TerminalFiles> {
  const { manager, chat, agent, folder } = context
  if (agent.kind !== 'omp' || files.omp === undefined) {
    return files
  }
  const { userData, platform } = manager.deps
  if (chat.folder !== null && context.reach !== undefined) {
    const dmClient = await writeWorldMailDescriptor({ userData, chatId: chat.id, generation, folder, cli: issued.cli, platform, reach: context.reach })
    return { ...files, omp: { ...files.omp, dmClient } }
  }
  const address = issued.cli.env['DM_DESKTOP_PIPE']
  if (issued.endpointId === null && address === undefined) return files
  const dmClient = issued.endpointId === null
    ? await writeRecoveryClientDescriptor({ userData, chatId: chat.id, generation, address: address! })
    : await writeDmClientDescriptor({ userData, chatId: chat.id, generation, folder, cli: issued.cli, platform, ...(chat.cultRole === undefined ? {} : { cultRole: chat.cultRole }) })
  return { ...files, omp: { ...files.omp, dmClient } }
}

/** Spawns the launch with its mail client descriptor, if it gets one; the descriptor goes again when the start fails. */
async function spawnWithGrant(context: StartContext, files: TerminalFiles, issued: IssuedGrants, step: Step): Promise<Live> {
  const generation = randomUUID()
  const drop = (launched: TerminalFiles): void => {
    if (launched.omp?.dmClient !== undefined) void dropDmClient(context.manager, launched.omp.dmClient)
  }
  const launched = await step(withDmClient(context, files, issued, generation), drop)
  try {
    return await spawnLaunch(context, launched, issued, { step, generation, dmClient: launched.omp?.dmClient ?? null })
  } catch (error) {
    drop(launched)
    throw error
  }
}

/** Binds the launch before its PTY can issue its first command. Failed starts revoke their grants. */
async function bindGrants(manager: Manager, chat: ChatRecord, generation: string, grantIds: readonly string[]): Promise<void> {
  for (const grantId of grantIds) {
    await manager.deps.bindChatGrant?.(grantId, {
      folder: chat.folder, chatId: chat.id, generation,
      ...(chat.runId === undefined ? {} : { runId: chat.runId }),
      ...(chat.cardId === undefined ? {} : { cardId: chat.cardId })
    })
  }
}

/**
 * Builds the launch, stores the grants' ids (and the mailbox's id), the session id the CLI runs under and a kickoff
 * on its command line (`kickoffSent`) on the chat, then spawns; throws on any failure (the caller revokes).
 */
async function spawnLaunch(context: StartContext, files: TerminalFiles, issued: IssuedGrants, launch: { step: Step; generation: string; dmClient: string | null }): Promise<Live> {
  const { manager, chat, agent, folder, reach } = context
  const { step, generation, dmClient } = launch
  const host = await step(manager.deps.host())
  await step(bindGrants(manager, chat, generation, issued.grantIds))
  const repairCheckout = await step(recheckFolder(context))
  const spec = terminalLaunchSpec({
    chat: { ...launchChat(context, files, repairCheckout), kickoffSent: chat.kickoffSent === true },
    kickoff: context.kickoff,
    agent,
    folder,
    repairCheckout,
    cli: issued.cli,
    ...(reach === undefined ? {} : { reach }),
    files,
    platform: manager.deps.platform,
    env: manager.deps.env,
    newSessionId: manager.deps.newSessionId
  })
  assertSpawnLocation(context, repairCheckout)
  const firstArgument = spec.kickoffIn === 'args' && chat.firstPrompt !== undefined
  recordLaunch(context, spec, issued, firstArgument)
  const screen = createTerminalScreen(START_COLS, START_ROWS)
  let pty: PtyProcess
  try {
    pty = host.spawn({ file: spec.file, args: spec.commandLine ?? spec.args, cwd: spec.cwd, env: spec.env, cols: START_COLS, rows: START_ROWS })
  } catch (error) {
    screen.dispose()
    if (firstArgument) manager.deps.store.updateChat(chat, { kickoffSent: false, firstPromptDelivery: 'pending' })
    throw error
  }
  const marksStarted = marksSessionStarted(agent, chat)
  const firstPaste = spec.pasteFirst === null ? null : { text: spec.pasteFirst, kickoff: spec.kickoffIn === 'paste' }
  const live = startLive(manager, chat, { pty, screen, grantIds: issued.grantIds, resumed: spec.resumed, marksStarted, firstPaste, generation, dmClient, scopeFolders: context.starting.scopeFolders })
  if (firstArgument) finishArgumentPrompt(manager, chat, live)
  return live
}

/** Why a custom CLI marked `needsReview` (its arguments were saved for a protocol server) starts no chat, and what to do. */
function needsReviewMessage(agent: AgentView): string {
  return `${agent.displayName} was saved with arguments for a chat protocol the app no longer speaks, so it does not start until you review them. Open it under Agents and choose Review arguments.`
}

/** A saved first message is eligible only until its first physical delivery attempt. */
function unsentFirstPrompt(chat: ChatRecord): string | null {
  if (chat.kickoffSent === true || chat.firstPromptDelivery === 'uncertain') return null
  return chat.firstPrompt ?? null
}

function startLocation(manager: Manager, chat: ChatRecord) {
  const folder = launchFolder(manager, chat)
  return { folder, reach: launchReach(manager, chat, folder) }
}

/** Begins the chat's start, or refuses it at once when its folder or agent fails; see `AttachOptions` and `StartOptions`. */
function beginStart(manager: Manager, found: ChatRecord, options: AttachOptions & Partial<StartOptions>): Starting | { state: 'refused'; message: string } {
  let chat = found
  const setupRefused = refuseSetupStart(manager, chat, options)
  if (setupRefused !== undefined) return setupRefused
  if (manager.deleting.has(chat.id)) {
    return { state: 'refused', message: DELETED }
  }
  if (releasing(manager, chat)) {
    return { state: 'refused', message: UNTRACKED }
  }
  let location: ReturnType<typeof startLocation>
  try {
    location = startLocation(manager, chat)
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
    scopeFolders: worldScope(chat, location.reach),
    kind: 'starting',
    agentId: agent.id,
    folder: chat.folder,
    phase: agent.kind === 'custom' ? 'preparing' : 'checking',
    done: Promise.resolve({ state: 'failed', message: QUITTING }),
    cancel: () => {}
  }
  manager.entries.set(chat.id, starting)
  starting.done = startSteps({ manager, chat, agent, ...location, starting, kickoff: options.kickoff ?? unsentFirstPrompt(chat),
    newSession: options.newSession === true, forgeSetupAuthorization: options.forgeSetupAuthorization }).then((outcome) => {
    if (manager.entries.get(chat.id) === starting) {
      if (outcome.state === 'running' && !outcome.live.exited) {
        tellLaunch(manager, chat.id, outcome.live)
      } else {
        manager.entries.delete(chat.id)
      }
    }
    emit(manager, chat.id, outcome.state === 'running' ? { kind: 'started', pid: outcome.live.pty.pid } : { kind: 'not_started', ...outcome })
    return outcome
  })
  return starting
}

function refuseSetupStart(manager: Manager, chat: ChatRecord, options: AttachOptions & Partial<StartOptions>): { state: 'refused'; message: string } | undefined {
  if (manager.deps.agentChatLive(chat)) throw new DomainError('busy_elsewhere', 'The chat is running in the GUI.')
  assertNotHandingOff(manager, chat.id)
  if (chat.forgeSetup?.mode === 'execution' && options.forgeSetupAuthorization === undefined) {
    return { state: 'refused', message: 'This installer conversation starts only from the explicit setup action.' }
  }
  if (chat.forgeSetup !== undefined && options.newSession === true) {
    return { state: 'refused', message: 'This Forge conversation is bound to its original setup receipt.' }
  }
}

/** A terminal stopped for a confirmed surface switch refuses every restart until it has fully retired. */
function assertNotHandingOff(manager: Manager, chatId: string): void {
  if ([...manager.retiring].some(live => live.handoff === true && live.chat.id === chatId)) throw new DomainError('busy', SWITCHING)
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
      return { state: 'refused', message: noChat(ref) }
    }
    const retrying = retryRetirements(manager, chat.id)
    if (retrying !== null) await retrying
    const answer = await attachEntry(manager, chat, listener, options)
    if (!('kind' in answer)) {
      return answer
    }
    // A PTY that had exited before this attach came: once the exit has been told, the chat starts again.
    await answer.closed
  }
}

/** A running PTY gets no duplicate kickoff; an exited one finishes cleanup before a fresh start. */
async function start(manager: Manager, ref: ChatRef, options: StartOptions): Promise<TerminalStart> {
  const previous = manager.entries.get(ref.id)
  if (previous?.kind === 'live' && previous.exited) await previous.closed
  if (manager.closing) {
    return { state: 'failed', message: QUITTING }
  }
  const chat = manager.deps.store.getChat(ref)
  if (chat === null) {
    return { state: 'refused', message: noChat(ref) }
  }
  await retryRetirements(manager, chat.id)
  assertNotHandingOff(manager, chat.id)
  const entry = manager.entries.get(chat.id) ?? beginStart(manager, chat, options)
  if (!('kind' in entry)) {
    return entry
  }
  const outcome = entry.kind === 'live' ? { state: 'running' as const, live: entry } : await entry.done
  return outcome.state === 'running' ? { state: 'running', pid: outcome.live.pty.pid } : outcome
}

const EXITED_BEFORE_PASTE = 'The terminal exited before the text could be pasted.'

/** The chat's PTY a paste goes into, started as an attach starts it (never with the kickoff) when none runs; or why there is none. */
async function pasteTarget(manager: Manager, chat: ChatRecord): Promise<Live | TerminalStart> {
  const entry = manager.entries.get(chat.id) ?? beginStart(manager, chat, {})
  if (!('kind' in entry)) {
    return entry
  }
  const outcome = entry.kind === 'live' ? { state: 'running' as const, live: entry } : await entry.done
  return outcome.state === 'running' ? outcome.live : outcome
}

/**
 * `TerminalSessions.paste`. A PTY being stopped or that has just exited is waited out and the chat started again,
 * once: a PTY that ends again before the text could wait in it answers `failed`, so a CLI that exits at once is not
 * started over and over.
 */
async function paste(manager: Manager, ref: ChatRef, text: string, contextId?: string): Promise<TerminalStart> {
  for (let waitedOut = false; ; waitedOut = true) {
    if (manager.closing) {
      return { state: 'failed', message: QUITTING }
    }
    // Read on each round: the chat may have been deleted while its last PTY exited.
    const chat = manager.deps.store.getChat(ref)
    if (chat === null) {
      return { state: 'refused', message: noChat(ref) }
    }
    await retryRetirements(manager, chat.id)
    const live = await pasteTarget(manager, chat)
    if (!('kind' in live)) {
      return live
    }
    if (!live.exited && live.stopMessage === null) {
      return queuePaste(manager, live, text, contextId)
    }
    if (waitedOut) {
      return { state: 'failed', message: live.stopMessage ?? EXITED_BEFORE_PASTE }
    }
    await live.closed
  }
}

function queuePaste(manager: Manager, live: Live, text: string, contextId?: string): TerminalStart {
  if (contextId !== undefined) {
    const queued = live.contextPastes?.get(contextId)
    if (queued !== undefined) {
      return queued === text ? { state: 'running', pid: live.pty.pid }
        : { state: 'failed', message: 'The queued board message identity already belongs to different text.' }
    }
    live.contextPastes ??= new Map()
    live.contextPastes.set(contextId, text)
  }
  live.pastes.waiting.push({ text, kickoff: false, contextId })
  writePastes(manager, live)
  return { state: 'running', pid: live.pty.pid }
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

/** Gives a running PTY `withinMs` to exit on its own: the trusted request first, then its exit keys (at once or later). */
async function exitOnItsOwn(manager: Manager, live: Live, graceful: GracefulEnd): Promise<void> {
  const cancels: (() => void)[] = []
  // `Promise.withResolvers` is outside this project's ES2022 lib.
  const late = new Promise<void>((resolve) => {
    cancels.push(manager.deps.timers.after(resolve, graceful.withinMs))
  })
  const typeKeys = (): void => {
    if (!live.exited && live.stopMessage === null) live.pty.write(graceful.input)
  }
  graceful.request?.().catch((error: unknown) => {
    manager.onError(error)
  })
  if (graceful.inputAfterMs === undefined || graceful.inputAfterMs <= 0) typeKeys()
  else cancels.push(manager.deps.timers.after(typeKeys, graceful.inputAfterMs))
  await Promise.race([live.ended, late])
  for (const cancel of cancels) cancel()
}

/** `TerminalSessions.endChat`: a running PTY may first exit on its own, within the time given; see the interface. */
async function endChat(manager: Manager, chatId: string, graceful?: GracefulEnd): Promise<void> {
  const live = runningTerminal(manager, chatId)
  if (live !== null && graceful !== undefined && live.stopMessage === null) await exitOnItsOwn(manager, live, graceful)
  const entry = manager.entries.get(chatId) ?? live ?? undefined
  const ended = entry === undefined ? null : await endEntry(manager, entry, ENDED)
  // Resolves once its grants are revoked too, so a caller may close or remove their workspace next.
  await Promise.all([ended?.kill, ended?.live.revoke()])
}

/** `TerminalSessions.attachGrant`: only a PTY that runs on and is not being stopped takes a grant. */
function attachGrant(manager: Manager, chatId: string, grantId: string): boolean {
  const live = runningTerminal(manager, chatId)
  if (live === null || live.stopMessage !== null) return false
  if (!live.grantIds.includes(grantId)) live.grantIds.push(grantId)
  return true
}

function detachGrant(manager: Manager, chatId: string, grantId: string): boolean {
  const live = runningTerminal(manager, chatId)
  const index = live === null || live.stopMessage !== null ? -1 : live.grantIds.indexOf(grantId)
  if (live === null || index < 0) return false
  live.grantIds.splice(index, 1)
  return true
}

/** Tells the exit listeners of a PTY's exit; a listener that throws is reported, never in the exit's way. */
function tellExit(manager: Manager, live: Live): void {
  for (const listener of manager.exitListeners) {
    try {
      listener(live.chat.id)
    } catch (error) {
      manager.onError(error)
    }
  }
}

/**
 * A confirmed surface handoff: validates and freezes only the named owner at once, then joins its close, tree kill and
 * revocation. Naming an owner whose cleanup failed retries that cleanup instead.
 */
async function stopTerminal(manager: Manager, ref: ChatRef, generation: string): Promise<void> {
  const chat = manager.deps.store.getChat(ref)
  if (chat === null) throw new DomainError('not_found', noChat(ref))
  const fenced = [...manager.retiring].find(live => live.chat.id === chat.id && live.generation === generation)
  if (fenced !== undefined) return retire(manager, fenced)
  const live = runningTerminal(manager, chat.id)
  if (live === null || live.stopMessage !== null || live.generation !== generation) {
    throw new DomainError('busy', 'The terminal changed after the switch was confirmed; nothing was stopped.')
  }
  live.handoff = true
  void stop(manager, live, SWITCHING)
  await retire(manager, live)
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

/** `TerminalSessions.releaseFolder`. */
async function releaseFolder(manager: Manager, folder: string, forget: () => unknown, relatedFolders: readonly string[] = []): Promise<void> {
  const affected = new Set([folder, ...relatedFolders])
  for (const path of affected) manager.releasing.add(path)
  try {
    const inFolder = [...manager.entries.values()].filter((entry) => {
      const owner = entry.kind === 'live' ? entry.chat.folder : entry.folder
      return (owner !== null && affected.has(owner)) || entry.scopeFolders.some(path => affected.has(path))
    })
    await Promise.all(
      inFolder.map(async (entry) => {
        const ended = await endEntry(manager, entry, UNTRACKED)
        if (ended !== null) {
          await Promise.all([ended.kill, ended.live.revoke()])
        }
      })
    )
    await forget()
  } finally {
    for (const path of affected) manager.releasing.delete(path)
  }
}

async function dispose(manager: Manager): Promise<void> {
  manager.closing = true
  const ending = [...manager.entries.values()].map(async (entry) => {
    await (await endEntry(manager, entry, QUITTING))?.live.ended
  })
  await Promise.all(ending)
  await Promise.all(manager.pending)
}

function activeChats(manager: Manager): ChatRecord[] {
  return Array.from(manager.entries.values()).flatMap(entry =>
    entry.kind === 'live' && !entry.exited && entry.stopMessage === null ? [entry.chat] : [])
}

function runningTerminal(manager: Manager, chatId: string): Live | null {
  const entry = manager.entries.get(chatId)
  return entry?.kind === 'live' && !entry.exited ? entry : null
}

/** Typed input for the running PTY; a PTY frozen for a surface handoff takes none. */
function writeRunning(manager: Manager, chatId: string, data: string): void {
  const live = runningTerminal(manager, chatId)
  if (live !== null && live.handoff !== true) {
    writeInput(manager, live, data)
  }
}

function owner(manager: Manager, ref: ChatRef): string | null {
  const chat = manager.deps.store.getChat(ref)
  const live = chat === null ? null : runningTerminal(manager, chat.id)
  return live !== null && live.stopMessage === null ? live.generation : null
}

function pasteIfRunning(manager: Manager, ref: ChatRef, text: string): void {
  if (manager.closing) return
  const chat = manager.deps.store.getChat(ref)
  const entry = chat === null ? undefined : manager.entries.get(chat.id)
  if (entry?.kind === 'live' && !entry.exited && entry.stopMessage === null) queuePaste(manager, entry, text)
}

function isLive(manager: Manager, ref: ChatRef): boolean {
  const chat = manager.deps.store.getChat(ref)
  return chat !== null && (manager.entries.has(chat.id) || [...manager.retiring].some(live => live.chat.id === chat.id))
}

export function createTerminalSessions(deps: TerminalSessionsDeps): TerminalSessions {
  const { onError, ...rest } = deps
  const manager: Manager = {
    deps: {
      ...rest,
      killTree: deps.killTree ?? ((tree) => killPtyTree(tree)),
      agentChatLive: deps.agentChatLive ?? (() => false),
      keepAwake: deps.keepAwake ?? (() => () => {}),
      newSessionId: deps.newSessionId ?? randomUUID,
      timers: deps.timers ?? nodeTimers
    },
    onError: onError ?? (() => {}),
    entries: new Map(),
    listeners: new Map(),
    retiring: new Set(),
    pending: new Set(),
    deleting: new Set(),
    releasing: new Set(),
    closing: false,
    exitListeners: new Set(),
    launchListeners: new Set()
  }
  return {
    attach: (ref, listener, options = {}) => attach(manager, ref, listener, options),
    start: (ref, options) => start(manager, ref, options),
    detach: (chatId, listener) => { manager.listeners.get(chatId)?.delete(listener) },
    write: (chatId, data) => writeRunning(manager, chatId, data),
    paste: (ref, text, contextId) => paste(manager, ref, text, contextId),
    resize: (chatId, cols, rows) => {
      const live = runningTerminal(manager, chatId)
      if (live !== null) {
        live.pty.resize(cols, rows)
        live.screen.resize(cols, rows)
      }
    },
    deleteChat: (ref, remove) => deleteChat(manager, ref, remove),
    releaseFolder: (folder, forget, relatedFolders) => releaseFolder(manager, folder, forget, relatedFolders),
    endAgent: (id) => endAgent(manager, id),
    ...cultMemberEntries(manager),
    pasteIfRunning: (ref, text) => pasteIfRunning(manager, ref, text),
    activeChats: () => activeChats(manager),
    isRunning: (chatId) => runningTerminal(manager, chatId) !== null,
    isLive: ref => isLive(manager, ref),
    owner: ref => owner(manager, ref),
    stop: (ref, generation) => stopTerminal(manager, ref, generation),
    busy: () => manager.entries.size > 0 || manager.pending.size > 0,
    dispose: () => dispose(manager)
  }
}

/** Enters the chat's running launch, then tells the launch listeners; a listener that throws is reported, never in the start's way. */
function tellLaunch(manager: Manager, chatId: string, live: Live): void {
  manager.entries.set(chatId, live)
  for (const listener of manager.launchListeners) {
    try {
      listener(chatId)
    } catch (error) {
      manager.onError(error)
    }
  }
}

/** What a cult supervisor ends, upgrades and watches member terminals with. */
function cultMemberEntries(manager: Manager): Pick<TerminalSessions, 'endChat' | 'attachGrant' | 'detachGrant' | 'onExit' | 'onLaunch' | 'generationOf'> {
  return {
    endChat: (chatId, graceful) => endChat(manager, chatId, graceful),
    attachGrant: (chatId, grantId) => attachGrant(manager, chatId, grantId),
    detachGrant: (chatId, grantId) => detachGrant(manager, chatId, grantId),
    onExit: (listener) => {
      manager.exitListeners.add(listener)
      return () => {
        manager.exitListeners.delete(listener)
      }
    },
    onLaunch: (listener) => {
      manager.launchListeners.add(listener)
      return () => {
        manager.launchListeners.delete(listener)
      }
    },
    generationOf: (chatId) => runningTerminal(manager, chatId)?.generation ?? null
  }
}

/** `chats` with deleting a chat killing its terminal first: the record goes only once the kill has settled, and nothing starts it meanwhile. */
export function endingTerminals<T extends { deleteChat(ref: ChatRef): Promise<void> }>(chats: T, terminals: Pick<TerminalSessions, 'deleteChat'>): T {
  return { ...chats, deleteChat: (ref: ChatRef) => terminals.deleteChat(ref, () => chats.deleteChat(ref)) }
}
