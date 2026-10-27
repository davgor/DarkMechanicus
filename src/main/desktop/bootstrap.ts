/**
 * Wires the desktop bridge to Electron: the tracked-folder and agent registries, one Workspace per
 * folder, native dialogs, clipboard, external links, the agent chat sessions, and the `dm:*`, `agents:*`
 * and `chats:*` IPC channels. All logic lives in the pure modules beside this file and in
 * `../agents`; this one is composition only, so it has no unit tests of its own.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  shell,
  type IpcMain,
  type OpenDialogOptions
} from 'electron'
import { join } from 'node:path'
import { DomainError } from '../../core/errors'
import { openWorkspace, type Workspace } from '../../core/workspace'
import type { AgentDownloadProgress, AgentKind, McpConfigView } from '../../shared/desktop/api'
import { createActivityBindings, type ActivityBindings } from '../agents/activityBindings'
import { CHAT_ADAPTERS } from '../agents/adapterRegistry'
import { createChatHandlers } from '../agents/chatHandlers'
import { createChatPush, registerChatIpc } from '../agents/chatIpc'
import { createChatStore } from '../agents/chatStore'
import { createSessionManager, type SessionManager } from '../agents/sessionManager'
import { listBoundThreads } from '../agents/boundThreads'
import { listThreadBindings, type BindingReads } from '../agents/threadBindings'
import { trackChatSignIn } from '../agents/signInHooks'
import { logger } from '../logger'
import { getAgentAuthStatus, signInAgent } from './agentAuth'
import { launchTerminal } from './agentAuthNode'
import {
  createAgentInstaller,
  installDialogOptions,
  type AgentInstaller,
  type InstallConfirmation
} from './agentInstaller'
import {
  createInstallerFiles,
  createInstallerHttp,
  nodeInstallEnvironment,
  runInstallerProcess
} from './agentInstallerNode'
import { agentDialogOptions, probeAgent, type AgentProbeDeps } from './agentProbe'
import { inspectExecutable, runProcess } from './agentProbeNode'
import { createAgentRegistry, type AgentRegistry } from './agentRegistry'
import { previewBoardRemoval, removeBoardFiles } from './boardRemovalFiles'
import { createFolderRegistry, type FolderRegistry } from './folderRegistry'
import { createDesktopHandlers, firstPickedDirectory } from './handlers'
import { registerDesktopIpc } from './ipc'
import { buildMcpConfig } from './mcpConfig'
import { claudeCodeServer } from './mcpJson'
import { writeMcpServer } from './mcpJsonFile'
import { installClaudeSkills, type SkillDefinition } from './skillInstall'
import { createWorkspacePool, type WorkspacePool } from './workspacePool'

/** How often each open desktop session is marked alive. */
const HEARTBEAT_INTERVAL_MS = 15_000

const FOLDER_DIALOG: OpenDialogOptions = {
  title: 'Choose a repository folder',
  properties: ['openDirectory', 'createDirectory']
}

function showOpenDialog(options: OpenDialogOptions): Promise<string | null> {
  const parent = BrowserWindow.getFocusedWindow()
  const shown = parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)
  return shown.then(firstPickedDirectory)
}

function pickDirectory(): Promise<string | null> {
  return showOpenDialog(FOLDER_DIALOG)
}

/** The only place an executable to run is chosen: a native dialog in this process, never the renderer. */
function pickExecutable(kind: AgentKind): Promise<string | null> {
  return showOpenDialog(agentDialogOptions(kind, process.platform))
}

/** What running an agent's registered executable needs: the real runner and file check for this platform. */
function agentRunDeps(): AgentProbeDeps {
  return {
    platform: process.platform,
    run: runProcess,
    inspect: inspectExecutable,
    ...(process.env['ComSpec'] === undefined ? {} : { comspec: process.env['ComSpec'] })
  }
}

function probeExecutable(kind: AgentKind, executablePath: string): ReturnType<typeof probeAgent> {
  return probeAgent(kind, executablePath, agentRunDeps())
}

/**
 * The only place a download is approved: a native message box in this process, which no renderer text
 * or script can answer. Only a click on the first button is a yes.
 */
