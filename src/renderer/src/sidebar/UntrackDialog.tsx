import type { TrackedFolderView } from '../../../shared/desktop/api'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'

interface UntrackDialogProps {
  folder: TrackedFolderView
  onConfirm(): void
  onCancel(): void
}

/** Stop tracking only removes the sidebar entry; the dialog says so before the person commits. */
export function UntrackDialog({ folder, onConfirm, onCancel }: UntrackDialogProps): JSX.Element {
  return (
    <Dialog
      title={`Stop tracking ${folder.name}?`}
      description="This only removes the folder from this sidebar. The repository, its .darkmechanicus/ records and any external workers are not touched."
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm}>
            Stop tracking
          </Button>
        </>
      }
    >
      <p className="mono dialog-path">{folder.displayPath}</p>
    </Dialog>
  )
}
