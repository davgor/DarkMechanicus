import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentProps, ComponentType, MutableRefObject } from 'react'
import type { ChatRecord } from '../../shared/agents/chat'
import type { AgentId, TrackedFolderView } from '../../shared/desktop/api'
import { folderIdentity } from './app/folderList'
import { epicLandingFor, threadLandingFor } from './app/landing'
import { findFolder } from './app/selection'
import type { Selection } from './app/selection'
import { listFor } from './app/useEpicLists'
import { browserScheduler } from './app/scheduler'
import type { Scheduler } from './app/scheduler'
import { LoadingView, UnavailableView, WelcomeView } from './app/MainViews'
import { useLatest } from './app/useLatest'
import { ToastProvider } from './app/toasts'
import { useShell } from './app/useShell'
import type { ShellModel } from './app/useShell'
import { AddAgentPane } from './agents/AddAgentPane'
import { AgentPage } from './agents/AgentPage'
import { agentName } from './agents/agentText'
import { createLiveTerminals, LiveTerminalsContext } from './agents/liveTerminals'
import { newChatAgent } from './agents/NewChatFields'
import { FirstPromptDialog } from './agents/ChatDialogs'
import { SignInContext, type SignInRequest } from './agents/signInContext'
import { SignInView } from './agents/SignInView'
import { chatsFor } from './agents/useChats'
import { AgentMailContext } from './agents/useAgentMail'
import { TerminalPane } from './agents/TerminalPane'
import type { TerminalKit } from './agents/terminalView'
import { xtermKit } from './agents/xtermKit'
import { CheckForUpdatesButton } from './autoUpdate/CheckForUpdatesButton'
import { UpdateBanner, useAppUpdate } from './autoUpdate/UpdateBanner'
import { EpicWorkspace } from './epic/EpicWorkspace'
import { createViewMemory, useViewMemory, ViewMemoryContext } from './epic/viewMemory'
import type { EpicWorkspaceProps } from './epic/EpicWorkspace'
import type { OrchestrationHost } from './epic/orchestration'
import { CloneDialog } from './clone/CloneDialog'
import { DeliveryStandards } from './folder/DeliveryStandards'
import { ForgeOpen } from './folder/ForgeOpen'
import { ProjectSetupPanel } from './forge/ProjectSetupPanel'
import { ProvisionDialog, type ForgeProvisionAttempt } from './forge/ProvisionDialog'
import { TicketSource } from './folder/TicketSource'
import { FolderPage } from './folder/FolderPage'
import { GithubAccountProvider } from './github/GithubAccount'
import { FolderHome } from './home/FolderHome'
import { KanbanBoard } from './kanban/KanbanBoard'
import { MetricsDashboard } from './metrics/MetricsDashboard'
import { OnboardingView } from './onboarding/OnboardingView'
import { SourceControlView } from './source/SourceControlView'
import { useSourceTarget, type SourceTargetModel } from './source/useSourceTarget'
import type { FolderTab } from './app/folderTabs'
import { Sidebar } from './sidebar/Sidebar'
import { SidebarFooter } from './sidebar/SidebarFooter'
import { UntrackDialog } from './sidebar/UntrackDialog'

type EpicView = ComponentType<EpicWorkspaceProps>

interface AppProps {
  /** Timers for polling and toast dismissal. Tests inject a manual one. */
  scheduler?: Scheduler
  /** The epic view. Injectable so shell tests do not depend on its implementation. */
  EpicView?: EpicView
  /** The chats' terminal emulator: xterm, or a fake in tests (jsdom has no canvas). */
  terminalKit?: TerminalKit
}

interface PaneProps {
  shell: ShellModel
  scheduler: Scheduler
  EpicView: EpicView
  terminalKit: TerminalKit
  onRequestUntrack(folder: TrackedFolderView): void
  onClone(): void
  onProvision(world: TrackedFolderView): void
}

interface EpicPaneProps {
  shell: ShellModel
  EpicView: EpicView
  folder: TrackedFolderView
  epicId: string
}

/** What the epic view needs to start a run with an agent: the connected agents, this folder's chats, and where its links go. */
function orchestrationFor(shell: ShellModel, folder: TrackedFolderView): OrchestrationHost {
  const { actions } = shell
  return {
    agents: shell.agents.agents,
    statuses: shell.agents.statuses,
    chats: chatsFor(shell.chats.lists, folder.path).chats,
    onChatsChanged: () => shell.chats.reload(folder.path),
    onAddAgent: actions.openAddAgent,
    onAgentStatus: shell.agents.recordStatus,
    onOpenChat: (chatId, threadId) => (threadId === undefined ? actions.selectChat(folder.path, chatId) : actions.openThread(folder.path, chatId, threadId))
  }
}

