import { useState } from 'react'
import type { ComponentType } from 'react'
import type { TrackedFolderView } from '../../shared/desktop/api'
import { listFor } from './app/useEpicLists'
import { browserScheduler } from './app/scheduler'
import type { Scheduler } from './app/scheduler'
import { LoadingView, UnavailableView, WelcomeView } from './app/MainViews'
import { ToastProvider } from './app/toasts'
import { useShell } from './app/useShell'
import type { ShellModel } from './app/useShell'
import { CheckForUpdatesButton } from './autoUpdate/CheckForUpdatesButton'
import { UpdateBanner, useAppUpdate } from './autoUpdate/UpdateBanner'
import { EpicWorkspace } from './epic/EpicWorkspace'
import type { EpicWorkspaceProps } from './epic/EpicWorkspace'
import { FolderHome } from './home/FolderHome'
import { OnboardingView } from './onboarding/OnboardingView'
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
  EpicView: EpicView
  onRequestUntrack(folder: TrackedFolderView): void
}

/** An open folder: either one of its epics, or the folder home. */
function FolderPane({ shell, EpicView }: PaneProps): JSX.Element | null {
  const { view, actions } = shell
  if (view.kind === 'epic') {
    const { folder, epicId } = view
    return (
      <EpicView
        key={`${folder.path}:${epicId}`}
        folder={folder}
        epicId={epicId}
        refreshToken={shell.epicToken(folder.path, epicId)}
        onChanged={() => actions.changed(folder.path)}
        onOpenEpic={(id) => actions.selectEpic(folder.path, id)}
      />
    )
  }
  if (view.kind !== 'home') {
    return null
  }
  const { folder } = view
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
    />
  )
}

function MainPane(props: PaneProps): JSX.Element | null {
  const { shell } = props
  const { view, actions } = shell
  switch (view.kind) {
    case 'loading':
      return <LoadingView />
    case 'welcome':
      return <WelcomeView onTrack={() => void actions.track()} />
    case 'unavailable':
      return <UnavailableView folder={view.folder} onStopTracking={props.onRequestUntrack} />
    case 'onboarding':
      return (
        <OnboardingView
          folder={view.folder}
          busy={shell.busy.initialize}
          onInitialize={() => void actions.initialize(view.folder)}
          onChooseDifferent={() => void actions.track()}
        />
      )
    default:
      return <FolderPane {...props} />
  }
}

function ShellFooter({ shell }: { shell: ShellModel }): JSX.Element {
  const folderReady = shell.view.kind === 'home' || shell.view.kind === 'epic'
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

function Shell({ scheduler, EpicView }: { scheduler: Scheduler; EpicView: EpicView }): JSX.Element {
  const update = useAppUpdate()
  const shell = useShell(scheduler)
  const [pending, setPending] = useState<TrackedFolderView | null>(null)
  const { actions } = shell
  return (
    <div className="app-shell">
      <Sidebar
        version={update.currentVersion}
        folders={shell.folders}
        lists={shell.lists}
        selection={shell.selection}
        expansion={shell.expansion}
        footer={<ShellFooter shell={shell} />}
        onTrack={() => void actions.track()}
        onSelectFolder={actions.selectFolder}
        onSelectEpic={actions.selectEpic}
        onRequestUntrack={setPending}
      />
      <main className="app-main" aria-label="Workspace">
        <MainPane shell={shell} EpicView={EpicView} onRequestUntrack={setPending} />
      </main>
      <UpdateBanner />
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
