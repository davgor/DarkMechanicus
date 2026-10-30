/**
 * The desktop bridge exposed by preload as `window.dm`. The renderer calls core commands through
 * one generic, allow-listed channel with the desktop session's permissions; folder management,
 * clipboard, and external links are separate narrow methods.
 */
import type { ChatsApi } from '../agents/chatApi'
import type { CommandApi, CommandName } from '../domain/api'
import type { DomainErrorShape } from '../domain/errors'
import type { BoardRemovalResultView, BoardRemovalView, StorageMode } from '../domain/views'

export interface TrackedFolderView {
  /** Canonical real path; the registry key. */
  path: string
  name: string
  /** Path with the home directory abbreviated to `~`. */
  displayPath: string
  initialized: boolean
  /** `repo`: records in the repository. `db`: one database in the Dark Mechanicus home directory. */
  storageMode: StorageMode
  /** False when the folder no longer exists or is unreadable. */
  available: boolean
  addedAt: string
}

/** The agents the app knows how to find and sign in (and, all but Autonomous, download); vendor maps are keyed by these. */
export type BuiltInAgentKind = 'claude' | 'codex' | 'cursor' | 'autonomous'

/** What an agent is: a built-in vendor CLI, or a custom CLI the person connected. */
type AgentKind = BuiltInAgentKind | 'custom'

/** How the app talks to an agent's CLI; chooses the chat adapter. */
export type AgentProtocol = 'claude' | 'codex' | 'acp'

/** An agent's id (see `agentIdSchema`): a built-in kind's name, or `cu_` and a ULID for a custom agent. */
export type AgentId = string

export interface AgentView {
  id: AgentId
  kind: AgentKind
  protocol: AgentProtocol
  displayName: string
  executablePath: string
  /** Arguments passed before the app's own; empty for built-ins. */
  args: readonly string[]
  version: string | null
  /** `custom`: a custom CLI the person added, with a program they picked and arguments they typed. */
  connectedVia: 'found' | 'downloaded' | 'custom'
  connectedAt: string
  lastProbed: string
}

/** Why a picked executable was refused; each code comes with a specific, human-readable reason. */
export type AgentRefusalCode =
  | 'not_a_file'
  | 'not_executable'
  | 'unsafe_path'
  | 'did_not_start'
  | 'timed_out'
  | 'failed'
  | 'wrong_program'

/**
 * What finding an agent came to. The renderer only names the kind: the executable is chosen in a
 * native dialog in the main process, so no path ever crosses the bridge from the renderer.
 */
export type AgentFindResult =
  | { outcome: 'connected'; agent: AgentView }
  /** The person closed the file dialog without choosing anything; nothing changed. */
  | { outcome: 'cancelled' }
  /** The pick was not this agent's CLI; nothing was stored. */
  | { outcome: 'refused'; code: AgentRefusalCode; reason: string }

/**
 * Adding a custom CLI: its name, protocol and arguments, and nothing else. The program is chosen in main's
 * native file dialog, never sent by the renderer; a payload with any other key (such as a path) is refused.
 * An argument that is exactly `{folder}` becomes the chat's folder each time the CLI starts.
 */
export interface CustomAgentRequest {
  name: string
  protocol: AgentProtocol
  args: string[]
}

/**
 * Editing a custom CLI: its new name and arguments. The protocol cannot change; the program changes only
 * through main's file dialog, which `repick` opens.
 */
export interface CustomAgentUpdate {
  id: AgentId
  name: string
  args: string[]
  repick: boolean
}

/** Why a download left nothing connected; each code comes with a specific reason and, for installer failures, its last output lines. */
export type AgentDownloadFailureCode =
  /** A download of this kind is already running. */
  | 'busy'
  /** There is no install recipe for this operating system or processor. */
  | 'unsupported_platform'
  | 'download_failed'
  /** The installer does not match the checksum the vendor published; it was not run. */
  | 'checksum_mismatch'
  /** The vendor published no checksum where one is required; nothing was downloaded. */
  | 'checksum_unavailable'
  | 'installer_failed'
  /** The installer finished but the CLI is not where the vendor puts it. */
  | 'executable_not_found'
  /** The installed executable did not pass the probe (not that CLI, did not start, timed out). */
  | 'verify_failed'
  | 'unexpected'

/**
 * What downloading an agent came to. The renderer only names the kind: the source, the command and
 * the install location all come from main, and the person confirms them in a native dialog first.
 */
