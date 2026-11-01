import { useState } from 'react'
import type { StashInfo } from '../../../shared/git/branches'
import type { RepoStatus } from '../../../shared/git/status'
import { callGit } from '../api/git'
import { useResource } from '../app/useResource'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { useGitRun } from './useGitRun'

interface StashedChangesProps {
  folderPath: string
  status: RepoStatus
  onRefresh(): void
}

function DiscardStashDialog({ folderPath, stash, onClose, onDone }: { folderPath: string; stash: StashInfo; onClose(): void; onDone(): void }): JSX.Element {
  const { busy, failure, run } = useGitRun()
  return (
    <Dialog title="Discard stashed changes?" description="The stashed changes will be deleted for good." onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" busy={busy} onClick={() => run(() => window.git.discardStash(folderPath, stash.ref), onDone)}>
            Discard stash
          </Button>
        </>
      }
    >
      {failure === null ? null : <p role="alert">{failure}</p>}
    </Dialog>
  )
}

function StashDetail({ folderPath, stash, onRefresh }: { folderPath: string; stash: StashInfo; onRefresh(): void }): JSX.Element {
  const [discarding, setDiscarding] = useState(false)
  const { busy, failure, run } = useGitRun()
  // A conflicting restore keeps the stash but may leave conflicts, so the state is read again either way.
  const restore = (): void =>
    run(() => window.git.restoreStash(folderPath, stash.ref), onRefresh, (error) => {
      if (error.code === 'merge_conflicts') onRefresh()
      return false
    })
  return (
    <section className="source-stash-detail" aria-label="Stashed changes">
      <ul className="source-stash-files">
        {stash.files.map((file) => (
          <li key={`${file.kind}:${file.path}`} className="mono">
            {file.path}
          </li>
        ))}
      </ul>
      <div className="source-stash-actions">
        <Button size="sm" variant="primary" busy={busy} onClick={restore}>Restore</Button>
        <Button size="sm" disabled={busy} onClick={() => setDiscarding(true)}>Discard…</Button>
      </div>
      {failure === null ? null : <p role="alert">{failure}</p>}
      {discarding ? (
        <DiscardStashDialog folderPath={folderPath} stash={stash} onClose={() => setDiscarding(false)}
          onDone={() => {
            setDiscarding(false)
            onRefresh()
          }}
        />
      ) : null}
    </section>
  )
}

/** The current branch's newest DM stash, under the file list: a row that opens its files, Restore and Discard. */
export function StashedChanges({ folderPath, status, onRefresh }: StashedChangesProps): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [changes, setChanges] = useState(0)
  const changed = (): void => {
    setChanges((previous) => previous + 1)
    onRefresh()
  }
  // Read again whenever the state is, so a stash made or restored elsewhere shows up.
  const stashes = useResource<StashInfo[]>({
    key: status.branch.name === null ? null : `${folderPath}\u0000${status.branch.name}`,
    version: JSON.stringify([changes, status.branch.headOid, status.files]),
    load: () => callGit(window.git.listStashes(folderPath)),
    onError: () => undefined
  })
  const stash = stashes.status === 'ready' ? stashes.value[0] : undefined
  if (stash === undefined) {
    return null
  }
  return (
    <div className="source-stash">
      <button type="button" className="source-stash-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        Stashed changes <span className="muted">{`${stash.files.length} ${stash.files.length === 1 ? 'file' : 'files'}`}</span>
      </button>
      {open ? <StashDetail folderPath={folderPath} stash={stash} onRefresh={changed} /> : null}
    </div>
  )
}
