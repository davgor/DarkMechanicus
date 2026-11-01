/**
 * Wires the desktop bridge to Electron: the tracked-folder and agent registries, one Workspace per
 * folder, native dialogs, clipboard, external links, the agent chat sessions, GitHub sign-in, and the
 * `dm:*`, `agents:*`, `chats:*`, `git:*` and `github:*` IPC channels. All logic lives in the pure modules
 * beside this file and in `../agents`, `../git` and `../github`; this one is composition only, so it has
 * no unit tests of its own.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  net,
  safeStorage,
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
import { CHAT_ADAPTERS } from '../agents/adapterRegistry'
import { nodeTransport } from '../agents/adapters/acpProcess'
import { startClaudeProbe } from '../agents/adapters/claude'
import { startCodexProbe } from '../agents/adapters/codex'
import { createChatGrants } from '../agents/chatGrants'
import { createChatHandlers } from '../agents/chatHandlers'
import { createChatPush, registerChatIpc } from '../agents/chatIpc'
import { createChatStore } from '../agents/chatStore'
import { createSessionManager, type SessionManager } from '../agents/sessionManager'
import { acpExchange, createHandshakeFolders, runHandshake, type HandshakeOutcome } from '../agents/protocolHandshake'
import type { AgentLaunchSpec } from '../agents/launchSpec'
import { listBoundThreads } from '../agents/boundThreads'
import { listThreadBindings, type BindingReads } from '../agents/threadBindings'
import { trackChatSignIn } from '../agents/signInHooks'
import { createCloneParentStore, createCloner, type Cloner } from '../git/clone'
import { createGitHandlers } from '../git/handlers'
import { createProgressBroadcaster, registerGitIpc } from '../git/ipc'
import { createGitRunner, type GitRunner } from '../git/runner'
import { createAccountStore } from '../github/accountStore'
import { createGithubClient, createSessionClient, type GithubClient } from '../github/client'
import { createGhCli, isExecutableFile, runGhProcess } from '../github/ghCli'
import { createGithubHandlers } from '../github/handlers'
import type { HttpFetch } from '../github/http'
import { createGithubBroadcaster, registerGithubIpc } from '../github/ipc'
import { createRepositoryList } from '../github/repositories'
import { createGithubSession, type GithubSession } from '../github/session'
import { logger } from '../logger'
import { getAgentAuthStatus, signInAgent, type AgentAuthHooks } from './agentAuth'
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

const CLONE_PARENT_DIALOG: OpenDialogOptions = {
  title: 'Choose the folder to clone repositories into',
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

/** A custom CLI's protocol handshake, on real processes, in a fresh temp folder. */
function handshakeCustomAgent(spec: AgentLaunchSpec): Promise<HandshakeOutcome> {
  const launch = agentRunDeps()
  return runHandshake(spec, {
    ...createHandshakeFolders(),
    exchanges: {
      acp: acpExchange({ ...launch, transport: nodeTransport, clientVersion: app.getVersion() }),
      codex: (custom, folder) => startCodexProbe(custom, folder),
      claude: (custom, folder) => startClaudeProbe(custom, folder)
    }
  })
}

