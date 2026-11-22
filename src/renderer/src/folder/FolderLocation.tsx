import { useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { SourceControlTarget } from '../../../shared/git/api'
import { errorMessage } from '../api/dm'
import type { SourceTargetModel } from '../source/useSourceTarget'

export function RepositoryLink({ repository }: { repository: string }): JSX.Element {
  return <a href={repository} onClick={event => { event.preventDefault(); void window.dm.openExternal(repository) }}>{repository}</a>
}

function LocalFolderLink({ folder, target }: { folder: TrackedFolderView; target: Extract<SourceControlTarget, { kind: 'available' }> }): JSX.Element {
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const open = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    try {
      const result = await window.dm.openTrackedFolder(folder.path, target.path)
      if (!result.ok) setFailure(result.error.message)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return <>
    <button type="button" className="folder-location mono" disabled={busy} title={target.path} aria-label={`Open folder ${target.displayPath}`} onClick={() => void open()}>{target.displayPath}</button>
    {failure === null ? null : <p className="folder-location-error" role="alert">{failure}</p>}
  </>
}

/** The displayed destination is also checked by main when the person opens it. */
export function FolderLocation({ folder, target }: { folder: TrackedFolderView; target?: SourceTargetModel }): JSX.Element {
  const state = target?.state ?? { status: 'ready' as const, value: { kind: 'available' as const, path: folder.path, displayPath: folder.displayPath } }
  if (state.status === 'loading') return <span className="muted">Finding the local code repository…</span>
  if (state.status === 'error') return <span role="alert">{target?.error ?? 'Could not find the local code repository.'}</span>
  if (state.value.kind === 'unavailable') return <div className="folder-location-missing"><span className="muted">Code repository not available locally</span><RepositoryLink repository={state.value.repository} /></div>
  return <LocalFolderLink key={state.value.path} folder={folder} target={state.value} />
}
