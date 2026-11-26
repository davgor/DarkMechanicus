/**
 * Wires the desktop bridge to Electron: the tracked-folder and agent registries, the Dark Mechanicus source
 * checkout and the cross-repository correction broker, one Workspace per folder, native dialogs, clipboard,
 * external links, the agent chats and their terminals, GitHub sign-in, and the `dm:*`, `sourceCheckout:*`,
 * `corrections:*CrossRepo`, `agents:*`, `chats:*`, `terminals:*`, `git:*` and `github:*` IPC channels. All logic
 * lives in the pure modules beside this file and in `../agents`, `../terminals`, `../git` and `../github`;
 * this one is composition only, so it has no unit tests of its own.
 */
import { createControlPipe, type ControlPipe } from '../naming/controlPipe'
import { createNamingDispatcher } from '../naming/namingCommands'
import { createDesktopToolingRecovery, type DesktopToolingRecovery } from '../agents/toolingRecoveryDesktop'
import { existsSync, realpathSync } from 'node:fs'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  MessageChannelMain,
  net,
  Notification,
  powerSaveBlocker,
  protocol,
  safeStorage,
  shell,
  type IpcMain,
  type OpenDialogOptions,
  type WebContents
} from 'electron'
import { dirname, join, resolve } from 'node:path'
import type { Db } from '../../core/db/database'
import { DomainError } from '../../core/errors'
import { nodeFs } from '../../core/repo/nodeFs'
import { resolveHomeDir } from '../../core/repo/storageMode'
import { startTelegram } from '../telegram'
import { boundForgeRoot, currentForgeTransfer } from '../../core/repo/forgeBinding'
import type { ChatRecord } from '../../shared/agents/chat'
import type { AgentDownloadProgress, BuiltInAgentKind, McpConfigView } from '../../shared/desktop/api'
import { isActiveRunState, isLeasedAttemptState } from '../../shared/domain/status'
import { createActivityBindings, type ActivityBindings } from '../agents/activityBindings'
import { createChatGrants, type ChatGrants } from '../agents/chatGrants'
import { createYoloDesktopRuntime } from '../../core/services/yoloFence'
import { createChatHandlers } from '../agents/chatHandlers'
import type { PlannerAgents } from '../agents/plannerStart'
import { createConversationDeliveries, type ConversationDeliveries } from '../agents/conversationDeliveries'
import { createAgentContextDelivery, resumeContextChat, type AgentContextDelivery, type BoardContextTransport } from '../agents/agentContextDelivery'
import { boardContextText } from '../../../resources/skitarii/extension/contextDelivery'
import type { ConversationReads } from '../agents/conversationTarget'
import { createAgentMailDesktop, type AgentMailDesktop } from '../agents/agentMailDesktop'
import { createChatMailPush, createChatPush, registerChatIpc, registerChatMailIpc, sendToWindows } from '../agents/chatIpc'
import { createChatRecords, type ChatRecords } from '../agents/chatRecords'
import { createChatMailboxes, type ChatMailboxes } from '../agents/chatMailboxes'
import { forgeReachFolders } from './forgeContext'
import { removeScratchFolder } from '../agents/scratchFolder'
import { createChatStore, nodeChatStoreFs, type ChatStore } from '../agents/chatStore'
import { listBoundThreads } from '../agents/boundThreads'
import { findBoundTerminal, type GrantBindingReads } from '../agents/grantBindings'
import { createCloneParentStore, createCloner, type Cloner } from '../git/clone'
import { createGitHandlers } from '../git/handlers'
import { sourceControlTarget } from '../git/target'
import { createProgressBroadcaster, registerGitIpc } from '../git/ipc'
import { createGitRunner, type GitRunner } from '../git/runner'
import { createLearningIntegrationLocks } from '../git/learningIntegration'
import { createOperationLocks, type OperationLocks } from '../git/operationLock'
import { createLearningApprovals, type LearningApprovalController } from '../kanban/approveLearningCard'
import { createLearningApprovalHandlers, registerLearningApprovalIpc } from './learningApprovalIpc'
import { createAccountStore } from '../github/accountStore'
import { createGithubClient, createSessionClient, type GithubClient } from '../github/client'
import { createGhCli, isExecutableFile, runGhProcess } from '../github/ghCli'
import { createGithubHandlers } from '../github/handlers'
import type { HttpFetch } from '../github/http'
import { createGithubBroadcaster, registerGithubIpc } from '../github/ipc'
import { createRepositoryList } from '../github/repositories'
import { createGithubSession, type GithubSession } from '../github/session'
import { logger } from '../logger'
import { createLoginTerminals, type LoginTerminals } from '../terminals/loginTerminals'
import { createKeepAwake } from '../terminals/keepAwake'
import { createNodePtyHost, type PtyHost } from '../terminals/ptyHost'
import { createTerminalHandlers, registerTerminalIpc } from '../terminals/terminalHandlers'
import { removeOmpFolder } from '../terminals/ompSession'
import { skitariiExtensionPath } from '../terminals/ompSkitariiExtension'
import { createTerminalSessions, type TerminalSessions, type TerminalSessionsDeps } from '../terminals/terminalSessions'
import { createAgentChatSessions, type AgentChatSessions, type AgentChatSessionsDeps } from '../agentChat/agentChatSessions'
import { createAgentChatHandlers, createAgentChatPush, registerAgentChatIpc } from '../agentChat/agentChatIpc'
import { endingAgentChats, nativeTerminalStopConfirmation, wireAgentChats, type AgentChatAttention, type AgentChatOwnerDeps, type AgentChatWiring, type ArbiterWiring } from '../agentChat/agentChatWiring'
import { restartMarkerHook, resumeAfterRestart } from '../agentChat/restartResume'
import { setBeforeInstall } from '../autoUpdate'
import { createWorktreeRoots } from '../magos/worktreeRoots'
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
import { createAppSettings, type AppSettings } from './appSettings'
import { createAgentRegistry, type AgentRegistry } from './agentRegistry'
import { importLegacyAgents } from './agentRegistryImport'
import { previewBoardRemoval, removeBoardFiles } from './boardRemovalFiles'
import { createCrossRepoCorrectionHandlers, registerCrossRepoCorrectionIpc } from './crossRepoCorrections'
import { createFolderAgentDefaults, type FolderAgentDefaults } from './folderAgentDefaults'
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
import { registerDesktopIpc, registerKnowledgeIpc, registerYoloIpc } from './ipc'
import { createYoloHandlers } from './yoloHandlers'
import { createKnowledgeHandlers } from './knowledgeHandlers'
import { createAttachmentLookup, registerAttachmentProtocol } from './attachmentProtocol'
import { buildCliConfig, type CliLaunch } from './cliConfig'
import { buildMcpConfig } from './mcpConfig'
import { claudeCodeServer } from './mcpJson'
import { refreshMcpServer, writeMcpServer } from './mcpJsonFile'
import { installClaudeSkills, type SkillDefinition } from './skillInstall'
import { createSourceCheckouts, type SourceCheckouts } from './sourceCheckout'
import { createSourceCheckoutHandlers, registerSourceCheckoutIpc } from './sourceCheckoutIpc'
import { createForgeRepositoryPublisher, publishForgeRepository } from './forgePublish'
import { forgeAgentSessions } from './forgeAgents'
import { cleanupForgeSource } from './forgeCleanup'
import { startForge } from './forgeService'
import { discoverGithubForgeSetup } from './forgeSetupGithub'
import { createWorkspacePool, type WorkspacePool } from './workspacePool'
import { openUtilityWorkspace } from './utilityWorkspace'
import { createSettingsHandlers, registerSettingsIpc } from './settingsIpc'
import { createNotifier, type NotificationEvent } from '../notify/notifier'
import { createNotifyHandlers, registerNotifyIpc } from '../notify/notifyIpc'
import type { ProjectWorkspace } from './workspaceClient'

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