function createCustom(agents: AgentRegistry): CustomAgents {
  return createCustomAgents({
    agents,
    pickExecutable: pickCustomExecutable,
    confirm: confirmCustomAgent,
    handshake: handshakeCustomAgent,
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

/** Main's GitHub session for its sync, clone and pull request code: the account, its token, and an API client bound to them. */
type GithubBridge = Pick<GithubSession, 'getAccount' | 'getToken'> & {
  /** A 401 through it signs the account out (if the rejected token is still the stored one) and returns `auth_required`. */
  client: GithubClient
}

/**
 * What main keeps of the bridge: the chat sessions, which must be disposed before the app exits,
 * `close`, which releases the open workspaces and then `app.sqlite` once they are, and the GitHub session.
 */
interface DesktopBridge {
  chats: Pick<SessionManager, 'liveCount' | 'disposeAll'>
  close: () => void
  github: GithubBridge
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
  agents: Pick<AgentRegistry, 'get'>,
  workspaces: Pick<WorkspacePool, 'get'>,
  activity: ActivityBindings
): SessionManager {
  return createSessionManager({
    store: createChatStore({ root: join(app.getPath('userData'), 'agents', 'chats') }),
    activity,
    adapters: CHAT_ADAPTERS,
    agentFor: (id) => agents.get(id),
    folders: { trackedFolder: (path) => folders.resolve(path) },
    // Revoked through the workspace each grant was issued in, even after its folder moved.
    ...createChatGrants({
      workspaceFor: (folder) => desktopWorkspace(folders, workspaces, folder),
      cliFor: cliConfigFor,
      minutes: CHAT_GRANT_MINUTES,
      log: (line) => {
        logger.warn(line)
      }
    }),
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

/** What the `chats:*` channels run over: the tracked folders, the connected agents, the chat sessions, the workspaces and the thread bindings. */
interface ChatServices {
  folders: Pick<FolderRegistry, 'resolve'>
  agents: Pick<AgentRegistry, 'get'>
  sessions: SessionManager
  workspaces: Pick<WorkspacePool, 'get'>
  activity: ActivityBindings
}

/** Serves the `chats:*` channels over the chat sessions. */
function startChats(ipc: Pick<IpcMain, 'handle'>, services: ChatServices): void {
  const { folders, agents, sessions, workspaces, activity } = services
  const handlers = createChatHandlers({
    registry: folders,
    agents,
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

/** The status the app shows is the CLI's own, corrected by what chats found out (an expired login). */
function chatAwareAuthHooks(sessions: SessionManager): AgentAuthHooks {
  return trackChatSignIn(
    {
      checkAuth: (agent) => getAgentAuthStatus(agent.kind, agent.executablePath, agentRunDeps()),
      signIn: (agent) => signInAgent(agent.kind, agent.executablePath, { ...agentRunDeps(), launch: launchTerminal })
    },
    sessions
  )
}

/** Clones into the folder kept in `userData/clone.json`, chosen only with the native dialog, and tracks each finished clone. */
function startClones(folders: Pick<FolderRegistry, 'track'>, runner: GitRunner, github: GithubBridge): Cloner {
  return createCloner({
    runner,
    session: github,
    parents: createCloneParentStore({
      file: join(app.getPath('userData'), 'clone.json'),
      pickDirectory: () => showOpenDialog(CLONE_PARENT_DIALOG)
    }),
    registry: folders,
    onProgress: createProgressBroadcaster(() => BrowserWindow.getAllWindows())
  })
}

/**
 * Serves the `git:*` channels over the real git runner, for the tracked folders only, and clones into the folder
 * chosen with the native dialog. Network operations authenticate with the GitHub session (in main: the token never
 * reaches a window) and broadcast their progress; pull requests are read through the session's API client.
 */
function startGit(ipc: Pick<IpcMain, 'handle'>, folders: Pick<FolderRegistry, 'resolve' | 'track'>, github: GithubBridge): void {
  const runner = createGitRunner()
  registerGitIpc(
    ipc,
    createGitHandlers({
      registry: folders,
      clones: startClones(folders, runner, github),
      runner,
      trashItem: (path) => shell.trashItem(path),
      openPath: (path) => shell.openPath(path),
      session: { getAccount: github.getAccount, getToken: github.getToken },
      client: github.client,
      onProgress: createProgressBroadcaster(() => BrowserWindow.getAllWindows()),
      onUnexpectedError: (error) => {
        logger.error('Git request failed:', error)
      }
    })
  )
}

/** GitHub sign-in first, then the git channels that use its session; returns the session for main's other code. */
function startSourceControl(ipc: Pick<IpcMain, 'handle'>, folders: Pick<FolderRegistry, 'resolve' | 'track'>): GithubBridge {
  const github = startGithub(ipc)
  startGit(ipc, folders, github)
  return github
}

/** GitHub calls go through Chromium's network stack, which follows the system proxy settings. */
const githubFetch: HttpFetch = (url, request) => net.fetch(url, request)

/**
 * Serves the `github:*` channels: sign-in with this computer's GitHub CLI login, the account kept in
 * `userData/github-account.json` with its token encrypted by `safeStorage`, and the account's repositories.
 * Returns the main-side GitHub session.
 */
function startGithub(ipc: Pick<IpcMain, 'handle'>): GithubBridge {
  const broadcast = createGithubBroadcaster(() => BrowserWindow.getAllWindows())
  const crypto = {
    // On Linux without a keyring, safeStorage "encrypts" with a fixed password (`basic_text`): that is plain text in disguise.
    isAvailable: () =>
      safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'),
    encrypt: (text: string) => safeStorage.encryptString(text),
    decrypt: (data: Buffer) => safeStorage.decryptString(data)
  }
  const store = createAccountStore({ file: join(app.getPath('userData'), 'github-account.json'), crypto })
  const session = createGithubSession({ store, onAccountChanged: broadcast.accountChanged })
  // gh is looked up on every sign-in, so one installed while the app runs is found.
  const gh = createGhCli({ run: runGhProcess, env: process.env, platform: process.platform, exists: isExecutableFile })
  const client = createSessionClient(session, { fetch: githubFetch, appVersion: app.getVersion() })
  const repositories = createRepositoryList({ client, session })
  const handlers = createGithubHandlers({
    session,
    readGhToken: (signal) => gh.readGhToken(signal),
    // A fresh token is not stored yet, so a 401 here has no account to sign out.
    fetchUser: (token) => createGithubClient({ fetch: githubFetch, getToken: () => token, appVersion: app.getVersion(), onUnauthorized: () => undefined }).getUser(),
    onUnexpectedError: (error) => {
      logger.error('GitHub request failed:', error)
    },
    listRepositories: (refresh) => repositories.list(refresh)
  })
  registerGithubIpc(ipc, handlers)
  return { getAccount: session.getAccount, getToken: session.getToken, client }
}

/**
 * Registers the `dm:*`, `agents:*`, `chats:*`, `git:*` and `github:*` IPC handlers on `ipc` (the
 * sender-guarded registrar from `guardIpc`) and the background heartbeat/shutdown for open workspaces.
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
  // Which chat threads act on which runs and attempts, next to the chats; main code looks them up here.
  const activity = createActivityBindings({ file: join(app.getPath('userData'), 'agents', 'activity-bindings.jsonl') })
  const sessions = createSessions(registry, agents, pool, activity)
  const authHooks = chatAwareAuthHooks(sessions)
  const handlers = createDesktopHandlers({
    registry,
    pool,
    agents,
    folderDefaults: createFolderAgentDefaults({ db: appDb }),
    pickDirectory,
    pickExecutable,
    probeAgent: probeExecutable,
    installAgent: (kind) => installer.download(kind),
    checkAuth: authHooks.checkAuth,
    signIn: authHooks.signIn,
    customAgents: createCustom(agents),
    endAgentSessions: (id) => sessions.endAgentSessions(id),
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
  startChats(ipc, { folders: registry, agents, sessions, workspaces: pool, activity })
  return { chats: sessions, close, github: startSourceControl(ipc, registry) }
}
