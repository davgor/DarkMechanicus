/**
 * The desktop bridge exposed by preload as `window.dm`. The renderer calls core commands through
 * one generic, allow-listed channel with the desktop session's permissions; folder management,
 * clipboard, and external links are separate narrow methods.
 */
import type { CommandApi, CommandName } from '../domain/api'
import type { DomainErrorShape } from '../domain/errors'
import type { BoardRemovalResultView, BoardRemovalView } from '../domain/views'

export interface TrackedFolderView {
  /** Canonical real path; the registry key. */
  path: string
  name: string
  /** Path with the home directory abbreviated to `~`. */
  displayPath: string
  initialized: boolean
  /** False when the folder no longer exists or is unreadable. */
  available: boolean
  addedAt: string
}

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
  'listEvents'
] as const satisfies readonly CommandName[]

export type DesktopCommandName = (typeof DESKTOP_COMMANDS)[number]

export { DESKTOP_COMMANDS }