/** The epic view with callbacks whose identity only changes with the folder, not on every render. */
function EpicPane({ shell, EpicView, folder, epicId }: EpicPaneProps): JSX.Element {
  const actions = useLatest(shell.actions)
  const onChanged = useCallback(() => actions.current.changed(folder.path), [actions, folder.path])
  const onOpenEpic = useCallback(
    (id: string) => actions.current.selectEpic(folder.path, id),
    [actions, folder.path]
  )
  const onOpenFolderEpic = useCallback((path: string, id: string) => actions.current.selectEpic(path, id), [actions])
  const onFolderChanged = useCallback((path: string) => actions.current.changed(path), [actions])
  const onDeleted = useCallback(() => {
    actions.current.changed(folder.path)
    actions.current.selectFolder(folder.path)
  }, [actions, folder.path])
  const onLanded = useCallback(() => actions.current.landed(), [actions])
  return (
    <EpicView
      key={JSON.stringify([folderIdentity(folder), epicId])}
      folder={folder}
      epicId={epicId}
      refreshToken={shell.epicToken(folder.path, epicId)}
      onChanged={onChanged}
      onOpenEpic={onOpenEpic}
      onOpenFolderEpic={onOpenFolderEpic}
      onFolderChanged={onFolderChanged}
      onDeleted={onDeleted}
      landing={epicLandingFor(shell.landing, epicId)}
      onLanded={onLanded}
      orchestration={orchestrationFor(shell, folder)}
    />
  )
}

interface ChatPaneProps {
  shell: ShellModel
  /** The chat's tracked folder; null for a project-less chat. */
  folder: string | null
  chat: ChatRecord
  scheduler: Scheduler
  terminalKit: TerminalKit
}

/**
 * An open chat: its terminal. A link that asked for one of its threads (a transcript view's) has opened the chat,
 * which is all a terminal can show of it, so the request is taken at once rather than left for a later view.
 */
function ChatPane({ shell, folder, chat, scheduler, terminalKit }: ChatPaneProps): JSX.Element {
  const actions = useLatest(shell.actions)
  const landing = threadLandingFor(shell.landing, chat.id) !== null
  useEffect(() => {
    if (landing) actions.current.landed()
  }, [actions, landing])
  return (
    <TerminalPane
      folder={folder}
      chat={chat}
      agentName={agentName(chat.agent, shell.agents.agents)}
      kit={terminalKit}
      scheduler={scheduler}
      onAgentStatus={(status) => shell.agents.recordStatus(chat.agent, status)}
      peers={folder === null ? undefined : chatsFor(shell.chats.lists, folder).chats}
      onOpenChat={folder === null ? undefined : (chatId) => shell.actions.selectChat(folder, chatId)}
    />
  )
}

/** The Epics tab: the folder home for an initialized folder, onboarding for one that is not. */
function EpicsPanel({ shell, folder }: { shell: ShellModel; folder: TrackedFolderView }): JSX.Element {
  const { actions } = shell
  if (!folder.initialized) {
    return (
      <OnboardingView
        folder={folder}
        busy={shell.busy.initialize}
        onInitialize={(options) => void actions.initialize(folder, options)}
        onChooseDifferent={() => void actions.track()}
      />
    )
  }
  return (
    <FolderHome
      key={folder.path}
      folder={folder}
      agents={shell.agents.agents}
      list={listFor(shell.lists, folder.path)}
      status={shell.status}
      busy={shell.busy}
      onOpenEpic={(id) => actions.selectEpic(folder.path, id)}
      onCreateEpic={(input) => actions.createEpic(folder, input)}
      onFlush={() => void actions.flush()}
      onReconcile={() => void actions.reconcile()}
      onResolveConflict={(epicId, keep) => actions.resolveEpicConflict(folder, epicId, keep)}
      onImportBoard={() => actions.importBoard(folder)}
    />
  )
}

