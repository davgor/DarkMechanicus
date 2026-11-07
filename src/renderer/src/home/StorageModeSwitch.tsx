import { useState } from 'react'
import type { StorageStatusView } from '../../../shared/domain/views'
import { errorMessage, runCommand } from '../api/dm'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'

interface Props { status: StorageStatusView; onChanged?: () => void }

/** This destructive operation is intentionally a person-only command, never an automatic mode preference. */
export function StorageModeSwitch({ status, onChanged = () => window.location.reload() }: Props): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toRepo = status.storage.mode === 'db'
  const close = (): void => { if (!busy) { setConfirming(false); setError(null) } }
  const change = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await runCommand(status.repoRoot, 'switchStorageMode', { mode: toRepo ? 'repo' : 'db', confirmed: true })
      setConfirming(false)
      onChanged()
    } catch (failure) { setError(errorMessage(failure)) } finally { setBusy(false) }
  }
  return (
    <>
      <Button onClick={() => setConfirming(true)}>{toRepo ? 'Switch to repository files…' : 'Switch to database only…'}</Button>
      {confirming ? (
        <Dialog
          title={toRepo ? 'Move records into this repository?' : 'Move records out of this repository?'}
          description="The complete destination is verified before the original store is deleted. This does not commit or rewrite Git history."
          onClose={close}
          actions={<>
            <Button disabled={busy} onClick={close}>Cancel</Button>
            <Button busy={busy} onClick={() => void change()}>
              {toRepo ? 'Move records and delete local store' : 'Move records and delete repository store'}
            </Button>
          </>}
        >
          {toRepo ? (
            <p>This writes portable JSON records and images into <code>.darkmechanicus/</code>, rebuilds and verifies the working database, then deletes the machine-local project directory <code>{status.storage.projectDir}</code>. Commit the exported records to share them. Unsaved drafts and session credentials remain Git-ignored in <code>local/</code>.</p>
          ) : (
            <p>This moves all records and images into a machine-local database, then deletes the entire <code>.darkmechanicus/</code> directory, including <code>local/</code>, and Dark Mechanicus’s <code>.gitignore</code> entry. Nothing will travel with a clone. Existing <code>.mcp.json</code> and installed skills are left alone; remove them separately if you no longer want them. Previously committed records remain in Git history.</p>
          )}
          <p className="note">Finish or cancel active runs, resolve claimed attempts, and close other connected sessions first. Repository records must be committed before moving to database only.</p>
          {error === null ? null : <p className="inline-warning" role="alert">{error}</p>}
        </Dialog>
      ) : null}
    </>
  )
}
