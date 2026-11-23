/**
 * The behavior behind the `dm:*` IPC channels, as a pure factory over injected dependencies (no
 * Electron imports). Every argument arrives from the renderer and is untrusted: it is validated
 * here, and folders must be tracked before anything is opened, run, or written for them.
 */
import { z } from 'zod'
import { realpathSync, statSync } from 'node:fs'
import { DomainError, toErrorShape } from '../../core/errors'
import { parseInput } from '../../core/schemas'
import type { ProjectWorkspace } from './workspaceClient'
import type { BoardRemovalResultView, BoardRemovalView } from '../../shared/domain/views'
import {
  CLAUDE_CODE_ROLES,
  DESKTOP_COMMANDS,
  type ClaudeCodeConnectRequest,
  type ClaudeCodeConnectResult,
  type CommandResult,
  type DesktopCommandName,
  type FolderPickResult,
  type McpConfigView,
  type TrackedFolderView
} from '../../shared/desktop/api'
import { createAgentAuthHandlers, type AgentAuthHandlers, type AgentAuthHooks } from './agentAuth'
import { createAgentHandlers, type AgentHandlerDeps, type AgentHandlers } from './agentHandlers'
import { createFolderDefaultHandlers, type FolderDefaultHandlerDeps, type FolderDefaultHandlers } from './folderAgentDefaults'
import type { FolderRegistry } from './folderRegistry'
import { createOmpThemeHandlers, type OmpThemeHandlers } from './ompTheme'
import { normalizeExternalUrl } from './navigation'
import type { SourceControlTarget } from '../../shared/git/api'

/** Windows long-path maximum; bounds path strings from the renderer. */
const MAX_PATH_LENGTH = 32_767
const MAX_COMMAND_NAME_LENGTH = 64
/** The most text the UI may put on the clipboard (the 100 KB Markdown body limit). */
const MAX_COPY_TEXT_LENGTH = 100_000
const MAX_EXTERNAL_URL_LENGTH = 4_096
/** Bounds the confirmed list of board files to remove: more than every removal root may hold. */
const MAX_REMOVAL_PATHS = 20_000
const MAX_REMOVAL_PATH_LENGTH = 4_096

const folderSchema = z.string().min(1).max(MAX_PATH_LENGTH)
const commandNameSchema = z.string().min(1).max(MAX_COMMAND_NAME_LENGTH)
const copyTextSchema = z.string().max(MAX_COPY_TEXT_LENGTH)
const externalUrlSchema = z.string().max(MAX_EXTERNAL_URL_LENGTH)
const removalPathsSchema = z.array(z.string().min(1).max(MAX_REMOVAL_PATH_LENGTH)).max(MAX_REMOVAL_PATHS)
const claudeCodeRequestSchema = z.strictObject({
  role: z.enum(CLAUDE_CODE_ROLES),
  allowSave: z.boolean(),
  replace: z.boolean()
})