/** An open folder: either one of its epics, or the folder page with its Source control and Epics tabs. */
function FolderPane({ shell, scheduler, EpicView, onProvision }: PaneProps): JSX.Element | null {
  const { view } = shell
  const sourceTarget = useSourceTarget(view.kind === 'folder' ? view.folder : null, scheduler)
  if (view.kind === 'epic') {
    return <EpicPane shell={shell} EpicView={EpicView} folder={view.folder} epicId={view.epicId} />
  }
  if (view.kind !== 'folder') {
    return null
  }
  const { folder, tab } = view
  const launchStandardsChat = async (project: TrackedFolderView, prompt: string) => {
    const defaultId = await window.dm.folderDefaultAgent(project.path)
    const agent = newChatAgent(defaultId, shell.agents.agents, shell.agents.statuses)
    if (agent === null) {
      shell.actions.openAddAgent()
      return
    }
    const chat = await shell.actions.createChat(project, { agent, model: null, role: 'planner', allowSave: true, firstPrompt: prompt })
    if (chat === null) throw new Error('Could not open the project delivery standards chat.')
  }
  return (
    <FolderPage key={folder.path} folder={folder} sourceTarget={sourceTarget} tab={tab} onTab={(next) => shell.setFolderTab(folder.path, next)}>
      <FolderContents shell={shell} folder={folder} tab={tab} scheduler={scheduler} sourceTarget={sourceTarget}
        launch={launchStandardsChat} onProvision={onProvision} />
    </FolderPage>
  )
}

interface FolderContentsProps {
  shell: ShellModel
  folder: TrackedFolderView
  tab: FolderTab
  scheduler: Scheduler
  sourceTarget: SourceTargetModel
  launch(project: TrackedFolderView, prompt: string): Promise<void>
  onProvision(world: TrackedFolderView): void
}

async function openForgeOnboarding(shell: ShellModel, member: string, chatId: string): Promise<void> {
  await shell.chats.reload(member)
  shell.actions.selectChat(member, chatId)
}

function ForgeProjectSource({ shell, folder, scheduler, sourceTarget }: FolderContentsProps): JSX.Element {
  const api = window.dm.forgeSetup
  const source = <SourceControlView folder={folder} scheduler={scheduler} target={sourceTarget} />
  if (api === undefined) return source
  const status = sourceTarget.state
  const checkout = status.status === 'ready' && status.value.kind === 'available' ? status.value.path : null
  return <div className="forge-member-source">
    <ProjectSetupPanel key={folderIdentity(folder)} api={api} member={folder.path} checkout={checkout} scheduler={scheduler}
      onOpenChat={chatId => openForgeOnboarding(shell, folder.path, chatId)} />
    {source}
  </div>
}

function FolderContents(props: FolderContentsProps): JSX.Element {
  const { shell, folder, tab, scheduler } = props
  if (folder.forgeParent && tab === 'source') return <ForgeProjectSource {...props} />
  const api = window.dm.forgeSetup
  const prepare = api === undefined ? undefined : async (project: TrackedFolderView) => {
    const status = await api.prepare(project.path)
    if (status.state !== 'opened' || status.chatId === null) {
      throw new Error(status.message ?? 'Check Environment setup for onboarding progress.')
    }
    await openForgeOnboarding(shell, project.path, status.chatId)
  }
  const contents = <>
    <DeliveryStandards key={folder.path} folder={folder} folders={shell.folders} launch={props.launch} onPrepare={prepare} compact={tab !== 'standards'} />
    <FolderTabContent {...props} />
  </>
  return folder.forgeParent ? <ForgeOpen identity={folderIdentity(folder)} root={folder.forgeParent} member={folder.path} scheduler={scheduler}>{contents}</ForgeOpen> : contents
}

function FolderTabContent({ shell, folder, tab, scheduler, sourceTarget, onProvision }: FolderContentsProps): JSX.Element | null {
  if (tab === 'standards') return null
  if (tab === 'source') return <SourceControlView folder={folder} scheduler={scheduler} target={sourceTarget} />
  if (tab === 'tickets' || (folder.forgeWorld && tab === 'epics')) return <TicketSource
    key={folder.path} folder={folder} folders={shell.folders} status={shell.status} agents={shell.agents.agents}
    initialize={mode => shell.actions.initialize(folder, { mode, writeMcpConfig: false, importBoard: false })}
    open={async path => { await shell.reloadFolders(); shell.actions.selectFolder(path) }} onCreateCode={() => onProvision(folder)} />
  return <EpicsPanel shell={shell} folder={folder} />
}

