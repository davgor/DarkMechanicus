/**
 * The desktop bridge exposed by preload as `window.dm`. The renderer calls core commands through
 * one generic, allow-listed channel with the desktop session's permissions; folder management,
 * clipboard, and external links are separate narrow methods.
 */
import type { CommandApi, CommandName } from '../domain/api'
import type { DomainErrorShape } from '../domain/errors'

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
  copyText(text: string): Promise<void>
  openExternal(url: string): Promise<boolean>
}

/** Every CommandApi method the renderer may invoke. Main rejects anything else. */
const DESKTOP_COMMANDS = [
  'getCapabilities',
  'getProject',
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
  'getSprintReport',
  'getCheckpoint',
  'approveCheckpoint',
  'advanceSprint',
  'approveAndAdvance',
  'authorizeAutoContinue',
  'grantRetry',
  'listEvents'
] as const satisfies readonly CommandName[]

export type DesktopCommandName = (typeof DESKTOP_COMMANDS)[number]

export { DESKTOP_COMMANDS }