export interface DesktopHandlerDeps extends AgentHandlerDeps, AgentAuthHooks, FolderDefaultHandlerDeps {
  registry: Pick<FolderRegistry, 'list' | 'track' | 'untrack' | 'resolve' | 'storageMode'>
  pool: { get(path: string): Pick<ProjectWorkspace, DesktopCommandName>; close(path: string): void | Promise<void> }
  /**
   * Untrack's first step: stops the folder's chat terminals and starts, suspends its chat mailboxes, and only then runs
   * `forget` (the untrack itself), with nothing of the folder allowed to start meanwhile (`terminalSessions.ts`).
   */
  releaseFolder: (folder: string, forget: () => void | Promise<void>, relatedFolders?: readonly string[]) => Promise<void>
  /**
   * Stops the folder's chat mail monitor (`agentMailDesktop.ts`) and forgets what it served. Untrack calls it before the
   * release starts and again right before the registry forgets the folder, so no poll reaches a closing workspace.
   */
  stopMailMonitor: (folder: string) => void
  /** Native folder picker; null when the person cancels. */
  pickDirectory: (mode?: 'forge-world') => Promise<string | null>
  writeClipboard: (text: string) => void
  openExternal: (url: string) => Promise<void>
  folderTarget?: (tracked: string) => Promise<SourceControlTarget>
  openPath?: (path: string) => Promise<string>
  mcpConfig: (repoPath: string) => McpConfigView
  installSkills: (repoPath: string) => { written: string[] }
  /** Writes the `darkmechanicus` server into the repository's `.mcp.json`; never commits. */
  connectClaudeCode: (repoPath: string, request: ClaudeCodeConnectRequest) => ClaudeCodeConnectResult
  /** What removing the old board workflow would delete; changes nothing. */
  previewBoardRemoval: (repoPath: string) => BoardRemovalView
  /** Deletes the confirmed board files that are still candidates, then the folders left empty; never commits. */
  removeBoardFiles: (repoPath: string, confirmed: readonly string[]) => BoardRemovalResultView
  /** OMP's agent folder (tests); the default follows `PI_CODING_AGENT_DIR`. */
  ompAgentDir?: () => string
  /** Told about command failures that are not DomainErrors (bugs, I/O), so main can log the stack. */
  onUnexpectedError?: (error: unknown) => void
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface DesktopHandlers extends AgentHandlers, AgentAuthHandlers, FolderDefaultHandlers, OmpThemeHandlers {
  listFolders(): Promise<TrackedFolderView[]>
  pickFolder(mode?: unknown): Promise<FolderPickResult>
  untrackFolder(path: unknown): Promise<TrackedFolderView[]>
  openTrackedFolder(folder: unknown, expectedPath?: unknown): Promise<CommandResult<null>>
  command(folder: unknown, name: unknown, input: unknown): Promise<CommandResult<unknown>>
  getMcpConfig(folder: unknown): Promise<McpConfigView>
  installSkills(folder: unknown): Promise<{ written: string[] }>
  connectClaudeCode(folder: unknown, request: unknown): Promise<ClaudeCodeConnectResult>
  previewBoardRemoval(folder: unknown): Promise<BoardRemovalView>
  removeBoardFiles(folder: unknown, paths: unknown): Promise<BoardRemovalResultView>
  copyText(text: unknown): Promise<void>
  openExternal(url: unknown): Promise<boolean>
}

interface CommandRequest {
  folder: unknown
  name: unknown
  input: unknown
}

type WorkspaceCommand = (input: unknown) => Promise<unknown>

/**
 * A database-only project is invisible to its repository: Dark Mechanicus neither writes nor
 * deletes anything there, so every operation that would change the checkout is refused rather than
 * quietly skipped. The connection snippet is still available to copy into the agent host's own
 * config, and reading the repository (the board preview, the board import) is unaffected.
 */
function assertRepositoryWritable(
  registry: Pick<FolderRegistry, 'storageMode'>,
  repoPath: string,
  action: string
): void {
  if (registry.storageMode(repoPath) === 'db') {
    throw new DomainError(
      'unsupported_capability',
      `${action} would write into ${repoPath}. That folder is a database-only project, and Dark Mechanicus writes nothing into it: copy the MCP connection snippet into your agent host's own configuration instead.`,
      { path: repoPath, storageMode: 'db' }
    )
  }
}

/** The canonical path of a tracked folder; anything else is unauthorized. */
export function requireTracked(registry: Pick<FolderRegistry, 'resolve'>, folder: unknown): string {
  const requested = parseInput(folderSchema, folder, 'folder')
  const tracked = registry.resolve(requested)
  if (tracked === null) {
    throw new DomainError('unauthorized', 'That folder is not tracked by Dark Mechanicus.')
  }
  return tracked
}

function assertDesktopCommand(name: string): asserts name is DesktopCommandName {
  if (!(DESKTOP_COMMANDS as readonly string[]).includes(name)) {
    throw new DomainError('unauthorized', `The desktop may not call "${name}".`)
  }
}

function invokeCommand(workspace: Pick<ProjectWorkspace, DesktopCommandName>, name: DesktopCommandName, input: unknown): Promise<unknown> {
  const command = workspace[name] as WorkspaceCommand
  return command.call(workspace, input)
}

async function runCommand(deps: DesktopHandlerDeps, request: CommandRequest): Promise<CommandResult<unknown>> {
  try {
    const name = parseInput(commandNameSchema, request.name, 'command name')
    assertDesktopCommand(name)
    const repoPath = requireTracked(deps.registry, request.folder)
    const workspace = deps.pool.get(repoPath)
    return { ok: true, data: await invokeCommand(workspace, name, request.input) }
  } catch (error) {
    if (!(error instanceof DomainError)) {
      deps.onUnexpectedError?.(error)
    }
    return { ok: false, error: toErrorShape(error) }
  }
}

async function pickFolder(deps: DesktopHandlerDeps, input?: unknown): Promise<FolderPickResult> {
  const mode = parseInput(z.literal('forge-world').optional(), input, 'folder mode')
  const picked = await deps.pickDirectory(mode)
  if (picked === null) {
    return { folder: null, added: false }
  }
  const { folder, added } = deps.registry.track(picked)
  return { folder, added }
}

async function openTrackedFolder(deps: DesktopHandlerDeps, folder: unknown, expectedPath: unknown): Promise<CommandResult<null>> {
  try {
    const tracked = requireTracked(deps.registry, folder)
    const expected = parseInput(folderSchema.optional(), expectedPath, 'displayed folder path')
    if (!deps.folderTarget || !deps.openPath) throw new DomainError('unsupported_capability', 'Opening folders is unavailable.')
    const target = await deps.folderTarget(tracked)
    if (target.kind === 'unavailable') throw new DomainError('not_found', target.reason)
    if (expected !== undefined && expected !== target.path) throw new DomainError('invalid_state', 'The linked folder changed. Refresh this page before opening it.')
    if (!statSync(target.path).isDirectory() || realpathSync.native(target.path) !== target.path) throw new DomainError('not_found', 'The folder moved or was replaced. Refresh its location before opening it.')
    const error = await deps.openPath(target.path)
    if (error) throw new DomainError('invalid_state', error)
    return { ok: true, data: null }
  } catch (error) { return { ok: false, error: toErrorShape(error) } }
}

async function untrackFolder(deps: DesktopHandlerDeps, path: unknown): Promise<TrackedFolderView[]> {
  const requested = parseInput(folderSchema, path, 'folder')
  const tracked = deps.registry.resolve(requested)
  if (tracked === null) {
    return deps.registry.list()
  }
  let remaining: TrackedFolderView[] = []
  const members = deps.registry.list().filter(folder => folder.forgeParent === tracked).map(folder => folder.path)
  const affected = [tracked, ...members]
  for (const folder of affected) deps.stopMailMonitor(folder)
  await deps.releaseFolder(tracked, async () => {
    // A snapshot during the release may have started it again; nothing can between here and the close.
    for (const folder of affected) deps.stopMailMonitor(folder)
    deps.registry.untrack(tracked)
    remaining = deps.registry.list()
    for (const folder of affected) deps.folderDefaults.set(folder, null)
    await Promise.all(affected.map(folder => deps.pool.close(folder)))
  }, members)
  return remaining
}

/** Opens only http, https, and mailto links, passing the parsed form of the URL to the system. */
async function openExternalUrl(deps: DesktopHandlerDeps, url: unknown): Promise<boolean> {
  const parsed = externalUrlSchema.safeParse(url)
  const target = parsed.success ? normalizeExternalUrl(parsed.data) : null
  if (target === null) {
    return false
  }
  try {
    await deps.openExternal(target)
    return true
  } catch {
    return false
  }
}

/**
 * Refuses while the board still has open epics that no import brought in: removing `board/` then
 * would lose them. The renderer only offers the removal once nothing is left to import.
 */
async function assertBoardImported(workspace: Pick<ProjectWorkspace, 'previewBoardImport'>): Promise<void> {
  const board = await workspace.previewBoardImport()
  const waiting = board.open.filter((epic) => epic.state === 'new').length
  if (waiting > 0) {
    const epics = waiting === 1 ? '1 open epic on it has' : `${waiting} open epics on it have`
    throw new DomainError('conflict', `Import the board first: ${epics} not been imported yet.`)
  }
}

/** Deletes the confirmed board files of a tracked folder, once nothing on its board is left to import. */
async function removeBoardFiles(deps: DesktopHandlerDeps, folder: unknown, paths: unknown): Promise<BoardRemovalResultView> {
  const repoPath = requireTracked(deps.registry, folder)
  assertRepositoryWritable(deps.registry, repoPath, 'Removing the old board files')
  const confirmed = parseInput(removalPathsSchema, paths, 'files to remove')
  await assertBoardImported(deps.pool.get(repoPath))
  return deps.removeBoardFiles(repoPath, confirmed)
}

/** The first folder chosen in a native open dialog result, or null when cancelled or empty. */
export function firstPickedDirectory(result: { canceled: boolean; filePaths: readonly string[] }): string | null {
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

export function createDesktopHandlers(deps: DesktopHandlerDeps): DesktopHandlers {
  return {
    ...createAgentHandlers(deps),
    ...createAgentAuthHandlers(deps.agents, deps),
    ...createFolderDefaultHandlers(deps, (folder) => requireTracked(deps.registry, folder)),
    ...createOmpThemeHandlers(deps.ompAgentDir === undefined ? {} : { agentDir: deps.ompAgentDir }),
    listFolders: async () => deps.registry.list(),
    pickFolder: (mode) => pickFolder(deps, mode),
    untrackFolder: (path) => untrackFolder(deps, path),
    openTrackedFolder: (folder, expectedPath) => openTrackedFolder(deps, folder, expectedPath),
    command: (folder, name, input) => runCommand(deps, { folder, name, input }),
    getMcpConfig: async (folder) => deps.mcpConfig(requireTracked(deps.registry, folder)),
    installSkills: async (folder) => {
      const repoPath = requireTracked(deps.registry, folder)
      assertRepositoryWritable(deps.registry, repoPath, 'Installing the Dark Mechanicus skills')
      return deps.installSkills(repoPath)
    },
    connectClaudeCode: async (folder, request) => {
      const repoPath = requireTracked(deps.registry, folder)
      assertRepositoryWritable(deps.registry, repoPath, 'Writing .mcp.json')
      return deps.connectClaudeCode(repoPath, parseInput(claudeCodeRequestSchema, request, 'Claude Code connection'))
    },
    previewBoardRemoval: async (folder) => deps.previewBoardRemoval(requireTracked(deps.registry, folder)),
    removeBoardFiles: (folder, paths) => removeBoardFiles(deps, folder, paths),
    copyText: async (text) => {
      deps.writeClipboard(parseInput(copyTextSchema, text, 'clipboard text'))
    },
    openExternal: (url) => openExternalUrl(deps, url)
  }
}
