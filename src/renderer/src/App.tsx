import { useCallback, useMemo, useState } from 'react'
import type { ComponentProps, ComponentType } from 'react'
import type { ChatRecord } from '../../shared/agents/chat'
import type { TrackedFolderView } from '../../shared/desktop/api'
import { threadLandingFor, ticketLandingFor } from './app/landing'
import { findFolder } from './app/selection'
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
import type { ChatNavigation } from './agents/ChatContext'
import { ChatView } from './agents/ChatView'
import { NewChatDialog } from './agents/NewChatDialog'
import { chatsFor } from './agents/useChats'
import { CheckForUpdatesButton } from './autoUpdate/CheckForUpdatesButton'
import { UpdateBanner, useAppUpdate } from './autoUpdate/UpdateBanner'
import { EpicWorkspace } from './epic/EpicWorkspace'
import type { EpicWorkspaceProps } from './epic/EpicWorkspace'
import type { OrchestrationHost } from './epic/orchestration'
import { FolderPage } from './folder/FolderPage'
import { FolderHome } from './home/FolderHome'
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
}

interface PaneProps {
  shell: ShellModel
  scheduler: Scheduler
  EpicView: EpicView
  onRequestUntrack(folder: TrackedFolderView): void
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
    onChatsChanged: () => void shell.chats.reload(folder.path),
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
}

/** An open chat. Its links (markers, bound threads) open tickets and epics in the folder; a request to show one of its threads is handed to it once. */
function ChatPane({ shell, folder, chat }: ChatPaneProps): JSX.Element {
  const actions = useLatest(shell.actions)
  const navigation = useMemo<ChatNavigation>(
    () => ({
      openTicket: (link) => actions.current.openTicket(folder.path, link),
      openEpic: (epicId) => actions.current.selectEpic(folder.path, epicId)
    }),
    [actions, folder.path]
  )
  const onLanded = useCallback(() => actions.current.landed(), [actions])
  return <ChatView chat={chat} onAgentStatus={shell.agents.recordStatus} navigation={navigation} landing={threadLandingFor(shell.landing, chat.id)} onLanded={onLanded} />
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
      list={listFor(shell.lists, folder.path)}
      status={shell.status}
      busy={shell.busy}
      onOpenEpic={(id) => actions.selectEpic(folder.path, id)}
      onCreateEpic={(input) => actions.createEpic(folder, input)}
      onFlush={() => void actions.flush()}
      onReconcile={() => void actions.reconcile()}
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
      return <WelcomeView onTrack={() => void actions.track()} />
    case 'add-agent':
      return <AddAgentPane agents={shell.agents} />
    case 'agent':
      return <AgentPage key={view.agent.kind} agent={view.agent} agents={shell.agents} />
    case 'chat':
      return <ChatPane key={view.chat.id} shell={shell} folder={view.folder} chat={view.chat} />
    case 'unavailable':
      return <UnavailableView folder={view.folder} onStopTracking={props.onRequestUntrack} />
    default:
      return <FolderPane {...props} />
  }
}

function ShellFooter({ shell }: { shell: ShellModel }): JSX.Element {
  const { view } = shell
  const onFolder = view.kind === 'folder' || view.kind === 'epic' || view.kind === 'chat'
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

interface NewChatHostProps {
  shell: ShellModel
  folder: TrackedFolderView
  onClose(): void
}

/** The new-chat dialog for a folder, wired to the shell: creating opens the chat, and the links open the agents screens. */
function NewChatHost({ shell, folder, onClose }: NewChatHostProps): JSX.Element {
  const { actions } = shell
  return (
    <NewChatDialog
      folder={folder}
      agents={shell.agents.agents}
      statuses={shell.agents.statuses}
      onCreate={async (choice) => (await actions.createChat(folder, choice)) !== null}
      onAddAgent={() => {
        onClose()
        actions.openAddAgent()
      }}
      onAgentStatus={shell.agents.recordStatus}
      onClose={onClose}
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

function Shell({ scheduler, EpicView }: { scheduler: Scheduler; EpicView: EpicView }): JSX.Element {
  const update = useAppUpdate()
  const shell = useShell(scheduler)
  const [pending, setPending] = useState<TrackedFolderView | null>(null)
  const [newChatIn, setNewChatIn] = useState<TrackedFolderView | null>(null)
  const { actions } = shell
  return (
    <div className="app-shell">
      <Sidebar
        version={update.currentVersion}
        folders={shell.folders}
        lists={shell.lists}
        selection={shell.selection}
        agents={shell.agents.agents}
        agentStatuses={shell.agents.statuses}
        expansion={shell.expansion}
        chats={sidebarChats(shell, (path) => setNewChatIn(findFolder(shell.folders, path)))}
        footer={<ShellFooter shell={shell} />}
        onTrack={() => void actions.track()}
        onAddAgent={actions.openAddAgent}
        onSelectAgent={actions.openAgent}
        onAgentStatus={shell.agents.recordStatus}
        onSelectFolder={actions.selectFolder}
        onSelectEpic={actions.selectEpic}
        onRequestUntrack={setPending}
      />
      <main className="app-main" aria-label="Workspace">
        <MainPane shell={shell} scheduler={scheduler} EpicView={EpicView} onRequestUntrack={setPending} />
      </main>
      <UpdateBanner />
      {newChatIn === null ? null : (
        <NewChatHost shell={shell} folder={newChatIn} onClose={() => setNewChatIn(null)} />
      )}
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
  )
}

export function App({ scheduler = browserScheduler, EpicView = EpicWorkspace }: AppProps): JSX.Element {
  return (
    <ToastProvider scheduler={scheduler}>
      <Shell scheduler={scheduler} EpicView={EpicView} />
    </ToastProvider>
  )
}