function MainPane(props: PaneProps): JSX.Element | null {
  const view = props.shell.view
  if ((view.kind === 'epic' || view.kind === 'kanban' || view.kind === 'metrics') && view.folder.forgeParent) {
    return <ForgeOpen identity={folderIdentity(view.folder)} root={view.folder.forgeParent} member={view.folder.path} scheduler={props.scheduler} fullHeight><MainContent {...props} /></ForgeOpen>
  }
  return <MainContent {...props} />
}

function KanbanPane({ folder, shell }: { folder: TrackedFolderView; shell: ShellModel }): JSX.Element {
  return <KanbanBoard folder={folder} refreshToken={shell.kanbanToken(folder.path)} host={orchestrationFor(shell, folder)}
    selectedCardId={shell.selection.kanbanCardId ?? null} onOpenCard={id => shell.actions.selectKanban(folder.path, id)}
    onCloseCard={() => shell.actions.selectKanban(folder.path)} onChanged={() => shell.refreshKanban(folder.path)} />
}

function MainContent(props: PaneProps): JSX.Element | null {
  const { shell } = props
  const { view, actions } = shell
  switch (view.kind) {
    case 'loading':
      return <LoadingView what={view.what} />
    case 'welcome':
      return <WelcomeView onTrack={() => void actions.track()} onClone={props.onClone} />
    case 'add-agent':
      return <AddAgentPane agents={shell.agents} />
    case 'agent':
      return <AgentPage key={view.agent.id} agent={view.agent} agents={shell.agents} />
    case 'chat':
      return <ChatPane key={view.chat.id} shell={shell} folder={view.folder.path} chat={view.chat} scheduler={props.scheduler} terminalKit={props.terminalKit} />
    case 'projectless-chat':
      return <ChatPane key={view.chat.id} shell={shell} folder={null} chat={view.chat} scheduler={props.scheduler} terminalKit={props.terminalKit} />
    case 'kanban':
      return <KanbanPane key={folderIdentity(view.folder)} folder={view.folder} shell={shell} />
    case 'metrics':
      return (
        <MetricsDashboard
          key={view.folder.path}
          folder={view.folder}
          onOpenEpic={(epicId) => actions.openEpicScorecard(view.folder.path, epicId)}
          onOpenTicket={(link) => actions.openTicketScorecard(view.folder.path, link)}
        />
      )
    case 'unavailable':
      return <UnavailableView folder={view.folder} onStopTracking={props.onRequestUntrack} />
    default:
      return <FolderPane {...props} />
  }
}

function ShellFooter({ shell }: { shell: ShellModel }): JSX.Element {
  const { view } = shell
  const onFolder = view.kind === 'folder' || view.kind === 'epic' || view.kind === 'chat' || view.kind === 'kanban' || view.kind === 'metrics'
  const folder = onFolder ? view.folder : null
  return (
    <SidebarFooter
      status={shell.status}
      folderReady={folder?.initialized === true}
      busy={shell.busy}
      metricsOpen={view.kind === 'metrics'}
      onOpenMetrics={() => {
        if (folder !== null) shell.actions.selectMetrics(folder.path)
      }}
      onFlush={() => void shell.actions.flush()}
      onReconcile={() => void shell.actions.reconcile()}
    >
      <div className="footer-actions">
        <CheckForUpdatesButton />
      </div>
    </SidebarFooter>
  )
}

/**
 * Select the folder's agent before asking for a first prompt; with no connected agent, open setup.
 * Rapid clicks while the default is loading share one request and do not create a chat.
 */
async function startNewChat(shell: ShellModel, folder: TrackedFolderView, starting: Set<string>, onReady: (agent: string) => void): Promise<void> {
  if (starting.has(folder.path)) return
  starting.add(folder.path)
  try {
    // An untracked folder or any other failure reads as no default, as in `useFolderDefaultAgent`.
    const defaultId = await window.dm.folderDefaultAgent(folder.path).catch(() => null)
    const agent = newChatAgent(defaultId, shell.agents.agents, shell.agents.statuses)
    if (agent === null) {
      shell.actions.openAddAgent()
      return
    }
    onReady(agent)
  } finally {
    starting.delete(folder.path)
  }
}

/** The clone dialog; a finished clone opens the new folder on its Source control tab. */
function CloneHost({ shell, onClose, mode }: { shell: ShellModel; onClose(): void; mode?: 'forge-world' }): JSX.Element {
  return (
    <CloneDialog
      mode={mode}
      onClose={onClose}
      onCloned={(folder) => {
        onClose()
        shell.setFolderTab(folder.path, 'source')
        void shell.actions.cloned(folder)
      }}
    />
  )
}