export type AgentDownloadResult =
  /** Installed, probed and stored; `updated` is true when the agent was already connected. */
  | { outcome: 'installed'; agent: AgentView; updated: boolean }
  /** The person declined the confirmation; nothing was fetched or run. */
  | { outcome: 'cancelled' }
  /** Nothing was stored. `output` is the installer's last output lines (empty when it never ran). */
  | { outcome: 'failed'; code: AgentDownloadFailureCode; reason: string; output: string[] }

export type AgentDownloadPhase =
  | 'confirming'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'checking'
  | 'done'
  | 'cancelled'
  | 'failed'

/** One step of a running download, pushed to the renderer as it happens. */
export interface AgentDownloadProgress {
  kind: BuiltInAgentKind
  phase: AgentDownloadPhase
  /** Whole percent when the phase knows it (the download does, from the content length), otherwise null. */
  percent: number | null
}

/**
 * Whether an agent's CLI is signed in, as its own status command says; `unknown` when that cannot be told,
 * `unchecked` when the app has no way to check this CLI's sign-in (a custom CLI), so chats may use it.
 */
export type AgentAuthState = 'signed_in' | 'signed_out' | 'unknown' | 'unchecked'

/** The sign-in state with why. The reason is plain text about the state; it never carries the CLI's output. */
export interface AgentAuthStatus {
  state: AgentAuthState
  reason: string
}

/**
 * What starting a sign-in came to. `started` means the CLI's own login is now running in a terminal
 * window of its own (the vendor's browser page opens from there); check the status afterwards.
 */
export type AgentSignInResult = { outcome: 'started' } | { outcome: 'failed'; reason: string }

export type CommandInput<K extends CommandName> = Parameters<CommandApi[K]> extends [infer I]
  ? I
  : undefined

export type CommandOutput<K extends CommandName> = Awaited<ReturnType<CommandApi[K]>>

export type CommandResult<T> = { ok: true; data: T } | { ok: false; error: DomainErrorShape }

export interface McpConfigView {
  command: string
  args: string[]
  env: Record<string, string>
  /** Ready-to-paste `mcpServers` JSON block. */
  json: string
  /** Where this command comes from (packaged app, dev build). */
  note: string
}

/** Roles Claude Code can be connected as from the app. */
export const CLAUDE_CODE_ROLES = ['planner', 'orchestrator'] as const

export type ClaudeCodeRole = (typeof CLAUDE_CODE_ROLES)[number]

/** Writes the `darkmechanicus` server into the repository's `.mcp.json` for Claude Code. */
export interface ClaudeCodeConnectRequest {
  role: ClaudeCodeRole
  /** Adds `--allow-save`, so the agent may call `save_plan`. */
  allowSave: boolean
  /** Replace a different existing `darkmechanicus` entry; without it the entry is reported, not touched. */
  replace: boolean
}

/** What happened to `.mcp.json`. Only created, added and replaced wrote the file. */
export type ClaudeCodeConnectResult =
  | { outcome: 'created' | 'added' | 'replaced' | 'unchanged' }
  /** A different `darkmechanicus` entry is there (pretty JSON); nothing was written. */
  | { outcome: 'conflict'; existing: string }
  /** The file could not be merged (not JSON, or not shaped like an MCP config); it was left untouched. */
  | { outcome: 'invalid'; message: string }

export interface FolderPickResult {
  folder: TrackedFolderView | null
  /** False when the picked folder was already tracked (it is selected instead). */
  added: boolean
}

