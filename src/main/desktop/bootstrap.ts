/**
 * Wires the desktop bridge to Electron: the tracked-folder and agent registries, one Workspace per
 * folder, native dialogs, clipboard, external links, the agent chats and their terminals, and the
 * `dm:*`, `agents:*`, `chats:*` and `terminals:*` IPC channels. All logic lives in the pure modules
 * beside this file, in `../agents` and in `../terminals`; this one is composition only, so it has no
 * unit tests of its own.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  MessageChannelMain,
  shell,
  type IpcMain,
  type OpenDialogOptions
} from 'electron'
import { join } from 'node:path'
import type { Db } from '../../core/db/database'
import { DomainError } from '../../core/errors'
import { resolveHomeDir } from '../../core/repo/storageMode'
import { openWorkspace, type Workspace } from '../../core/workspace'
import type { AgentDownloadProgress, BuiltInAgentKind, McpConfigView } from '../../shared/desktop/api'
import { createActivityBindings, type ActivityBindings } from '../agents/activityBindings'
import { createChatGrants } from '../agents/chatGrants'
import { createChatHandlers } from '../agents/chatHandlers'
import { createChatPush, registerChatIpc } from '../agents/chatIpc'
import { createChatRecords, type ChatRecords } from '../agents/chatRecords'
import { createChatStore, type ChatStore } from '../agents/chatStore'
import { listBoundThreads } from '../agents/boundThreads'
import { findBoundTerminal, type GrantBindingReads } from '../agents/grantBindings'
import { logger } from '../logger'
import { createLoginTerminals, type LoginTerminals } from '../terminals/loginTerminals'
import { createNodePtyHost, type PtyHost } from '../terminals/ptyHost'
import { createTerminalHandlers, registerTerminalIpc } from '../terminals/terminalHandlers'
import { createTerminalSessions, endingTerminals, type TerminalSessions, type TerminalSessionsDeps } from '../terminals/terminalSessions'
import { getAgentAuthStatus } from './agentAuth'
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
import { openAppDatabase } from './appDatabase'
import { createAgentRegistry, type AgentRegistry } from './agentRegistry'
import { importLegacyAgents } from './agentRegistryImport'
import { previewBoardRemoval, removeBoardFiles } from './boardRemovalFiles'
import { createFolderAgentDefaults } from './folderAgentDefaults'
import { createFolderRegistry, type FolderRegistry } from './folderRegistry'
import { createDesktopHandlers, firstPickedDirectory } from './handlers'
import {
  createCustomAgents,
  customAgentApproved,
  customAgentDialogOptions,
  customExecutableDialogOptions,
  type CustomAgentConfirmation,
  type CustomAgents
} from './customAgent'
import { registerDesktopIpc } from './ipc'
import { buildCliConfig, type CliLaunch } from './cliConfig'
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
function pickExecutable(kind: BuiltInAgentKind): Promise<string | null> {
  return showOpenDialog(agentDialogOptions(kind, process.platform))
}

/**
 * What running an agent's registered executable needs: the real runner and file check for this platform.
 * No comspec: every launch, check or chat start alike, runs the System32 cmd.exe (`planShimLaunch`).
 */
function agentRunDeps(): AgentProbeDeps {
  return {
    platform: process.platform,
    run: runProcess,
    inspect: inspectExecutable
  }
}