/** What the sidebar needs for the folders' chats. */
function sidebarChats(shell: ShellModel, onNew: (path: string) => void): ComponentProps<typeof Sidebar>['chats'] {
  return {
    lists: shell.chats.lists,
    onNew,
    onOpen: shell.actions.selectChat,
    onRename: shell.chats.rename,
    onDelete: shell.chats.remove
  }
}

interface SignInViewState {
  /** The sign-in shown in `app-main`, or null. */
  request: SignInRequest | null
  open(request: SignInRequest): void
  close(): void
}

/**
 * The sign-in view Sign in opens: shown over the screen it was pressed on, and gone (its login stopped) with Back or
 * as soon as the person goes to another screen.
 */
function useSignInView(selection: Selection): SignInViewState {
  const screen = JSON.stringify(selection)
  const [opened, setOpened] = useState<{ request: SignInRequest; screen: string } | null>(null)
  if (opened !== null && opened.screen !== screen) {
    setOpened(null)
  }
  const open = useCallback((request: SignInRequest) => setOpened({ request, screen }), [screen])
  const close = useCallback(() => setOpened(null), [])
  return { request: opened?.screen === screen ? opened.request : null, open, close }
}

interface ShellSidebarProps {
  shell: ShellModel
  version: string
  /** The new chat's folder, as the sidebar's + names it (null for a path no longer tracked). */
  onNewChat(folder: TrackedFolderView | null): void
  /** Summon pressed on an agent's row: ask for the first prompt of a project-less chat with it. */
  onSummon(agent: AgentId): void
  /** Opens the clone dialog. */
  onClone(mode?: 'forge-world'): void
  onCreateForgeWorld?(): void
  onRequestUntrack(folder: TrackedFolderView): void
}

/** The sidebar, wired to the shell: folders and their epics and chats, the Agents list, and the footer. */
function ShellSidebar({ shell, version, onNewChat, onSummon, onClone, onCreateForgeWorld, onRequestUntrack }: ShellSidebarProps): JSX.Element {
  const { actions } = shell
  return (
    <Sidebar
      version={version}
      folders={shell.folders}
      lists={shell.lists}
      selection={shell.selection}
      agents={shell.agents.agents}
      agentStatuses={shell.agents.statuses}
      expansion={shell.expansion}
      sections={shell.sections}
      setSection={shell.setSection}
      chats={sidebarChats(shell, (path) => onNewChat(findFolder(shell.folders, path)))}
      agentChats={{ list: shell.allChats, onOpen: actions.openChat, onRename: shell.chats.rename, onDelete: shell.chats.remove, onSummon }}
      footer={<ShellFooter shell={shell} />}
      onTrack={mode => void actions.track(mode)}
      onClone={onClone}
      onCreateForgeWorld={onCreateForgeWorld}
      onAddAgent={actions.openAddAgent}
      onSelectAgent={actions.openAgent}
      onAgentStatus={shell.agents.recordStatus}
      onSelectFolder={actions.selectFolder}
      onSelectEpic={actions.selectEpic}
      kanbanCounts={shell.kanbanCounts}
      onSelectKanban={actions.selectKanban}
      onRequestUntrack={onRequestUntrack}
    />
  )
}

/** Whose first prompt the popup asks for: an agent's, for a chat in a folder or, with `folder` null, a project-less chat summoned from its row. */
interface FirstPromptRequest {
  folder: TrackedFolderView | null
  agent: string
}

/** The first-prompt popup; Start creates the chat (in its folder, or project-less) and opens it. */
function FirstPromptHost({ shell, request, onClose }: { shell: ShellModel; request: FirstPromptRequest; onClose(): void }): JSX.Element {
  const { actions } = shell
  const { folder, agent } = request
  return (
    <FirstPromptDialog
      onClose={onClose}
      onSubmit={async (prompt) =>
        (folder === null
          ? await actions.summonChat(agent, prompt)
          : await actions.createChat(folder, { agent, model: null, role: 'orchestrator', allowSave: true, firstPrompt: prompt })) !== null
      }
    />
  )
}