export interface DmApi {
  /** Agent chats run by the main process: the `chats:*` channels and their push channel. */
  chats: ChatsApi
  listFolders(): Promise<TrackedFolderView[]>
  pickFolder(): Promise<FolderPickResult>
  untrackFolder(path: string): Promise<TrackedFolderView[]>
  command<K extends CommandName>(
    folder: string,
    name: K,
    input: CommandInput<K>
  ): Promise<CommandResult<CommandOutput<K>>>
  getMcpConfig(folder: string): Promise<McpConfigView>
  installSkills(folder: string): Promise<{ written: string[] }>
  connectClaudeCode(folder: string, request: ClaudeCodeConnectRequest): Promise<ClaudeCodeConnectResult>
  /** What removing the old board workflow (`board/`, board-only skills) would delete; changes nothing. */
  previewBoardRemoval(folder: string): Promise<BoardRemovalView>
  /** Deletes the confirmed files that are still files to remove, then the folders left empty; never commits. */
  removeBoardFiles(folder: string, paths: string[]): Promise<BoardRemovalResultView>
  copyText(text: string): Promise<void>
  openExternal(url: string): Promise<boolean>
  /** Connected agents, at most one per id. */
  listAgents(): Promise<AgentView[]>
  /**
   * Opens a native file dialog for the built-in kind, verifies the picked executable is that agent's CLI,
   * and connects it. Takes the kind only; the renderer never supplies a path to run.
   */
  findAgent(kind: BuiltInAgentKind): Promise<AgentFindResult>
  /**
   * Forgets the connection of the agent with this id (never uninstalls the CLI) and returns the remaining
   * agents. A malformed id is refused with `invalid_input`, one that is not connected with `not_found`.
   */
  removeAgent(id: AgentId): Promise<AgentView[]>
  /**
   * Installs the built-in kind's CLI from its vendor's official source and connects it. Takes the kind only:
   * main owns the URL, the command and the location, shows them in a native confirmation first, and
   * fetches or runs nothing until the person confirms. Running it again updates an installed agent.
   */
  downloadAgent(kind: BuiltInAgentKind): Promise<AgentDownloadResult>
  /** Subscribes to the progress of downloads; returns the unsubscribe function. */
  onAgentDownloadProgress(listener: (progress: AgentDownloadProgress) => void): () => void
  /**
   * Asks the connected CLI's own status command whether it is signed in. Takes the agent id only; the
   * app reads no credential and keeps nothing of the command's output. Refuses a malformed id
   * (`invalid_input`) or one that is not connected (`not_found`) before anything runs.
   */
  agentStatus(id: AgentId): Promise<AgentAuthStatus>
  /**
   * Starts that CLI's own login flow in a visible terminal window. Takes the agent id only: there is no
   * password or key field anywhere, the vendor's own page does the signing in. Refuses ids like `agentStatus`.
   */
  signInAgent(id: AgentId): Promise<AgentSignInResult>
  /**
   * The default agent id of a tracked folder (canonicalized, so a symlink reads its target's), or null.
   * An untracked folder is refused with `unauthorized`.
   */
  folderDefaultAgent(folder: string): Promise<AgentId | null>
  /**
   * Sets (or, with null, clears) a tracked folder's default agent and returns it. An untracked folder is
   * refused with `unauthorized`, a malformed id with `invalid_input` and one that is not connected with `not_found`.
   */
  setFolderDefaultAgent(request: { folder: string; agentId: AgentId | null }): Promise<AgentId | null>
  /**
   * Adds a custom CLI: main opens a native file dialog for its program, checks the name and arguments, shows
   * the exact command in a native confirmation, and runs the protocol's handshake in an empty temp folder.
   * Only then is it stored, as `cu_…`. A payload with a path or any other key is refused with `invalid_input`,
   * a name another custom CLI has with `conflict`.
   */
  addCustomAgent(request: CustomAgentRequest): Promise<AgentFindResult>
  /**
   * Edits a custom CLI's name and arguments (and, with `repick`, its program, through main's file dialog),
   * with the same checks, confirmation and handshake as adding it. The protocol never changes.
   */
  updateCustomAgent(request: CustomAgentUpdate): Promise<AgentFindResult>
}

/** Every CommandApi method the renderer may invoke. Main rejects anything else. */
const DESKTOP_COMMANDS = [
  'getCapabilities',
  'getProject',
  'setDefinitionOfDone',
  'initializeRepository',
  'getStorageStatus',
  'flushPortableState',
  'reconcileRepository',
  'searchHistory',
  'listBranchEpics',
  'backupDatabase',
  'listSessions',
  'issueGrant',
  'listGrants',
  'revokeGrant',
  'listEpics',
  'createEpic',
  'getEpic',
  'setEpicStatus',
  'setEpicBranch',
  'deleteEpic',
  'previewBoardImport',
  'importBoard',
  'getPlan',
  'openDraft',
  'updatePlanDraft',
  'validatePlan',
  'savePlan',
  'discardPlanDraft',
  'listRevisions',
  'listTickets',
  'getTicket',
  'setTicketStatus',
  'deleteTicket',
  'addComment',
  'listComments',
  'listProfiles',
  'getProfile',
  'saveProfile',
  'queueRun',
  'getRun',
  'getReadyTickets',
  'acceptAttempt',
  'rejectAttempt',
  'reconcileAttempt',
  'pauseRun',
  'resumeRun',
  'cancelRun',
  'takeoverRun',
  'adoptRevision',
  'redraftNextSprint',
  'getSprintReport',
  'getCheckpoint',
  'approveCheckpoint',
  'advanceSprint',
  'approveAndAdvance',
  'approveWithRedraft',
  'authorizeAutoContinue',
  'grantRetry',
  'listEvents',
  'getAttemptTimeline',
  'getRunTimeline'
] as const satisfies readonly CommandName[]

export type DesktopCommandName = (typeof DESKTOP_COMMANDS)[number]

export { DESKTOP_COMMANDS }
