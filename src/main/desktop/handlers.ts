/**
 * The behavior behind the `dm:*` IPC channels, as a pure factory over injected dependencies (no
 * Electron imports). Every argument arrives from the renderer and is untrusted: it is validated
 * here, and folders must be tracked before anything is opened, run, or written for them.
 */
import { z } from 'zod'
import { DomainError, toErrorShape } from '../../core/errors'
import { parseInput } from '../../core/schemas'
import type { Workspace } from '../../core/workspace'
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
import type { FolderRegistry } from './folderRegistry'
import { normalizeExternalUrl } from './navigation'
import type { WorkspacePool } from './workspacePool'

/** Windows long-path maximum; bounds path strings from the renderer. */
const MAX_PATH_LENGTH = 32_767
const MAX_COMMAND_NAME_LENGTH = 64
/** The most text the UI may put on the clipboard (the 100 KB Markdown body limit). */
const MAX_COPY_TEXT_LENGTH = 100_000
const MAX_EXTERNAL_URL_LENGTH = 4_096

const folderSchema = z.string().min(1).max(MAX_PATH_LENGTH)
const commandNameSchema = z.string().min(1).max(MAX_COMMAND_NAME_LENGTH)
const copyTextSchema = z.string().max(MAX_COPY_TEXT_LENGTH)
const externalUrlSchema = z.string().max(MAX_EXTERNAL_URL_LENGTH)
const claudeCodeRequestSchema = z.strictObject({
  role: z.enum(CLAUDE_CODE_ROLES),
  allowSave: z.boolean(),
  replace: z.boolean()
})

export interface DesktopHandlerDeps {
  registry: Pick<FolderRegistry, 'list' | 'track' | 'untrack' | 'resolve'>
  pool: Pick<WorkspacePool, 'get' | 'close'>
  /** Native folder picker; null when the person cancels. */
  pickDirectory: () => Promise<string | null>
  writeClipboard: (text: string) => void
  openExternal: (url: string) => Promise<void>
  mcpConfig: (repoPath: string) => McpConfigView
  installSkills: (repoPath: string) => { written: string[] }
  /** Writes the `darkmechanicus` server into the repository's `.mcp.json`; never commits. */
  connectClaudeCode: (repoPath: string, request: ClaudeCodeConnectRequest) => ClaudeCodeConnectResult
  /** Told about command failures that are not DomainErrors (bugs, I/O), so main can log the stack. */
  onUnexpectedError?: (error: unknown) => void
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface DesktopHandlers {
  listFolders(): Promise<TrackedFolderView[]>
  pickFolder(): Promise<FolderPickResult>
  untrackFolder(path: unknown): Promise<TrackedFolderView[]>
  command(folder: unknown, name: unknown, input: unknown): Promise<CommandResult<unknown>>
  getMcpConfig(folder: unknown): Promise<McpConfigView>
  installSkills(folder: unknown): Promise<{ written: string[] }>
  connectClaudeCode(folder: unknown, request: unknown): Promise<ClaudeCodeConnectResult>
  copyText(text: unknown): Promise<void>
  openExternal(url: unknown): Promise<boolean>
}

interface CommandRequest {
  folder: unknown
  name: unknown
  input: unknown
}

type WorkspaceCommand = (input: unknown) => Promise<unknown>

/** The canonical path of a tracked folder; anything else is unauthorized. */
function requireTracked(registry: Pick<FolderRegistry, 'resolve'>, folder: unknown): string {
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

function invokeCommand(workspace: Workspace, name: DesktopCommandName, input: unknown): Promise<unknown> {
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

async function pickFolder(deps: DesktopHandlerDeps): Promise<FolderPickResult> {
  const picked = await deps.pickDirectory()
  if (picked === null) {
    return { folder: null, added: false }
  }
  const { folder, added } = deps.registry.track(picked)
  return { folder, added }
}

async function untrackFolder(deps: DesktopHandlerDeps, path: unknown): Promise<TrackedFolderView[]> {
  const requested = parseInput(folderSchema, path, 'folder')
  const tracked = deps.registry.resolve(requested)
  if (tracked === null) {
    return deps.registry.list()
  }
  const remaining = deps.registry.untrack(tracked)
  deps.pool.close(tracked)
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

/** The first folder chosen in a native open dialog result, or null when cancelled or empty. */
export function firstPickedDirectory(result: { canceled: boolean; filePaths: readonly string[] }): string | null {
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

export function createDesktopHandlers(deps: DesktopHandlerDeps): DesktopHandlers {
  return {
    listFolders: async () => deps.registry.list(),
    pickFolder: () => pickFolder(deps),
    untrackFolder: (path) => untrackFolder(deps, path),
    command: (folder, name, input) => runCommand(deps, { folder, name, input }),
    getMcpConfig: async (folder) => deps.mcpConfig(requireTracked(deps.registry, folder)),
    installSkills: async (folder) => deps.installSkills(requireTracked(deps.registry, folder)),
    connectClaudeCode: async (folder, request) => {
      const repoPath = requireTracked(deps.registry, folder)
      return deps.connectClaudeCode(repoPath, parseInput(claudeCodeRequestSchema, request, 'Claude Code connection'))
    },
    copyText: async (text) => {
      deps.writeClipboard(parseInput(copyTextSchema, text, 'clipboard text'))
    },
    openExternal: (url) => openExternalUrl(deps, url)
  }
}