function ProvisionHost({ shell, scheduler, world, close, recovery }: {
  shell: ShellModel; scheduler: Scheduler; world?: TrackedFolderView; close(): void; recovery: MutableRefObject<ForgeProvisionAttempt | null>
}): JSX.Element | null {
  const api = window.dm.forgeSetup
  if (api === undefined) return null
  return <ProvisionDialog api={api} world={world} agents={shell.agents.agents} scheduler={scheduler} onClose={close} recovery={recovery} onProvisioned={status => {
    const path = status.member ?? status.world
    close()
    if (path !== undefined) void shell.reloadFolders().then(() => shell.actions.selectFolder(path))
  }} />
}

function Shell({ scheduler, EpicView, terminalKit }: { scheduler: Scheduler; EpicView: EpicView; terminalKit: TerminalKit }): JSX.Element {
  const update = useAppUpdate()
  const shell = useShell(scheduler)
  const views = useViewMemory()
  useEffect(() => {
    views.retain(new Set(shell.folders.map(folderIdentity)))
  }, [views, shell.folders])
  const [pending, setPending] = useState<TrackedFolderView | null>(null)
  const startingChats = useRef(new Set<string>())
  const [firstPrompt, setFirstPrompt] = useState<FirstPromptRequest | null>(null)
  const signIn = useSignInView(shell.selection)
  const signingIn = signIn.request !== null
  const [cloning, setCloning] = useState<'repository' | 'forge-world' | null>(null)
  const [provision, setProvision] = useState<{ world?: TrackedFolderView } | null>(null)
  const provisionRecovery = useRef<ForgeProvisionAttempt | null>(null)
  const { actions } = shell
  return (
    <SignInContext.Provider value={signIn.open}>
      <AgentMailContext.Provider value={shell.mail}>
        <div className="app-shell">
          <ShellSidebar shell={shell} version={update.currentVersion} onNewChat={(folder) => {
              if (folder !== null && firstPrompt === null) void startNewChat(shell, folder, startingChats.current, (agent) => setFirstPrompt({ folder, agent }))
            }} onSummon={(agent) => {
              if (firstPrompt === null) setFirstPrompt({ folder: null, agent })
            }} onClone={mode => setCloning(mode ?? 'repository')} onRequestUntrack={setPending}
            onCreateForgeWorld={window.dm.forgeSetup === undefined ? undefined : () => setProvision({})} />
          <main className="app-main" aria-label="Workspace">
            {signIn.request === null ? null : <SignInView request={signIn.request} kit={terminalKit} scheduler={scheduler} onBack={signIn.close} />}
            {/* Kept while the sign-in view shows, hidden, so Back returns to the screen (and any dialog on it) as it was. */}
            <div className="main-view" hidden={signingIn}>
              <MainPane shell={shell} EpicView={EpicView} scheduler={scheduler} terminalKit={terminalKit} onRequestUntrack={setPending} onClone={() => setCloning('repository')}
                onProvision={world => setProvision({ world })} />
            </div>
          </main>
          <UpdateBanner />
          {cloning === null ? null : <CloneHost shell={shell} mode={cloning === 'forge-world' ? cloning : undefined} onClose={() => setCloning(null)} />}
          {provision && <ProvisionHost shell={shell} scheduler={scheduler} world={provision.world} recovery={provisionRecovery} close={() => setProvision(null)} />}
          {firstPrompt === null ? null : <FirstPromptHost shell={shell} request={firstPrompt} onClose={() => setFirstPrompt(null)} />}
          {pending && <UntrackDialog folder={pending} onCancel={() => setPending(null)} onConfirm={() => {
            void actions.untrack(pending.path)
            setPending(null)
          }} />}
        </div>
      </AgentMailContext.Provider>
    </SignInContext.Provider>
  )
}

export function App({ scheduler = browserScheduler, EpicView = EpicWorkspace, terminalKit = xtermKit }: AppProps): JSX.Element {
  // The page's chat terminals, so a chat's sidebar row shows its live PTY whichever chat is shown.
  const [liveTerminals] = useState(createLiveTerminals)
  const [viewMemory] = useState(createViewMemory)
  return (
    <ToastProvider scheduler={scheduler}>
      <LiveTerminalsContext.Provider value={liveTerminals}>
        <GithubAccountProvider>
          <ViewMemoryContext.Provider value={viewMemory}>
            <Shell scheduler={scheduler} EpicView={EpicView} terminalKit={terminalKit} />
          </ViewMemoryContext.Provider>
        </GithubAccountProvider>
      </LiveTerminalsContext.Provider>
    </ToastProvider>
  )
}
