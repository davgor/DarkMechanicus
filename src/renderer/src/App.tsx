import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentProps, ComponentType } from 'react'
import type { ChatRecord } from '../../shared/agents/chat'
import type { TrackedFolderView } from '../../shared/desktop/api'
import { threadLandingFor, ticketLandingFor } from './app/landing'
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
import { SignInContext, type SignInRequest } from './agents/signInContext'
import { SignInView } from './agents/SignInView'
import { chatsFor } from './agents/useChats'
import { TerminalPane } from './agents/TerminalPane'
import type { TerminalKit } from './agents/terminalView'
import { xtermKit } from './agents/xtermKit'
import { CheckForUpdatesButton } from './autoUpdate/CheckForUpdatesButton'
import { UpdateBanner, useAppUpdate } from './autoUpdate/UpdateBanner'
import { EpicWorkspace } from './epic/EpicWorkspace'
import type { EpicWorkspaceProps } from './epic/EpicWorkspace'
import type { OrchestrationHost } from './epic/orchestration'
import { CloneDialog } from './clone/CloneDialog'
import { FolderPage } from './folder/FolderPage'
import { GithubAccountProvider } from './github/GithubAccount'
import { FolderHome } from './home/FolderHome'
import { KanbanBoard } from './kanban/KanbanBoard'
import { OnboardingView } from './onboarding/OnboardingView'
import { SourceControlView } from './source/SourceControlView'
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
  const onDeleted = useCallback(() => {
    actions.current.changed(folder.path)
    actions.current.selectFolder(folder.path)
  }, [actions, folder.path])
  const onLanded = useCallback(() => actions.current.landed(), [actions])
  return (
    <EpicView
      key={`${folder.path}:${epicId}`}
      folder={folder}
      epicId={epicId}
      refreshToken={shell.epicToken(folder.path, epicId)}
      onChanged={onChanged}
      onOpenEpic={onOpenEpic}
      onDeleted={onDeleted}
      landing={ticketLandingFor(shell.landing, epicId)}
      onLanded={onLanded}
      orchestration={orchestrationFor(shell, folder)}
    />
  )
}

interface ChatPaneProps {
  shell: ShellModel
  folder: TrackedFolderView
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
      folder={folder.path}
      chat={chat}
      agentName={agentName(chat.agent, shell.agents.agents)}
      kit={terminalKit}
      scheduler={scheduler}
      onAgentStatus={(status) => shell.agents.recordStatus(chat.agent, status)}
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
function FolderPane({ shell, scheduler, EpicView }: PaneProps): JSX.Element | null {
  const { view } = shell
  if (view.kind === 'epic') {
    return <EpicPane shell={shell} EpicView={EpicView} folder={view.folder} epicId={view.epicId} />
  }
  if (view.kind !== 'folder') {
    return null
  }
  const { folder, tab } = view
  return (
    <FolderPage key={folder.path} folder={folder} tab={tab} onTab={(next) => shell.setFolderTab(folder.path, next)}>
      {tab === 'source' ? <SourceControlView key={folder.path} folder={folder} scheduler={scheduler} /> : <EpicsPanel shell={shell} folder={folder} />}
    </FolderPage>
  )
}

function MainPane(props: PaneProps): JSX.Element | null {
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
      return <ChatPane key={view.chat.id} shell={shell} folder={view.folder} chat={view.chat} scheduler={props.scheduler} terminalKit={props.terminalKit} />
    case 'kanban':
      return <KanbanBoard key={view.folder.path} folder={view.folder} refreshToken={shell.folderToken(view.folder.path)} host={orchestrationFor(shell, view.folder)} />
    case 'unavailable':
      return <UnavailableView folder={view.folder} onStopTracking={props.onRequestUntrack} />
    default:
      return <FolderPane {...props} />
  }
}