function confirmInstall(confirmation: InstallConfirmation): Promise<boolean> {
  const options = installDialogOptions(confirmation)
  const parent = BrowserWindow.getFocusedWindow()
  const shown = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
  return shown.then(({ response }) => response === 0)
}

function broadcastDownloadProgress(progress: AgentDownloadProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('agents:downloadProgress', progress)
    }
  }
}

function createInstaller(agents: AgentRegistry): AgentInstaller {
  return createAgentInstaller({
    environment: nodeInstallEnvironment(),
    confirm: confirmInstall,
    http: createInstallerHttp(),
    run: runInstallerProcess,
    files: createInstallerFiles(),
    inspect: inspectExecutable,
    probeAgent: probeExecutable,
    agents,
    report: broadcastDownloadProgress
  })
}

/** The MCP launch command for `repoPath`, for this build of the app (packaged or development). */
function mcpConfigFor(repoPath: string): McpConfigView {
  return buildMcpConfig({
    packaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    repoPath
  })
}

function openDesktopWorkspace(repoRoot: string): Workspace {
  return openWorkspace({
    repoRoot,
    role: 'desktop',
    label: 'Desktop',
    transport: 'desktop',
    pid: process.pid,
    serverInfo: { name: 'darkmechanicus-desktop', version: app.getVersion() }
  })
}

/** What main keeps of the bridge: the chat sessions, which must be disposed before the app exits. */
interface DesktopBridge {
  chats: Pick<SessionManager, 'liveCount' | 'disposeAll'>
}

/** The desktop's own workspace for a tracked folder; the run commands of a chat never reach a folder that is not tracked. */
function desktopWorkspace(folders: Pick<FolderRegistry, 'resolve'>, workspaces: Pick<WorkspacePool, 'get'>, folder: string): Workspace {
  const tracked = folders.resolve(folder)
  if (tracked === null) {
    throw new DomainError('unauthorized', 'That folder is not tracked by Dark Mechanicus.')
  }
  return workspaces.get(tracked)
}

/**
 * Runs agent chats (`userData/agents/chats`) with the connected agents, binding their threads to the runs
 * and attempts they act on (`activity`). When a chat's agent turns out to be signed out, the run it
 * orchestrates is paused with the reason `signed_out` through the folder's own desktop workspace: the
 * only session that may give that reason.
 */
function createSessions(
  folders: Pick<FolderRegistry, 'resolve'>,
  agents: Pick<AgentRegistry, 'list'>,
  workspaces: Pick<WorkspacePool, 'get'>,
  activity: ActivityBindings
): SessionManager {
  return createSessionManager({
    store: createChatStore({ root: join(app.getPath('userData'), 'agents', 'chats') }),
    activity,
    adapters: CHAT_ADAPTERS,
    executablePath: (kind) => agents.list().find((agent) => agent.kind === kind)?.executablePath ?? null,
    mcpConfig: mcpConfigFor,
    push: createChatPush(() => BrowserWindow.getAllWindows()),
    runs: {
      getRun: async (folder, runId) => desktopWorkspace(folders, workspaces, folder).getRun({ runId }),
      pauseRun: async (folder, input) => desktopWorkspace(folders, workspaces, folder).pauseRun(input)
    },
    onError: (error) => {
      logger.error('Agent chat failed:', error)
    }
  })
}

/** What the desktop's own workspace can say about a run and an attempt, for resolving the tickets chat threads are bound to. */
function bindingReads(workspaces: Pick<WorkspacePool, 'get'>): BindingReads {
  return {
    attempt: async (folder, attemptId) => {
      const { runId, ticketId } = await workspaces.get(folder).getAttemptTimeline({ attemptId, limit: 1 })
      return { runId, ticketId }
    },
    run: async (folder, runId) => {
      const run = await workspaces.get(folder).getRun({ runId })
      return run === null ? null : { epicId: run.epicId, tickets: run.tickets.map((ticket) => ({ ticketId: ticket.ticketId, key: ticket.key })) }
    }
  }
}