const SOURCE_CHECKOUT_DIALOG: OpenDialogOptions = {
  title: 'Choose your Dark Mechanicus source checkout (a Git clone of Dark Mechanicus)',
  properties: ['openDirectory']
}

const KNOWLEDGE_DIALOG: OpenDialogOptions = {
  title: 'Choose the overall knowledge repository',
  properties: ['openDirectory']
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

async function confirmYolo(detail: string): Promise<boolean> {
  const parent = BrowserWindow.getFocusedWindow()
  if (!parent || parent.isDestroyed()) return false
  const decision = await dialog.showMessageBox(parent, { type: 'warning', title: 'Enable YOLO for this agent?', message: 'Allow this agent to act without further workflow review?', detail, buttons: ['Cancel', 'Enable YOLO'], defaultId: 0, cancelId: 0, noLink: true })
  return decision.response === 1
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

/** The only place a loosening change to the notification and approval settings is approved: a native message box. */
function confirmNotificationSettings(summary: string): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    title: 'Loosen approval settings?',
    message: 'Allow this change to the Notifications & approvals settings?',
    detail: summary,
    buttons: ['Cancel', 'Allow change'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
  const parent = BrowserWindow.getFocusedWindow()
  const shown = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
  return shown.then(({ response }) => response === 1)
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
 * How long a chat's grant lasts from its issue, and from each hourly renewal while its terminal runs
 * (`terminalSessions.ts`), so a chat that runs for days keeps its role. It is revoked the moment the
 * terminal ends anyway; the expiry only matters if the app dies first.
 */
const CHAT_GRANT_MINUTES = 12 * 60

/** The `dm` invocation a chat may make, pinned to its folder (to none for a project-less chat). */
function cliConfigFor(repoPath: string | null): CliLaunch {
  return buildCliConfig({
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

/** Points each tracked folder's `.mcp.json` entry at this build when the build that wrote it was removed. */
function refreshClaudeCodeEntries(registry: FolderRegistry): void {
  for (const folder of registry.list()) {
    if (folder.available && folder.storageMode === 'repo') {
      refreshMcpServer(folder.path, mcpConfigFor(folder.path), existsSync)
    }
  }
}

/** Main's GitHub session for its sync, clone and pull request code: the account, its token, and an API client bound to them. */
type GithubBridge = Pick<GithubSession, 'getAccount' | 'getToken'> & {
  /** A 401 through it signs the account out (if the rejected token is still the stored one) and returns `auth_required`. */
  client: GithubClient
}

/**
 * What main keeps of the bridge: the chat sessions and chat terminals, which must be disposed before the
 * app exits, `close`, which releases the open workspaces and then `app.sqlite` once they are, and the
 * GitHub session.
 */
interface DesktopBridge {
  chats: { busy: () => boolean; dispose: () => Promise<void> }
  close: () => Promise<void>
  github: GithubBridge
}

/** The desktop's own workspace for a tracked folder; the run commands of a chat never reach a folder that is not tracked. */
function desktopWorkspace(folders: Pick<FolderRegistry, 'resolve'>, workspaces: Pick<WorkspacePool, 'get' | 'background'>, folder: string, background = false): ProjectWorkspace {
  const tracked = folders.resolve(folder)
  if (tracked === null) {
    throw new DomainError('unauthorized', 'That folder is not tracked by Dark Mechanicus.')
  }
  return background ? workspaces.background(tracked) : workspaces.get(tracked)
}

/** The agent chats: their records, and the terminals (one PTY per chat) over the same store and one set of grants. */
interface ChatProcesses {
  /** The chat records, with deleting a chat also stopping its GUI process and killing its terminal. */
  chats: ChatRecords
  /** What the quit is held for: every chat terminal, every GUI chat process and every sign-in terminal. */
  quit: DesktopBridge['chats']
  /** The chat store, and the terminals, for the `terminals:*` channel. */
  store: ChatStore
  terminals: TerminalSessions
  /** The one GUI session manager, for the `agentChat:*` channels. */
  agentChats: AgentChatSessions
  /** The agents' sign-in terminals, for `agents:signIn`. */
  logins: LoginTerminals
  /** Untrack's first step (`DesktopHandlerDeps.releaseFolder`): the folder's terminals stopped, its chat mailboxes suspended. */
  releaseFolder: (folder: string, forget: () => void | Promise<void>, relatedFolders?: readonly string[]) => Promise<void>
  /** The person's side of the chats' mailboxes and its per-folder monitors (`chatMail:*`). */
  mail: AgentMailDesktop
  suspendChatMail(chat: ChatRecord): Promise<void>
  grants: ChatGrants
  deliveries: ConversationDeliveries
  contextDelivery: AgentContextDelivery
  resumeChat: (chat: ChatRecord) => Promise<string | null>
}

/** What the chat terminals run over besides the store: the grants and runs of the chats, the tracked folders, the agents. */
interface TerminalDeps {
  grants: Pick<TerminalSessionsDeps, 'issueChatCli' | 'issueReachCli' | 'revokeChatGrant' | 'renewChatGrant' | 'bindChatGrant' | 'onChatChanged' | 'runs'>
  folders: TerminalSessionsDeps['folders']
  /** What a project-less chat reaches: the tracked folders set up for Dark Mechanicus. */
  reachFolders: TerminalSessionsDeps['reachFolders']
  forgeResolverFolders: NonNullable<TerminalSessionsDeps['forgeResolverFolders']>
  agents: Pick<AgentRegistry, 'get'>
  beforeContextPaste: NonNullable<TerminalSessionsDeps['beforeContextPaste']>
  assertRecoveryLaunch: NonNullable<TerminalSessionsDeps['assertRecoveryLaunch']>
  assertForgeSetupLaunch: NonNullable<TerminalSessionsDeps['assertForgeSetupLaunch']>
  /** Refuses a terminal start while the GUI owns the chat (`wireAgentChats`). */
  agentChatLive: NonNullable<TerminalSessionsDeps['agentChatLive']>
}

/** The chat terminals and the sign-in terminals, over one PTY host loaded at the first start (an app where it cannot run still opens). */
function createTerminalProcesses(store: ChatStore, deps: TerminalDeps): Pick<ChatProcesses, 'terminals' | 'logins'> {
  let host: Promise<PtyHost> | undefined
  const base = { host: () => (host ??= createNodePtyHost()), platform: process.platform, env: process.env }
  // While a chat terminal runs the computer stays awake: an agent's job can run for days.
  const awake = createKeepAwake(powerSaveBlocker)
  const terminals = createTerminalSessions({
    ...base,
    store,
    keepAwake: () => awake.hold(),
    agentFor: (id) => deps.agents.get(id),
    folders: deps.folders,
    reachFolders: deps.reachFolders,
    forgeResolverFolders: deps.forgeResolverFolders,
    checkAuth: (kind, executablePath) => getAgentAuthStatus(kind, executablePath, agentRunDeps()),
    cliFor: cliConfigFor,
    ...deps.grants,
    beforeContextPaste: deps.beforeContextPaste,
    assertRecoveryLaunch: deps.assertRecoveryLaunch,
    assertForgeSetupLaunch: deps.assertForgeSetupLaunch,
    agentChatLive: deps.agentChatLive,
    userData: app.getPath('userData'),
    ompExtension: skitariiExtensionPath({ packaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath }),
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

function chatRunCommands(folders: Pick<FolderRegistry, 'resolve'>, workspaces: Pick<WorkspacePool, 'get' | 'background'>): TerminalSessionsDeps['runs'] {
  return {
    getRun: async (folder, runId) => desktopWorkspace(folders, workspaces, folder).getRun({ runId }),
    pauseRun: async (folder, input) => desktopWorkspace(folders, workspaces, folder).pauseRun(input)
  }
}

interface ChatProcessOptions {
  folders: Pick<FolderRegistry, 'resolve' | 'list'>
  agents: Pick<AgentRegistry, 'get'>
  workspaces: Pick<WorkspacePool, 'get' | 'background'>
  activity: ActivityBindings
  /** The main store's Notifications & approvals settings, read by the Magos arbiter at each prompt. */
  settings: Pick<AppSettings, 'notifications'>
  /** The OS notifier's `notify`: escalated prompts, questions and stalled Magos chats raise a notification. */
  notify: (event: NotificationEvent) => void
  sourceCheckouts: SourceCheckouts
  assertForgeSetupLaunch: NonNullable<TerminalSessionsDeps['assertForgeSetupLaunch']>
}
interface ChatQuitOptions {
  grants: ChatGrants
  yoloRuntime: ReturnType<typeof createYoloDesktopRuntime>
  ready: Promise<void>
  pipe(): ControlPipe | null
  /** The chat terminals and GUI chat processes together (`wireAgentChats`). */
  owners: Pick<ChatProcesses['quit'], 'busy' | 'dispose'>
  logins: ChatProcesses['logins']
}
function chatQuit({ grants, yoloRuntime, ready, pipe, owners, logins }: ChatQuitOptions): ChatProcesses['quit'] {
  return {
    busy: () => owners.busy() || logins.busy(),
    dispose: async () => {
      await Promise.all([
        grants.dispose(), yoloRuntime.dispose(), owners.dispose(), logins.dispose(),
        ready.catch(() => {}).then(() => pipe()?.close())
      ])
    }
  }
}

/**
 * The agent chats (`userData/agents/chats`) with the connected agents, each run in its terminal. When an
 * orchestrator chat's agent turns out to be signed out, the run it orchestrates is paused with the reason
 * `signed_out` through the folder's own desktop workspace: the only session that may give that reason. The chat
 * terminals and the sign-in terminals load node-pty at the first start, so an app where it cannot run still opens.
 * Deleting a chat forgets the bindings old chats stored (`activity`).
 */
function createChatProcesses({ folders, agents, workspaces, activity, settings, notify, sourceCheckouts, assertForgeSetupLaunch }: ChatProcessOptions): ChatProcesses {
  const yoloRuntime = createYoloDesktopRuntime(join(app.getPath('userData'), 'yolo-desktop-instance.json'))
  // One store for all: it keeps each folder's index in memory, so two would write over each other's records.
  const store = createChatStore({ root: join(app.getPath('userData'), 'agents', 'chats') })
  const { records, mailboxes } = createMailboxRecords(store, { folders, workspaces, agents, activity })
  const push = createChatPush(() => BrowserWindow.getAllWindows())
  let namingPipe: ControlPipe | null = null
  let namingReady: Promise<void>
  // Revoked through the workspace each grant was issued in, even after its folder moved.
  const grants = createChatGrants({
    recordWorldMailbox: (owner, member, chatId) => mailboxes.recordRoute(owner, member, chatId),
    workspaceFor: (folder) => desktopWorkspace(folders, workspaces, folder),
    cliFor: cliConfigFor,
    minutes: CHAT_GRANT_MINUTES,
    desktopAddress: () => namingPipe?.address,
    desktopReady: () => namingReady,
    desktopFence: yoloRuntime.fence,
    yoloReady: () => yoloRuntime.ready,
    log: (line) => {
      logger.warn(line)
    }
  })
  void yoloRuntime.ready.catch((error: unknown) => logger.error('YOLO desktop proof transport failed:', error))
  const reachFolders = (): string[] => folders.list().flatMap((folder) => (folder.initialized && folder.available ? [folder.path] : []))
  const forgeResolverFolders = (root: string): string[] => folders.list().flatMap(folder => folder.forgeParent === root && folder.available && folder.initialized ? [folder.path] : [])
  let recovery: DesktopToolingRecovery
  const { owners, terminals, logins, deliveries, contextDelivery, resumeChat, boardTransport } = createChatOwners(store, {
    grants: { ...grants, runs: chatRunCommands(folders, workspaces), onChatChanged: (ref) => push({ type: 'chats_changed', folder: ref.folder, chatId: ref.id }) },
    folders: { trackedFolder: (path) => folders.resolve(path) }, reachFolders, forgeResolverFolders, agents,
    assertRecoveryLaunch: chat => recovery.assertLaunch(chat), assertForgeSetupLaunch
  }, push, { claims: guiClaims(folders, workspaces), arbiter: arbiterWiring(folders, workspaces, activity, settings), attention: chatAttention(store, notify) })
  recovery = createDesktopToolingRecovery({
    userData: app.getPath('userData'), version: () => app.getVersion(),
    source: { requireAvailable: sourceCheckouts.requireRecoveryCheckout }, store, agents, terminals,
    workspace: folder => desktopWorkspace(folders, workspaces, folder), resolveFolder: folder => folders.resolve(folder),
    context: contextDelivery, deliveries, resume: resumeChat,
    onNoticeError: error => logger.error('Tooling repair notice failed:', error),
  })
  const naming = createNamingDispatcher({ store, push })
  namingReady = createControlPipe({ authorize: token => grants.authorizeNaming(token),
    dispatch: (operation, context) => operation.op === 'name_chat' ? naming(operation, context) : recovery.dispatch(operation, context)
  }).then(pipe => { namingPipe = pipe })
  // Observe startup failure immediately; each attempted chat launch still receives the real rejection.
  void namingReady.catch((error: unknown) => logger.error('Chat naming transport failed:', error))
  const quit = chatQuit({ grants, yoloRuntime, ready: namingReady, pipe: () => namingPipe, owners, logins })
  const chats = endingAgentChats(records, terminals, owners.agentChats)
  const mail = createChatMail({ folders, store, mailboxes, workspaces, contextDelivery, resumeChat, boardTransport, recovery })
  return { chats, quit, store, terminals, agentChats: owners.agentChats, logins, mail, grants, deliveries, contextDelivery, resumeChat,
    suspendChatMail: async chat => { await mailboxes.suspendChat(chat) }, releaseFolder: releasingFolders(terminals, mailboxes, store) }
}

/** What owns a chat's live process (`wireAgentChats`): the terminals with their context delivery, and the GUI manager. */
interface ChatOwners extends ContextTerminals {
  owners: AgentChatWiring<TerminalSessions>
}

/** The terminals first, with a lazy GUI liveness check, then the one GUI session manager over their ownership. */
function createChatOwners(
  store: ChatStore, options: Omit<TerminalDeps, 'beforeContextPaste' | 'agentChatLive'>, push: ReturnType<typeof createChatPush>,
  gui: { claims: GuiClaimDeps; arbiter: ArbiterWiring; attention: AgentChatAttention }
): ChatOwners {
  let context: ContextTerminals | undefined
  const owners = wireAgentChats({
    terminalsFactory: agentChatLive => {
      context = createContextTerminals(store, { ...options, agentChatLive }, push)
      return context.terminals
    },
    agentChatsFactory: owned => createGuiChats(store, { grants: options.grants, folders: options.folders, reachFolders: options.reachFolders, agents: options.agents }, owned, gui.claims),
    push,
    arbiter: gui.arbiter,
    attention: gui.attention
  })
  if (context === undefined) throw new Error('The chat terminals were not created.')
  return { ...context, owners }
}

/** Attention events of the Magos gate and the GUI chats go to the OS notifier, named after the stored chat. */
function chatAttention(store: ChatStore, notify: (event: NotificationEvent) => void): AgentChatAttention {
  return { notify, chat: ref => store.getChat(ref), onError: error => logger.error('Attention notification failed:', error) }
}

/**
 * The OS notifier over Electron's `Notification`, the app windows and main's notification settings, and the guarded
 * `notifications:raise` channel the renderer reports run events on.
 */
function startNotifications(
  ipc: Pick<IpcMain, 'handle'>, registry: Pick<FolderRegistry, 'resolve'>, pool: Pick<WorkspacePool, 'get'>, settings: Pick<AppSettings, 'notifications'>
): ReturnType<typeof createNotifier> {
  const notifier = createNotifier({
    Notification, windows: () => BrowserWindow.getAllWindows(), settings: () => settings.notifications(), push: sendToWindows,
    logger, now: () => Date.now()
  })
  registerNotifyIpc(ipc, createNotifyHandlers({
    registry, workspaces: pool, notify: event => notifier.notify(event),
    onUnexpectedError: (error) => {
      logger.error('Notification request failed:', error)
    }
  }))
  return notifier
}

/** How GUI chats verify a worker's claim token; the bindings and ticket-key lookup come with the Magos wiring. */
type GuiClaimDeps = Pick<AgentChatSessionsDeps, 'verifyAttemptClaim'>

/** The one GUI session manager over the same store, grants and agents as the terminals, and the terminals' ownership. */
function createGuiChats(
  store: ChatStore,
  deps: Pick<TerminalDeps, 'grants' | 'folders' | 'reachFolders' | 'agents'>,
  owned: AgentChatOwnerDeps,
  claims: GuiClaimDeps
): AgentChatSessions {
  const awake = createKeepAwake(powerSaveBlocker)
  return createAgentChatSessions({
    ...deps.grants,
    ...owned,
    ...claims,
    store,
    agentFor: (id) => deps.agents.get(id),
    folders: deps.folders,
    reachFolders: deps.reachFolders,
    checkAuth: (kind, executablePath) => getAgentAuthStatus(kind, executablePath, agentRunDeps()),
    cliFor: cliConfigFor,
    keepAwake: () => awake.hold(),
    userData: app.getPath('userData'),
    ompExtension: skitariiExtensionPath({ packaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath }),
    platform: process.platform,
    env: process.env,
    push: createAgentChatPush(() => BrowserWindow.getAllWindows())
  })
}

/**
 * Serves `agentChat:*` over the one GUI session manager. Only an explicit `agentChat:setSurface` from the app window
 * may stop a live terminal, after the native confirmation modal to that window; no other path passes one.
 */
function startAgentChats(ipc: Pick<IpcMain, 'handle'>, registry: Pick<FolderRegistry, 'resolve'>, sessions: AgentChatSessions): void {
  const confirmTerminalStop = nativeTerminalStopConfirmation<WebContents, BrowserWindow>({
    windowFor: (sender) => {
      const window = BrowserWindow.fromWebContents(sender)
      return window === null || window.isDestroyed() ? null : window
    },
    showMessageBox: (window, options) => dialog.showMessageBox(window, options)
  })
  const handlers = createAgentChatHandlers({
    registry, sessions, confirmTerminalStop,
    onUnexpectedError: (error) => {
      logger.error('Agent chat request failed:', error)
    }
  })
  registerAgentChatIpc(ipc, handlers, event => event.sender)
}

/** The chat terminals and sign-in terminals with the context delivery that serves board messages through them. */
interface ContextTerminals extends Pick<ChatProcesses, 'terminals' | 'logins' | 'deliveries' | 'contextDelivery' | 'resumeChat'> {
  boardTransport: BoardContextTransport
}

/** The same observer, ledger and same-chat transport serve board messages, peer monitoring and native input. */
function createContextTerminals(
  store: ChatStore, options: Omit<Parameters<typeof createTerminalProcesses>[1], 'beforeContextPaste'>,
  push: ReturnType<typeof createChatPush>
): ContextTerminals {
  const userData = app.getPath('userData')
  const deliveries = createConversationDeliveries({
    userData, onChanged: (folder, chatId) => push({ type: 'chats_changed', folder, chatId })
  })
  const contextDelivery = createAgentContextDelivery({
    userData, deliveries, agentKind: (chat) => options.agents.get(chat.agent)?.kind ?? 'custom'
  })
  const { terminals, logins } = createTerminalProcesses(store, {
    ...options, beforeContextPaste: (chat, messageId, content) => contextDelivery.reserveBoardInput(chat, messageId, content)
  })
  const resumeChat = (chat: ChatRecord): Promise<string | null> => resumeContextChat(terminals, chat)
  const boardTransport: BoardContextTransport = {
    resolveFolder: (folder) => options.folders.trackedFolder(folder),
    getChat: (ref) => store.getChat(ref),
    resume: resumeChat,
    paste: async (chat, message) => {
      const result = await terminals.paste(chat, boardContextText(message), message.id)
      return result.state === 'running' ? null : result.message
    }
  }
  return { terminals, logins, deliveries, contextDelivery, resumeChat, boardTransport }
}

/**
 * The chat records over `store` with their mailboxes, provisioned, bound, suspended and deleted as the person through
 * each folder's own desktop workspace; deleting an OMP chat removes its own folder, and a project-less chat its scratch folder.
 */
function createMailboxRecords(
  store: ChatStore,
  deps: { folders: Pick<FolderRegistry, 'resolve' | 'list'>; workspaces: Pick<WorkspacePool, 'get' | 'background'>; agents: Pick<AgentRegistry, 'get'>; activity: ActivityBindings }
): { records: ChatRecords; mailboxes: ChatMailboxes } {
  const userData = app.getPath('userData')
  const mailboxes = createChatMailboxes({
    workspaceFor: (folder, background) => desktopWorkspace(deps.folders, deps.workspaces, folder, background),
    membersFor: folder => forgeReachFolders(folder, deps.folders.list().filter(member => member.initialized && member.available).map(member => member.path)),
    store,
    ledger: { file: join(userData, 'agents', 'mailboxes.jsonl'), fs: nodeChatStoreFs },
    log: (line) => {
      logger.warn(line)
    }
  })
  const records = createChatRecords({
    store,
    activity: deps.activity,
    agentFor: (id) => deps.agents.get(id),
    removeOmpFolder: (id) => removeOmpFolder(userData, id),
    removeScratch: (id) => removeScratchFolder(userData, id),
    mailboxes,
    onError: (error) => {
      logger.error('Finishing a chat deletion failed:', error)
    }
  })
  return { records, mailboxes }
}

/** Untrack's first step: the folder's terminals stopped and starts refused, then its chat mailboxes suspended, then `forget`. */
function releasingFolders(terminals: TerminalSessions, mailboxes: ChatMailboxes, store: ChatStore): ChatProcesses['releaseFolder'] {
  return (folder, forget, relatedFolders = []) =>
    terminals.releaseFolder(folder, async () => {
      for (const path of [folder, ...relatedFolders]) await mailboxes.suspendFolder(path, store.listChats(path))
      await forget()
    }, relatedFolders)
}

/** The desktop's own workspaces, one per tracked folder, opened on first use; an error in one is logged with its folder. */
function openDesktopPool(): WorkspacePool {
  const home = darkMechanicusHome()
  return createWorkspacePool({
    open: generation => openUtilityWorkspace(generation, home, app.getVersion()),
    canonical: path => boundForgeRoot(nodeFs, home, realpathSync.native(path)),
    authority: currentForgeTransfer,
    onError: (path, error) => logger.error('Workspace error for ' + path, error),
    slowLog: logger
  })
}

/** GUI chats bind their threads to attempts whose claim token the folder's own project verifies, read-only. */
function guiClaims(folders: Pick<FolderRegistry, 'resolve'>, workspaces: Pick<WorkspacePool, 'get' | 'background'>): GuiClaimDeps {
  return {
    // The token stays in main and the project's utility process; it is never logged.
    verifyAttemptClaim: (folder, token) => desktopWorkspace(folders, workspaces, folder).call('claimedAttempt', token)
  }
}

/**
 * The Magos arbiter over the main settings and each tracked folder's own desktop workspace: verified thread bindings in
 * `activity`, the folder's registered worktrees as allowed roots, and fresh working folders under
 * `<userData>/agents/arbiter`. Its attention events go to the OS notifier through `wireAgentChats`.
 */
function arbiterWiring(
  folders: Pick<FolderRegistry, 'resolve'>, workspaces: Pick<WorkspacePool, 'get' | 'background'>, activity: ActivityBindings,
  settings: Pick<AppSettings, 'notifications'>
): ArbiterWiring {
  const worktrees = createWorktreeRoots()
  return {
    settings: () => settings.notifications(),
    arbiterReads: folder => desktopWorkspace(folders, workspaces, folder),
    bindings: activity,
    allowedRoots: folder => worktrees.rootsOf(folder),
    platform: process.platform,
    env: process.env,
    arbiterRoot: join(app.getPath('userData'), 'agents', 'arbiter')
  }
}

/** The command layer's timelines through the desktop's own workspace, for finding the chat an attempt or a run is bound to by grant. */
function grantReads(workspaces: Pick<WorkspacePool, 'get' | 'background'>): GrantBindingReads {
  return {
    attemptTimeline: async (folder, attemptId) => workspaces.get(folder).getAttemptTimeline({ attemptId }),
    runTimeline: async (folder, runId, sinceSeq) => workspaces.get(folder).getRunTimeline({ runId, sinceSeq })
  }
}

/** The command-layer execution state used by board-conversation routing. */
function conversationReads(workspaces: Pick<WorkspacePool, 'get' | 'background'>): ConversationReads {
  return {
    openAttemptId: async (folder, epicId, ticketId) => {
      const ticket = await workspaces.get(folder).getTicket({ epicId, ticketId, view: 'saved' })
      return ticket.attempts.find((attempt) => !attempt.superseded && isLeasedAttemptState(attempt.state))?.id ?? null
    },
    activeRunId: async (folder, epicId) => {
      const workspace = workspaces.get(folder)
      const summary = (await workspace.getEpic({ epicId })).run
      if (summary === null || !isActiveRunState(summary.state)) return null
      const run = await workspace.getRun({ runId: summary.id })
      return run !== null && isActiveRunState(run.state) ? run.id : null
    }
  }
}

/** What the `chats:*` channels run over: the tracked folders, the connected agents, the chats and their terminals, the workspaces and the bindings old chats stored. */
interface ChatServices {
  folders: Pick<FolderRegistry, 'resolve' | 'list'>
  agents: Pick<AgentRegistry, 'get' | 'list'>
  chats: ChatRecords
  store: ChatStore
  terminals: TerminalSessions
  /** The one GUI session manager `createChatProcesses` wired; never a second one. */
  agentChats: AgentChatSessions
  workspaces: Pick<WorkspacePool, 'get' | 'background'>
  activity: ActivityBindings
  mail: AgentMailDesktop
  folderDefaults: Pick<FolderAgentDefaults, 'get'>
  deliveries: ConversationDeliveries
  contextDelivery: AgentContextDelivery
  resumeChat: (chat: ChatRecord) => Promise<string | null>
}

/** The connected agents with their sign-in state, for Start planner; a custom CLI has no sign-in check, so pickChatAgent treats it as not signed in. */
function plannerAgents(agents: Pick<AgentRegistry, 'list'>): PlannerAgents {
  return {
    list: () => agents.list(),
    checkAuth: async (agent) => agent.kind === 'custom'
      ? { state: 'unchecked', reason: 'A custom CLI has no sign-in check.' }
      : getAgentAuthStatus(agent.kind, agent.executablePath, agentRunDeps())
  }
}

/** Serves the `chats:*` and `chatMail:*` channels over the chat records; Start run starts the orchestrator chat's terminal. */
function startChats(ipc: Pick<IpcMain, 'handle'>, services: ChatServices): void {
  const { folders, agents, chats, store, terminals, agentChats, workspaces, activity, folderDefaults, deliveries, contextDelivery, resumeChat } = services
  const reads = conversationReads(workspaces)
  const handlers = createChatHandlers({
    registry: folders,
    agents,
    chats,
    terminals,
    agentChats,
    plannerAgents: plannerAgents(agents),
    // Every window hears of a chat created, renamed or deleted, so none keeps a stale list.
    push: createChatPush(() => BrowserWindow.getAllWindows()),
    boundThreads: (folder, target) => listBoundThreads(activity, folder, target),
    boundTerminal: (folder, target) => findBoundTerminal({ reads: grantReads(workspaces), store }, folder, target),
    conversation: {
      workspace: (folder) => workspaces.get(folder),
      reads,
      deliveries,
      contextDelivery,
      resume: resumeChat,
      defaultAgent: (folder) => folderDefaults.get(folder)
    },
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
    // The same Play and Kick back commands as the board, run as the person through the folder's own workspace.
    kanban: {
      play: (folder, cardId) => workspaces.get(folder).playKanbanCard({ cardId }),
      kickBack: (folder, input) => workspaces.get(folder).kickBackKanbanCard(input),
      branch: async (folder) => (await workspaces.get(folder).getStorageStatus()).branch.current
    },
    onUnexpectedError: (error) => {
      logger.error('Chat request failed:', error)
    }
  })
  registerChatIpc(ipc, handlers)
  registerChatMailIpc(ipc, services.mail.handlers)
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
function runLifecycle(pool: WorkspacePool, appDb: Db): () => Promise<void> {
  const timer = setInterval(() => pool.heartbeatAll(), HEARTBEAT_INTERVAL_MS)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await pool.closeAll()
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

/** Clones into the folder kept in `userData/clone.json`, chosen only with the native dialog, and tracks each finished clone. */
function startClones(forge: Pick<ReturnType<typeof startForge>, 'openProject' | 'openWorld'>, folders: Pick<FolderRegistry, 'track'>, runner: GitRunner, github: GithubBridge): Cloner {
  return createCloner({
    runner,
    session: github,
    parents: createCloneParentStore({
      file: join(app.getPath('userData'), 'clone.json'),
      pickDirectory: () => showOpenDialog(CLONE_PARENT_DIALOG)
    }),
    registry: folders, openProject: forge.openProject, openWorld: forge.openWorld,
    onProgress: createProgressBroadcaster(() => BrowserWindow.getAllWindows())
  })
}

/**
 * Serves the `git:*` channels over the real git runner, for the tracked folders only, and clones into the folder
 * chosen with the native dialog. Network operations authenticate with the GitHub session (in main: the token never
 * reaches a window) and broadcast their progress; pull requests are read through the session's API client. Returns
 * the runner and the per-repository operation locks, shared with learning approval (DM-956).
 */
function startGit(forge: Pick<ReturnType<typeof startForge>, 'openProject' | 'openWorld'>, ipc: Pick<IpcMain, 'handle'>, folders: Pick<FolderRegistry, 'resolve' | 'track' | 'list'>, github: GithubBridge): SharedGit {
  const runner = createGitRunner()
  const operations = createOperationLocks(runner)
  registerGitIpc(
    ipc,
    createGitHandlers({
      registry: folders,
      clones: startClones(forge, folders, runner, github),
      runner,
      operations,
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
  return { runner, operations }
}

/** The one Git runner and Source control operation locks main's Git work shares. */
interface SharedGit {
  runner: GitRunner
  operations: OperationLocks
}

/**
 * DM-956: the `dm:approveLearningCard` channel over the shared runner and locks, through each tracked folder's own
 * desktop workspace. At startup each available, set-up folder recovers the approvals this machine left in progress.
 */
function startLearningApprovals(ipc: Pick<IpcMain, 'handle'>, registry: Pick<FolderRegistry, 'resolve' | 'list'>, pool: WorkspacePool, git: SharedGit): LearningApprovalController {
  const approvals = createLearningApprovals({
    resolve: (folder) => registry.resolve(folder),
    workspace: (folder) => pool.get(folder),
    git: { ...git, cards: createLearningIntegrationLocks() }
  })
  registerLearningApprovalIpc(ipc, createLearningApprovalHandlers(approvals))
  for (const folder of registry.list()) {
    if (!folder.initialized || !folder.available) continue
    approvals.recover(folder.path).catch((error: unknown) => logger.error('Learning approval recovery failed for ' + folder.path, error))
  }
  return approvals
}

/** GitHub sign-in first, then the git channels that use its session; returns the session for main's other code. */
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
/** Serves stored images to the window (`dm-attachment:`), each read through its folder's own workspace. */
function startAttachmentProtocol(registry: FolderRegistry, pool: WorkspacePool): void {
  registerAttachmentProtocol(
    protocol,
    createAttachmentLookup({
      pathForKey: (key) => registry.pathForKey(key),
      read: (path, id) => pool.get(path).call('attachment', id)
    })
  )
}

/**
 * The installed app's own folders: the one holding the executable and `resources/`, and on macOS the `.app` bundle.
 * None in development, where the app runs from a source checkout that may well be the one chosen.
 */
function installedAppDirs(): string[] {
  if (!app.isPackaged) {
    return []
  }
  const bundle = process.platform === 'darwin' ? resolve(process.resourcesPath, '..', '..') : dirname(process.resourcesPath)
  return [dirname(process.execPath), bundle]
}

/**
 * Serves the `sourceCheckout:*` channels over `userData/source-checkout.json` (the checkout is chosen with the native
 * dialog) and returns the store, whose `requireAvailable` gates every write to the checkout.
 */
function startSourceCheckout(ipc: Pick<IpcMain, 'handle'>, registry: FolderRegistry): SourceCheckouts {
  const checkouts = createSourceCheckouts({
    file: join(app.getPath('userData'), 'source-checkout.json'),
    homeDir: app.getPath('home'),
    dmHome: darkMechanicusHome(),
    registry,
    installedAppDirs
  })
  registerSourceCheckoutIpc(
    ipc,
    createSourceCheckoutHandlers({ checkouts, registry,
      pickDirectory: (defaultPath) => showOpenDialog({ ...SOURCE_CHECKOUT_DIALOG, defaultPath }) })
  )
  return checkouts
}

/** Serves the `corrections:*CrossRepo` channels: corrective work a tracked folder's retro asks of the chosen checkout. */
function startCrossRepoCorrections(ipc: Pick<IpcMain, 'handle'>, registry: FolderRegistry, pool: WorkspacePool, checkouts: SourceCheckouts): void {
  const handlers = createCrossRepoCorrectionHandlers({
    registry,
    pool,
    checkouts,
    onUnexpectedError: (error) => {
      logger.error('Cross-repository correction failed:', error)
    }
  })
  registerCrossRepoCorrectionIpc(ipc, handlers)
}

/**
 * The person's inbox and seen cursor, plus automatic same-chat context delivery, through each folder's held desktop
 * workspace. The unconditional monitor also resumes durable pending board messages after a restart.
 */
function createChatMail(services: {
  folders: Pick<FolderRegistry, 'resolve' | 'list'>
  store: ChatStore
  mailboxes: ChatMailboxes
  workspaces: Pick<WorkspacePool, 'get' | 'background'>
  contextDelivery: AgentContextDelivery
  resumeChat: (chat: ChatRecord) => Promise<string | null>
  boardTransport: BoardContextTransport
  recovery: { poll(folder: string): Promise<void> }
}): AgentMailDesktop {
  return createAgentMailDesktop({
    registry: services.folders,
    store: services.store,
    routedChats: async (member, background) => {
      const tracked = services.folders.list()
      const parent = tracked.find(folder => folder.path === member)?.forgeParent
      const world = tracked.find(folder => folder.path === parent && folder.available && (folder.forgeWorld || folder.forgeIssue))
      if (world === undefined) return []
      const routes = await Promise.all(services.store.listChats(world.path).map(async chat =>
        (await services.mailboxes.routes(chat, member, background)).map(route => ({ ...chat, endpointId: route.endpointId }))))
      return routes.flat()
    },
    folders: () => services.folders.list().flatMap((folder) => folder.initialized && folder.available ? [folder.path] : []),
    workspaceFor: (folder, background) => desktopWorkspace(services.folders, services.workspaces, folder, background),
    delivery: { hasMessage: (chat, message) => services.contextDelivery.hasMessage(chat, message), resume: services.resumeChat },
    board: { poll: async (folder) => {
      await services.contextDelivery.reconcileBoard(folder, services.boardTransport)
      await services.recovery.poll(folder)
    } },
    push: createChatMailPush(() => BrowserWindow.getAllWindows()),
    onUnexpectedError: (error) => {
      logger.error('Chat mail request failed:', error)
    }
  })
}

/** The bridge's quit and close with the mail monitors stopped first: before the chats are disposed and before any workspace closes. */
function stoppingMailFirst(mail: AgentMailDesktop, chats: DesktopBridge['chats'], close: () => Promise<void>): Pick<DesktopBridge, 'chats' | 'close'> {
  return {
    chats: {
      busy: chats.busy,
      dispose: () => {
        mail.dispose()
        return chats.dispose()
      }
    },
    close: async () => {
      mail.dispose()
      await close()
    }
  }
}

/**
 * DM-956: the quit also waits for learning approvals: they keep it busy, and disposing aborts every approval at once
 * and waits for each workflow and every Git process it started to exit, alongside the chats.
 */
function drainingApprovals(chats: DesktopBridge['chats'], approvals: LearningApprovalController): DesktopBridge['chats'] {
  return {
    busy: () => chats.busy() || approvals.busy(),
    dispose: async () => {
      await Promise.all([chats.dispose(), approvals.dispose()])
    }
  }
}

/** Serves the `knowledge:*` channels: layer status for a tracked folder, and the overall repository chosen only with the native picker. */
function startKnowledge(ipc: Pick<IpcMain, 'handle'>, registry: Pick<FolderRegistry, 'resolve' | 'storageMode'>): void {
  registerKnowledgeIpc(
    ipc,
    createKnowledgeHandlers({
      registry,
      dmHome: darkMechanicusHome(),
      fs: nodeFs,
      gitRunner: createGitRunner(),
      pickKnowledgeRepository: () => showOpenDialog(KNOWLEDGE_DIALOG)
    })
  )
}

/** The tracked folders, kept in `userData/folders.json`. */
function openFolderRegistry(): FolderRegistry {
  return createFolderRegistry({
    file: join(app.getPath('userData'), 'folders.json'),
    homeDir: app.getPath('home'),
    dmHome: darkMechanicusHome()
  })
}

/**
 * Registers the `dm:*`, `sourceCheckout:*`, `corrections:*CrossRepo`, `agents:*`, `knowledge:*`, `chats:*`, `chatMail:*`,
 * `terminals:*`, `git:*` and `github:*` IPC handlers on `ipc` (the sender-guarded registrar from `guardIpc`) and the
 * background heartbeat/shutdown for open workspaces.
 */
function telegramLifecycle(ipc: Pick<IpcMain, 'handle'>, registry: FolderRegistry, pool: WorkspacePool, appDb: Db) {
  const stopTelegram = startTelegram(ipc,
    () => registry.list().filter(folder => folder.initialized && folder.available).map(folder => folder.path),
    folder => desktopWorkspace(registry, pool, folder), darkMechanicusHome())
  const closeStores = runLifecycle(pool, appDb)
  return async () => { stopTelegram(); await closeStores() }
}

type ForgeBridgeOptions = Pick<ChatProcesses, 'chats' | 'store' | 'terminals' | 'contextDelivery' | 'suspendChatMail'> & {
  registry: FolderRegistry
  pool: WorkspacePool
  github: GithubBridge
  skills: readonly SkillDefinition[]
  agents: AgentRegistry
  folderDefaults: ReturnType<typeof createFolderAgentDefaults>
}

function startForgeBridge(ipc: Pick<IpcMain, 'handle'>, options: ForgeBridgeOptions) {
  const { registry, pool, github, skills } = options
  return startForge(ipc, {
    registry, pool, session: github, home: darkMechanicusHome(), pickDirectory, cleanup: source => cleanupForgeSource(source, skills),
    onManifestRetry: code => logger.info(`Forge World manifest rename refused (${code}); trying again.`),
    onFoldersChanged: () => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('forge:foldersChanged')
    },
    publish: name => publishForgeRepository(name, github.getToken(), net.fetch.bind(net)),
    provisioning: {
      journal: join(app.getPath('userData'), 'forge', 'provisioning.json'),
      publisher: createForgeRepositoryPublisher(github, githubFetch),
      discover: repository => discoverGithubForgeSetup(repository, github, (url, request) => net.fetch(url, request))
    },
    setup: forgeSetupChatOptions(options),
    ...forgeAgentSessions({
      ...options,
      checkAuth: async id => {
        const agent = options.agents.get(id)
        return agent === null || agent.kind === 'custom' || agent.needsReview ? 'unchecked' :
          (await getAgentAuthStatus(agent.kind, agent.executablePath, agentRunDeps())).state
      },
      beforeArchive: options.suspendChatMail
    })
  })
}

function forgeSetupChatOptions(
  { registry, pool, agents, folderDefaults, store, chats, terminals, contextDelivery }: ForgeBridgeOptions
): NonNullable<Parameters<typeof startForge>[1]['setup']> {
  const push = createChatPush(() => BrowserWindow.getAllWindows())
  const directory = join(app.getPath('userData'), 'forge')
  return {
    file: join(directory, 'onboarding.json'),
    scratch: join(directory, 'onboarding'),
    preferred: target => folderDefaults.get(target.member) ?? folderDefaults.get(target.root),
    agent: id => {
      const configured = agents.get(id)
      return configured === null || configured.needsReview ? null :
        JSON.stringify([configured.id, configured.kind, configured.executablePath, configured.version, configured.args])
    },
    getStandards: async member => (await desktopWorkspace(registry, pool, member).getProject()).deliveryStandards,
    getChat: ref => store.getChat(ref),
    findChat: (member, tag) => store.listChats(member).find(chat =>
      chat.forgeSetup?.intentId === tag.intentId && chat.forgeSetup.stepId === tag.stepId && chat.forgeSetup.mode === tag.mode),
    createChat: async request => chats.createChat(request),
    start: (chat, authorization) => terminals.start(chat, { kickoff: chat.firstPrompt!, forgeSetupAuthorization: authorization }),
    hasInput: (chat, text, cwd) => contextDelivery.hasInput({ ...chat, folder: cwd }, text),
    running: chatId => terminals.isRunning(chatId),
    announce: chat => push({ type: 'chats_changed', folder: chat.folder, chatId: chat.id })
  }
}

type BridgeHandlerOptions = Pick<ForgeBridgeOptions, 'registry' | 'pool' | 'agents' | 'folderDefaults' | 'terminals' | 'skills'> &
  Pick<ChatProcesses, 'releaseFolder' | 'mail' | 'logins'> & {
    forge: ReturnType<typeof startForgeBridge>
    installer: ReturnType<typeof createInstaller>
  }

function bridgeHandlers(options: BridgeHandlerOptions) {
  const { registry, pool, releaseFolder, mail, agents, folderDefaults, forge, installer, terminals, logins, skills } = options
  const folderRunner = createGitRunner()
  return createDesktopHandlers({
    registry,
    pool,
    releaseFolder,
    stopMailMonitor: (folder) => mail.stopFolder(folder),
    agents,
    folderDefaults,
    pickDirectory: async (mode) => {
      const source = await pickDirectory()
      if (!source) return null
      return mode === 'forge-world' ? forge.openWorld(source) : forge.openProject(source)
    },
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
    folderTarget: tracked => sourceControlTarget(tracked, folderRunner, registry.list()),
    openPath: path => shell.openPath(path),
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
}

/**
 * Restart resume: Restart now lists each live run's Magos chat in `userData/agents/restart-resume.json`, beside the
 * chat store; this start consumes the marker and, after an update, resumes each one that still qualifies on its session.
 */
function startRestartResume({ registry, pool, store, terminals, agentChats }: {
  registry: Pick<FolderRegistry, 'resolve' | 'list'>; pool: Pick<WorkspacePool, 'get' | 'background'>
  store: ChatStore; terminals: Pick<TerminalSessions, 'isLive'>; agentChats: AgentChatSessions
}): void {
  const file = join(app.getPath('userData'), 'agents', 'restart-resume.json')
  setBeforeInstall(restartMarkerHook({
    file, version: () => app.getVersion(), now: () => new Date(), folders: () => registry.list().map(folder => folder.path), store,
    live: ref => agentChats.isLive(ref) || terminals.isLive(ref), log: logger
  }))
  const runs = chatRunCommands(registry, pool)
  void resumeAfterRestart({
    file, version: app.getVersion(), now: Date.now(), trackedFolder: folder => registry.resolve(folder), store,
    runActive: async (folder, runId) => {
      const run = await runs.getRun(folder, runId)
      return run !== null && isActiveRunState(run.state)
    },
    sessions: agentChats, log: logger
  })
}

export function startDesktopBridge(skills: readonly SkillDefinition[], ipc: Pick<IpcMain, 'handle'>): DesktopBridge {
  const appDb = openAppDatabase(app.getPath('userData'))
  const registry = openFolderRegistry()
  const agents = openAgentRegistry(appDb)
  const installer = createInstaller(agents)
  const pool = openDesktopPool()
  const folderDefaults = createFolderAgentDefaults({ db: appDb })
  // Which threads of old chats acted on which runs and attempts, as they stored it next to the chats.
  const activity = createActivityBindings({ file: join(app.getPath('userData'), 'agents', 'activity-bindings.jsonl') })
  const sourceCheckouts = startSourceCheckout(ipc, registry)
  const settings = createAppSettings({ db: appDb, confirm: confirmNotificationSettings, logger })
  const notifier = startNotifications(ipc, registry, pool, settings)
  let verifySetup: TerminalSessionsDeps['assertForgeSetupLaunch']
  const { chats, quit, store, terminals, agentChats, logins, mail, grants, deliveries, contextDelivery, resumeChat, releaseFolder, suspendChatMail } = createChatProcesses({
    folders: registry, agents, workspaces: pool, activity, settings, notify: event => notifier.notify(event), sourceCheckouts,
    assertForgeSetupLaunch: (chat, authorization) => {
      if (verifySetup === undefined) throw new Error('Forge setup launch authority is unavailable.')
      return verifySetup(chat, authorization)
    }
  })
  const github = startGithub(ipc)
  const forge = startForgeBridge(ipc, { registry, pool, github, skills, store, chats, terminals, agents, folderDefaults, contextDelivery, suspendChatMail })
  verifySetup = forge.assertSetupLaunch
  const approvals = startLearningApprovals(ipc, registry, pool, startGit(forge, ipc, registry, github))
  const releasing: ChatProcesses['releaseFolder'] = (folder, forget, related = []) =>
    releaseFolder(folder, async () => { await approvals.release([folder, ...related]); await forget() }, related)
  const handlers = bridgeHandlers({ registry, pool, releaseFolder: releasing, mail, agents, folderDefaults, forge, installer, terminals, logins, skills })
  registerDesktopIpc(ipc, handlers)
  registerSettingsIpc(ipc, createSettingsHandlers({
    settings,
    onUnexpectedError: (error) => {
      logger.error('Settings request failed:', error)
    }
  }))
  registerYoloIpc(ipc, createYoloHandlers({ registry, grants, confirm: confirmYolo }))
  startCrossRepoCorrections(ipc, registry, pool, sourceCheckouts)
  startKnowledge(ipc, registry)
  startAttachmentProtocol(registry, pool)
  refreshClaudeCodeEntries(registry)
  const close = telegramLifecycle(ipc, registry, pool, appDb)
  startChats(ipc, { folders: registry, agents, chats, store, terminals, agentChats, workspaces: pool, activity, mail, folderDefaults, deliveries, contextDelivery, resumeChat })
  startTerminals(ipc, { folders: registry, agents, store, terminals, logins })
  startAgentChats(ipc, registry, agentChats)
  startRestartResume({ registry, pool, store, terminals, agentChats })
  const stores = async (): Promise<void> => { notifier.dispose(); await approvals.dispose(); await forge.stop(); await close() }
  return { ...stoppingMailFirst(mail, drainingApprovals(quit, approvals), stores), github }
}