function ShellFooter({ shell }: { shell: ShellModel }): JSX.Element {
  const { view } = shell
  const onFolder = view.kind === 'folder' || view.kind === 'epic' || view.kind === 'chat' || view.kind === 'kanban'
  const folderReady = onFolder && view.folder.initialized
  return (
    <SidebarFooter
      status={shell.status}
      folderReady={folderReady}
      busy={shell.busy}
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
 * New chat with one click: the folder's agent (see `newChatAgent`) as an orchestrator that may save, on the
 * CLI's own default model, and its terminal opens; with no agent connected, the add-agent pane opens instead.
 * A click while a folder's new chat is still being created does nothing (`starting` holds those folders).
 */
async function startNewChat(shell: ShellModel, folder: TrackedFolderView, starting: Set<string>): Promise<void> {
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
    await shell.actions.createChat(folder, { agent, model: null, role: 'orchestrator', allowSave: true })
  } finally {
    starting.delete(folder.path)
  }
}

/** The clone dialog; a finished clone opens the new folder on its Source control tab. */
function CloneHost({ shell, onClose }: { shell: ShellModel; onClose(): void }): JSX.Element {
  return (
    <CloneDialog
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
  /** Opens the clone dialog. */
  onClone(): void
  onRequestUntrack(folder: TrackedFolderView): void
}

/** The sidebar, wired to the shell: folders and their epics and chats, the Agents list, and the footer. */
function ShellSidebar({ shell, version, onNewChat, onClone, onRequestUntrack }: ShellSidebarProps): JSX.Element {
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
      chats={sidebarChats(shell, (path) => onNewChat(findFolder(shell.folders, path)))}
      footer={<ShellFooter shell={shell} />}
      onTrack={() => void actions.track()}
      onClone={onClone}
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

function Shell({ scheduler, EpicView, terminalKit }: { scheduler: Scheduler; EpicView: EpicView; terminalKit: TerminalKit }): JSX.Element {
  const update = useAppUpdate()
  const shell = useShell(scheduler)
  const [pending, setPending] = useState<TrackedFolderView | null>(null)
  const startingChats = useRef(new Set<string>())
  const signIn = useSignInView(shell.selection)
  const signingIn = signIn.request !== null
  const [cloning, setCloning] = useState(false)
  const { actions } = shell
  return (
    <SignInContext.Provider value={signIn.open}>
      <div className="app-shell">
        <ShellSidebar shell={shell} version={update.currentVersion} onNewChat={(folder) => {
            if (folder !== null) void startNewChat(shell, folder, startingChats.current)
          }} onClone={() => setCloning(true)} onRequestUntrack={setPending} />
        <main className="app-main" aria-label="Workspace">
          {signIn.request === null ? null : <SignInView request={signIn.request} kit={terminalKit} scheduler={scheduler} onBack={signIn.close} />}
          {/* Kept while the sign-in view shows, hidden, so Back returns to the screen (and any dialog on it) as it was. */}
          <div className="main-view" hidden={signingIn}>
            <MainPane shell={shell} EpicView={EpicView} scheduler={scheduler} terminalKit={terminalKit} onRequestUntrack={setPending} onClone={() => setCloning(true)} />
          </div>
        </main>
        <UpdateBanner />
        {cloning ? <CloneHost shell={shell} onClose={() => setCloning(false)} /> : null}
        {pending === null ? null : (
          <UntrackDialog
            folder={pending}
            onCancel={() => setPending(null)}
            onConfirm={() => {
              void actions.untrack(pending.path)
              setPending(null)
            }}
          />
        )}
      </div>
    </SignInContext.Provider>
  )
}

export function App({ scheduler = browserScheduler, EpicView = EpicWorkspace, terminalKit = xtermKit }: AppProps): JSX.Element {
  // The page's chat terminals, so a chat's sidebar row shows its live PTY whichever chat is shown.
  const [liveTerminals] = useState(createLiveTerminals)
  return (
    <ToastProvider scheduler={scheduler}>
      <LiveTerminalsContext.Provider value={liveTerminals}>
        <GithubAccountProvider>
          <Shell scheduler={scheduler} EpicView={EpicView} terminalKit={terminalKit} />
        </GithubAccountProvider>
      </LiveTerminalsContext.Provider>
    </ToastProvider>
  )
}
