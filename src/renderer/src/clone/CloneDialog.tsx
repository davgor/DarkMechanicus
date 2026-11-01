import { useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { GithubRepository } from '../../../shared/github/api'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { Field } from '../components/Field'
import { SignInPrompt } from '../github/SignInPrompt'
import { repositoryName, targetPath } from './cloneTarget'
import { GithubTab } from './GithubTab'
import { useClone } from './useClone'
import type { CloneFailure, RunningClone } from './useClone'
import './clone.css'

type CloneTab = 'github' | 'url'

const TABS: ReadonlyArray<[CloneTab, string]> = [
  ['github', 'GitHub.com'],
  ['url', 'URL']
]

function CloneTabs({ tab, onTab }: { tab: CloneTab; onTab(tab: CloneTab): void }): JSX.Element {
  return (
    <div className="clone-tabs" role="tablist" aria-label="Clone from">
      {TABS.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => onTab(id)}>
          {label}
        </button>
      ))}
    </div>
  )
}

interface LocalPathProps {
  parent: string | null | undefined
  name: string
  onName(name: string): void
  onChoose(): void
}

function LocalPath({ parent, name, onName, onChoose }: LocalPathProps): JSX.Element {
  return (
    <div className="clone-local">
      <span className="field-label">Local path</span>
      <div className="clone-parent-row">
        <span className="clone-parent">{parent ?? (parent === null ? 'Choose a folder to clone into.' : 'Loading…')}</span>
        <Button size="sm" onClick={onChoose}>
          Choose…
        </Button>
      </div>
      <Field label="Name" value={name} onChange={onName} />
      {typeof parent === 'string' && name.trim() !== '' ? (
        <p className="dialog-path">
          Clones into <code data-testid="clone-target">{targetPath(parent, name.trim())}</code>
        </p>
      ) : null}
    </div>
  )
}

function CloneProgress({ running, onCancel }: { running: RunningClone; onCancel(): void }): JSX.Element {
  const percent = running.percent === null ? null : Math.max(0, Math.min(100, Math.round(running.percent)))
  return (
    <div className="clone-progress">
      <div className="clone-progress-bar" role="progressbar" aria-label="Clone progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
        <div className="clone-progress-fill" style={{ width: `${percent ?? 0}%` }} />
      </div>
      <span className="clone-progress-text muted">{`${running.phase ?? 'Cloning…'}${percent === null ? '' : ` ${percent}%`}`}</span>
      <Button size="sm" variant="ghost" aria-label="Cancel clone" title="Cancel clone" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}

function CloneFailureNotice({ failure }: { failure: CloneFailure }): JSX.Element {
  if (failure.kind === 'auth') return <SignInPrompt purpose="clone this repository" />
  if (failure.kind === 'exists') {
    return (
      <p className="clone-error" role="alert">
        {`${failure.path} already exists`}
      </p>
    )
  }
  return (
    <div className="clone-error" role="alert">
      <p>{failure.message}</p>
      {failure.detail === null ? null : <pre className="clone-error-detail">{failure.detail}</pre>}
    </div>
  )
}

interface CloneDialogProps {
  onClose(): void
  /** The clone succeeded; main already tracks the folder. */
  onCloned(folder: TrackedFolderView): void
}

/** Clones a repository from the account's GitHub list or a URL into the clone parent, with progress and Cancel. */
export function CloneDialog({ onClose, onCloned }: CloneDialogProps): JSX.Element {
  const clone = useClone(onCloned)
  const [tab, setTab] = useState<CloneTab>('github')
  const [picked, setPicked] = useState<GithubRepository | null>(null)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const source = tab === 'github' ? (picked?.cloneUrl ?? '') : url.trim()
  const ready = typeof clone.parent === 'string' && source !== '' && name.trim() !== '' && clone.running === null
  const close = (): void => {
    clone.cancel()
    onClose()
  }
  const switchTab = (next: CloneTab): void => {
    setTab(next)
    setName(next === 'github' ? (picked?.name ?? '') : repositoryName(url))
  }
  const pick = (repository: GithubRepository): void => {
    setPicked(repository)
    setName(repository.name)
  }
  const typeUrl = (value: string): void => {
    setUrl(value)
    setName(repositoryName(value))
  }
  const actions = (
    <>
      <Button onClick={close}>Close</Button>
      <Button variant="primary" disabled={!ready} onClick={() => clone.start(source, name.trim())}>
        Clone
      </Button>
    </>
  )
  return (
    <Dialog title="Clone a repository" onClose={close} actions={actions}>
      <CloneTabs tab={tab} onTab={switchTab} />
      <div className="clone-panel" role="tabpanel">
        {tab === 'github' ? (
          <GithubTab selected={picked} onSelect={pick} />
        ) : (
          <Field label="Repository URL or owner/repo" value={url} onChange={typeUrl} />
        )}
      </div>
      <LocalPath parent={clone.parent} name={name} onName={setName} onChoose={clone.chooseParent} />
      {clone.running === null ? null : <CloneProgress running={clone.running} onCancel={clone.cancel} />}
      {clone.failure === null ? null : <CloneFailureNotice failure={clone.failure} />}
    </Dialog>
  )
}
