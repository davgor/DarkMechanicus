import { useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { callGit } from '../api/git'
import type { Scheduler } from '../app/scheduler'
import { Button } from '../components/Button'
import { RepositoryView } from './RepositoryView'
import { useRepoState } from './useRepoState'

const GIT_DOWNLOADS = 'https://git-scm.com/downloads'

interface SourceControlViewProps {
  folder: TrackedFolderView
  scheduler: Scheduler
}

function Notice(props: { title: string; children?: React.ReactNode }): JSX.Element {
  return (
    <div className="source-notice">
      <h2>{props.title}</h2>
      {props.children}
    </div>
  )
}

function InitializeNotice({ folder, onDone }: { folder: string; onDone(): void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const initialize = (): void => {
    setBusy(true)
    setFailure(null)
    callGit(window.git.initRepository(folder)).then(
      () => {
        setBusy(false)
        onDone()
      },
      (error: unknown) => {
        setBusy(false)
        setFailure(error instanceof Error ? error.message : 'Git did not answer.')
      }
    )
  }
  return (
    <Notice title="This folder isn’t a Git repository">
      <p className="muted">Initialize one to see changes here and commit them.</p>
      <Button variant="primary" busy={busy} onClick={initialize}>
        Initialize repository
      </Button>
      {failure === null ? null : <p role="alert">{failure}</p>}
    </Notice>
  )
}

/** The folder's Source control: its repository's changes and diffs, or what stands in the way of showing them. */
export function SourceControlView({ folder, scheduler }: SourceControlViewProps): JSX.Element {
  const repo = useRepoState({ folder: folder.path, scheduler })
  const { state } = repo
  if (state.status === 'loading') {
    return (
      <div className="source-view" role="status">
        <p className="muted source-loading">Reading the repository…</p>
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="source-view">
        <Notice title="Couldn’t read this folder’s Git state">
          <p role="alert">{repo.error ?? 'Git did not answer.'}</p>
          <Button onClick={repo.refresh}>Retry</Button>
        </Notice>
      </div>
    )
  }
  const { value } = state
  return (
    <div className="source-view">
      {value.kind === 'git_missing' ? (
        <Notice title="Git isn’t installed">
          <p className="muted">Source control needs Git on this computer.</p>
          <a
            href={GIT_DOWNLOADS}
            onClick={(event) => {
              event.preventDefault()
              void window.dm.openExternal(GIT_DOWNLOADS)
            }}
          >
            Download Git
          </a>
        </Notice>
      ) : null}
      {value.kind === 'not_repository' ? <InitializeNotice folder={folder.path} onDone={repo.refresh} /> : null}
      {value.kind === 'repository' ? <RepositoryView folderPath={folder.path} status={value.status} version={repo.version} onRefresh={repo.refresh} /> : null}
    </div>
  )
}