function probeExecutable(kind: BuiltInAgentKind, executablePath: string): ReturnType<typeof probeAgent> {
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

/** The only place a custom CLI's program is chosen: a native dialog in this process, never the renderer. */
function pickCustomExecutable(): Promise<string | null> {
  return showOpenDialog(customExecutableDialogOptions(process.platform))
}

/** The only place a custom CLI's command is approved: a native message box; only Run and save with the box ticked is a yes. */
function confirmCustomAgent(confirmation: CustomAgentConfirmation): Promise<boolean> {
  const options = customAgentDialogOptions(confirmation)
  const parent = BrowserWindow.getFocusedWindow()
  const shown = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
  return shown.then(customAgentApproved)
}

function createCustom(agents: AgentRegistry): CustomAgents {
  return createCustomAgents({
    agents,
    pickExecutable: pickCustomExecutable,
    confirm: confirmCustomAgent,
    launch: agentRunDeps()
  })
}

/** The MCP launch command for `repoPath`, for this build of the app (packaged or development). */
let dmHome: string | undefined

/**
 * The Dark Mechanicus home directory this machine uses. The headless MCP server resolves it the
 * same way, so both processes find the same database-only projects. Read on first use rather than
 * at module load: this module is imported before `app.whenReady()`, and every other path here is
 * read after it.
 */
function darkMechanicusHome(): string {
  dmHome ??= resolveHomeDir(process.env, app.getPath('home'))
  return dmHome
}

/**
 * How long a chat's grant lasts. Long enough that a working session is never interrupted, and it
 * is revoked the moment the session ends anyway; the expiry only matters if the app dies first.
 */
const CHAT_GRANT_MINUTES = 12 * 60

/** The `dm` invocation a chat may make, pinned to its folder. */
function cliConfigFor(repoPath: string): CliLaunch {
  return buildCliConfig({
    packaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    repoPath,
    dmHome: darkMechanicusHome()
  })
}

function mcpConfigFor(repoPath: string): McpConfigView {
  return buildMcpConfig({
    packaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    repoPath,
    dmHome: darkMechanicusHome()
  })
}

function openDesktopWorkspace(repoRoot: string): Workspace {
  return openWorkspace({
    repoRoot,
    role: 'desktop',
    label: 'Desktop',
    transport: 'desktop',
    pid: process.pid,
    homeDir: darkMechanicusHome(),
    serverInfo: { name: 'darkmechanicus-desktop', version: app.getVersion() }
  })
}

/**
 * What main keeps of the bridge: the chat sessions and chat terminals, which must be disposed before the
 * app exits, and `close`, which releases the open workspaces and then `app.sqlite` once they are.
 */
interface DesktopBridge {
  chats: { busy: () => boolean; dispose: () => Promise<void> }
  close: () => void
}

/** The desktop's own workspace for a tracked folder; the run commands of a chat never reach a folder that is not tracked. */
function desktopWorkspace(folders: Pick<FolderRegistry, 'resolve'>, workspaces: Pick<WorkspacePool, 'get'>, folder: string): Workspace {
  const tracked = folders.resolve(folder)
  if (tracked === null) {
    throw new DomainError('unauthorized', 'That folder is not tracked by Dark Mechanicus.')
  }
  return workspaces.get(tracked)
}

/** The agent chats: their records, and the terminals (one PTY per chat) over the same store and one set of grants. */
interface ChatProcesses {
  /** The chat records, with deleting a chat also killing its terminal. */
  chats: ChatRecords
  /** What the quit is held for: every chat terminal and every sign-in terminal. */
  quit: DesktopBridge['chats']
  /** The chat store, and the terminals, for the `terminals:*` channel. */
  store: ChatStore
  terminals: TerminalSessions
  /** The agents' sign-in terminals, for `agents:signIn`. */
  logins: LoginTerminals
}

/** What the chat terminals run over besides the store: the grants and runs of the chats, the tracked folders, the agents. */
interface TerminalDeps {
  grants: Pick<TerminalSessionsDeps, 'issueChatCli' | 'revokeChatGrant' | 'runs'>
  folders: TerminalSessionsDeps['folders']
  agents: Pick<AgentRegistry, 'get'>
}

/** The chat terminals and the sign-in terminals, over one PTY host loaded at the first start (an app where it cannot run still opens). */
function createTerminalProcesses(store: ChatStore, deps: TerminalDeps): Pick<ChatProcesses, 'terminals' | 'logins'> {
  let host: Promise<PtyHost> | undefined
  const base = { host: () => (host ??= createNodePtyHost()), platform: process.platform, env: process.env }
  const terminals = createTerminalSessions({
    ...base,
    store,
    agentFor: (id) => deps.agents.get(id),
    folders: deps.folders,
    checkAuth: (kind, executablePath) => getAgentAuthStatus(kind, executablePath, agentRunDeps()),
    cliFor: cliConfigFor,
    ...deps.grants,
    userData: app.getPath('userData'),
    onError: (error) => {
      logger.error('Chat terminal failed:', error)
    }
  })
  const logins = createLoginTerminals({
    ...base,
    home: app.getPath('home'),
    onError: (error) => {
      logger.error('Sign-in terminal failed:', error)
    }
  })
  return { terminals, logins }
}

/**
 * The agent chats (`userData/agents/chats`) with the connected agents, each run in its terminal. When an
 * orchestrator chat's agent turns out to be signed out, the run it orchestrates is paused with the reason
 * `signed_out` through the folder's own desktop workspace: the only session that may give that reason. The chat
 * terminals and the sign-in terminals load node-pty at the first start, so an app where it cannot run still opens.
 * Deleting a chat forgets the bindings old chats stored (`activity`).
 */
function createChatProcesses(
  folders: Pick<FolderRegistry, 'resolve'>,
  agents: Pick<AgentRegistry, 'get'>,
  workspaces: Pick<WorkspacePool, 'get'>,
  activity: ActivityBindings
): ChatProcesses {
  // One store for all: it keeps each folder's index in memory, so two would write over each other's records.
  const store = createChatStore({ root: join(app.getPath('userData'), 'agents', 'chats') })
  // Revoked through the workspace each grant was issued in, even after its folder moved.
  const grants = createChatGrants({
    workspaceFor: (folder) => desktopWorkspace(folders, workspaces, folder),
    cliFor: cliConfigFor,
    minutes: CHAT_GRANT_MINUTES,
    log: (line) => {
      logger.warn(line)
    }
  })
  const runs = {
    getRun: async (folder: string, runId: string) => desktopWorkspace(folders, workspaces, folder).getRun({ runId }),
    pauseRun: async (folder: string, input: { runId: string; reason: string }) => desktopWorkspace(folders, workspaces, folder).pauseRun(input)
  }
  const launchFolders = { trackedFolder: (path: string) => folders.resolve(path) }
  const { terminals, logins } = createTerminalProcesses(store, { grants: { ...grants, runs }, folders: launchFolders, agents })
  const quit = {
    busy: () => terminals.busy() || logins.busy(),
    dispose: async () => {
      await Promise.all([terminals.dispose(), logins.dispose()])
    }
  }
  const chats = endingTerminals(createChatRecords({ store, activity, agentFor: (id) => agents.get(id) }), terminals)
  return { chats, quit, store, terminals, logins }
}

/** The command layer's timelines through the desktop's own workspace, for finding the chat an attempt or a run is bound to by grant. */
function grantReads(workspaces: Pick<WorkspacePool, 'get'>): GrantBindingReads {
  return {
    attemptTimeline: async (folder, attemptId) => workspaces.get(folder).getAttemptTimeline({ attemptId }),
    runTimeline: async (folder, runId, sinceSeq) => workspaces.get(folder).getRunTimeline({ runId, sinceSeq })
  }
}

/** What the `chats:*` channels run over: the tracked folders, the connected agents, the chats and their terminals, the workspaces and the bindings old chats stored. */
interface ChatServices {
  folders: Pick<FolderRegistry, 'resolve'>
  agents: Pick<AgentRegistry, 'get'>
  chats: ChatRecords
  store: ChatStore
  terminals: TerminalSessions
  workspaces: Pick<WorkspacePool, 'get'>
  activity: ActivityBindings
}

/** Serves the `chats:*` channels over the chat records; Start run starts the orchestrator chat's terminal. */
function startChats(ipc: Pick<IpcMain, 'handle'>, services: ChatServices): void {
  const { folders, agents, chats, store, terminals, workspaces, activity } = services
  const handlers = createChatHandlers({
    registry: folders,
    agents,
    chats,
    terminals,
    // Every window hears of a chat created, renamed or deleted, so none keeps a stale list.
    push: createChatPush(() => BrowserWindow.getAllWindows()),
    boundThreads: (folder, target) => listBoundThreads(activity, folder, target),
    boundTerminal: (folder, target) => findBoundTerminal({ reads: grantReads(workspaces), store }, folder, target),
    // The same desktop commands the Start run button runs, through the folder's own workspace.
    runs: {
      getEpic: (folder, epicId) => workspaces.get(folder).getEpic({ epicId }),
      queueRun: (folder, epicId) => workspaces.get(folder).queueRun({ epicId })
    },
    // The transfer the Transfer to Linear button authorized, read through the folder's own workspace.
    transfers: {
      getEpic: (folder, epicId) => workspaces.get(folder).getEpic({ epicId }),
      getTransfer: (folder, epicId) => workspaces.get(folder).getTransfer({ epicId })
    },
    onUnexpectedError: (error) => {
      logger.error('Chat request failed:', error)
    }
  })
  registerChatIpc(ipc, handlers)
}

/** What `terminals:attach` and `agents:signIn` run over. */
interface TerminalServices {
  folders: Pick<FolderRegistry, 'resolve'>
  agents: Pick<AgentRegistry, 'get'>
  store: ChatStore
  terminals: TerminalSessions
  logins: LoginTerminals
}

/** Serves `terminals:attach` over the chat terminals and `agents:signIn` over the sign-in terminals, posting each running one's port to its frame. */
function startTerminals(ipc: Pick<IpcMain, 'handle'>, services: TerminalServices): void {
  const handlers = createTerminalHandlers({
    registry: services.folders,
    store: services.store,
    sessions: services.terminals,
    agents: services.agents,
    logins: services.logins,
    channel: () => {
      const { port1, port2 } = new MessageChannelMain()
      return { local: port1, remote: port2 }
    },
    onUnexpectedError: (error) => {
      logger.error('Terminal request failed:', error)
    }
  })
  registerTerminalIpc(ipc, handlers)
}

/** Heartbeats open workspaces; the returned close releases them first and then the app-wide database. */
function runLifecycle(pool: WorkspacePool, appDb: Db): () => void {
  setInterval(() => pool.heartbeatAll(), HEARTBEAT_INTERVAL_MS)
  return () => {
    pool.closeAll()
    appDb.close()
  }
}

/** Moves the legacy JSON agent list into the app database once, then opens the SQL-backed registry. */
function openAgentRegistry(appDb: Db): AgentRegistry {
  importLegacyAgents({
    db: appDb,
    file: join(app.getPath('userData'), 'agents.json'),
    log: (line) => {
      logger.warn(line)
    }
  })
  return createAgentRegistry({ db: appDb })
}

/**
 * Registers the `dm:*`, `agents:*`, `chats:*` and `terminals:*` IPC handlers on `ipc` (the sender-guarded
 * registrar from `guardIpc`) and the background heartbeat/shutdown for open workspaces.
 */
export function startDesktopBridge(skills: readonly SkillDefinition[], ipc: Pick<IpcMain, 'handle'>): DesktopBridge {
  const appDb = openAppDatabase(app.getPath('userData'))
  const registry = createFolderRegistry({
    file: join(app.getPath('userData'), 'folders.json'),
    homeDir: app.getPath('home'),
    dmHome: darkMechanicusHome()
  })
  const agents = openAgentRegistry(appDb)
  const installer = createInstaller(agents)
  const pool = createWorkspacePool(openDesktopWorkspace, (path, error) => {
    logger.error(`Workspace error for ${path}:`, error)
  })
  // Which threads of old chats acted on which runs and attempts, as they stored it next to the chats.
  const activity = createActivityBindings({ file: join(app.getPath('userData'), 'agents', 'activity-bindings.jsonl') })
  const { chats, quit, store, terminals, logins } = createChatProcesses(registry, agents, pool, activity)
  const handlers = createDesktopHandlers({
    registry,
    pool,
    agents,
    folderDefaults: createFolderAgentDefaults({ db: appDb }),
    pickDirectory,
    pickExecutable,
    probeAgent: probeExecutable,
    installAgent: (kind) => installer.download(kind),
    checkAuth: (agent) => getAgentAuthStatus(agent.kind, agent.executablePath, agentRunDeps()),
    customAgents: createCustom(agents),
    // Removing an agent kills its chats' terminals and its sign-in terminal.
    endAgentSessions: async (id) => {
      await Promise.all([terminals.endAgent(id), logins.endAgent(id)])
    },
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
  const close = runLifecycle(pool, appDb)
  startChats(ipc, { folders: registry, agents, chats, store, terminals, workspaces: pool, activity })
  startTerminals(ipc, { folders: registry, agents, store, terminals, logins })
  return { chats: quit, close }
}