/** What the `chats:*` channels run over: the tracked folders, the chat sessions, the workspaces and the thread bindings. */
interface ChatServices {
  folders: Pick<FolderRegistry, 'resolve'>
  sessions: SessionManager
  workspaces: Pick<WorkspacePool, 'get'>
  activity: ActivityBindings
}

/** Serves the `chats:*` channels over the chat sessions. */
function startChats(ipc: Pick<IpcMain, 'handle'>, services: ChatServices): void {
  const { folders, sessions, workspaces, activity } = services
  const handlers = createChatHandlers({
    registry: folders,
    sessions,
    // Every window hears of a chat created, renamed or deleted, so none keeps a stale list.
    push: createChatPush(() => BrowserWindow.getAllWindows()),
    threadBindings: (chat) => listThreadBindings({ activity, reads: bindingReads(workspaces) }, chat),
    boundThreads: (folder, target) => listBoundThreads(activity, folder, target),
    // The same desktop commands the Start run button runs, through the folder's own workspace.
    runs: {
      getEpic: (folder, epicId) => workspaces.get(folder).getEpic({ epicId }),
      queueRun: (folder, epicId) => workspaces.get(folder).queueRun({ epicId })
    },
    onUnexpectedError: (error) => {
      logger.error('Chat request failed:', error)
    }
  })
  registerChatIpc(ipc, handlers)
}

/**
 * Registers the `dm:*`, `agents:*` and `chats:*` IPC handlers on `ipc` (the sender-guarded
 * registrar from `guardIpc`) and the background heartbeat/shutdown for open workspaces.
 */
export function startDesktopBridge(skills: readonly SkillDefinition[], ipc: Pick<IpcMain, 'handle'>): DesktopBridge {
  const registry = createFolderRegistry({
    file: join(app.getPath('userData'), 'folders.json'),
    homeDir: app.getPath('home')
  })
  const agents = createAgentRegistry({ file: join(app.getPath('userData'), 'agents.json') })
  const installer = createInstaller(agents)
  const pool = createWorkspacePool(openDesktopWorkspace, (path, error) => {
    logger.error(`Workspace error for ${path}:`, error)
  })
  // Which chat threads act on which runs and attempts, next to the chats; main code looks them up here.
  const activity = createActivityBindings({ file: join(app.getPath('userData'), 'agents', 'activity-bindings.jsonl') })
  const sessions = createSessions(registry, agents, pool, activity)
  // The status the app shows is the CLI's own, corrected by what chats found out (an expired login).
  const authHooks = trackChatSignIn(
    {
      checkAuth: (kind, executablePath) => getAgentAuthStatus(kind, executablePath, agentRunDeps()),
      signIn: (kind, executablePath) => signInAgent(kind, executablePath, { ...agentRunDeps(), launch: launchTerminal })
    },
    sessions
  )
  const handlers = createDesktopHandlers({
    registry,
    pool,
    agents,
    pickDirectory,
    pickExecutable,
    probeAgent: probeExecutable,
    installAgent: (kind) => installer.download(kind),
    checkAuth: authHooks.checkAuth,
    signIn: authHooks.signIn,
    writeClipboard: (text) => clipboard.writeText(text),
    openExternal: (url) => shell.openExternal(url),
    mcpConfig: mcpConfigFor,
    installSkills: (repoPath) => ({ written: installClaudeSkills(repoPath, skills) }),
    connectClaudeCode: (repoPath, { role, allowSave, replace }) =>
      writeMcpServer(repoPath, claudeCodeServer(mcpConfigFor(repoPath), { role, allowSave }), { replace }),
    previewBoardRemoval: (repoPath) => previewBoardRemoval(repoPath),
    removeBoardFiles: (repoPath, confirmed) => removeBoardFiles(repoPath, confirmed),
    onUnexpectedError: (error) => {
      logger.error('Desktop command failed:', error)
    }
  })
  registerDesktopIpc(ipc, handlers)
  setInterval(() => pool.heartbeatAll(), HEARTBEAT_INTERVAL_MS)
  app.on('before-quit', () => pool.closeAll())
  startChats(ipc, { folders: registry, sessions, workspaces: pool, activity })
  return { chats: sessions }
}
