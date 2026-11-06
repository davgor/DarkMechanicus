import { useState } from 'react'
import { KANBAN_OPEN_ATTEMPT_STATES } from '../../../shared/domain/kanban'
import type { KanbanCardView } from '../../../shared/domain/kanban'
import { errorMessage, runCommand } from '../api/dm'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'

/** An attempt that is claimed, running or submitted keeps the card from being deleted. */
function deleteBlockedReason(card: KanbanCardView): string | null {
  const open = card.openAttempt
  if (open === null || !KANBAN_OPEN_ATTEMPT_STATES.includes(open.state)) return null
  return open.state === 'submitted'
    ? `Attempt #${open.number} is waiting for your review. Approve or kick it back before deleting this card.`
    : `Attempt #${open.number} is ${open.state}. Wait for it to finish or its lease to lapse before deleting this card.`
}

interface DeleteCardControlProps {
  folderPath: string
  card: KanbanCardView
  /** The card was deleted. */
  onDeleted(): void
}

interface ConfirmProps {
  folderPath: string
  card: KanbanCardView
  onDeleted(): void
  onClose(): void
}

/** The confirmation: nothing is removed until "Delete card" is pressed, and a refusal stays on screen. */
function ConfirmDelete({ folderPath, card, onDeleted, onClose }: ConfirmProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const remove = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      await runCommand(folderPath, 'deleteKanbanCard', { cardId: card.id })
      onDeleted()
    } catch (error) {
      setProblem(errorMessage(error))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={`Delete ${card.key}`}
      description={`Delete “${card.title}” with its attempts and history? The card is removed from the board and its .darkmechanicus files are removed from this checkout; commit the removal yourself. This cannot be undone.`}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Keep</Button>
          <Button variant="danger" busy={busy} disabled={busy} onClick={() => void remove()}>
            Delete card
          </Button>
        </>
      }
    >
      {problem === null ? null : (
        <p className="form-error" role="alert">
          {problem}
        </p>
      )}
    </Dialog>
  )
}

/** "Delete…" on the open card: disabled with the reason while an attempt is in flight, otherwise confirmed in a dialog. */
export function DeleteCardControl({ folderPath, card, onDeleted }: DeleteCardControlProps): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const blocked = deleteBlockedReason(card)
  return (
    <>
      <Button variant="ghost" disabled={blocked !== null} title={blocked ?? undefined} onClick={() => setConfirming(true)}>
        Delete…
      </Button>
      {blocked === null ? null : (
        <p role="note" className="kanban-note">
          {blocked}
        </p>
      )}
      {confirming ? <ConfirmDelete folderPath={folderPath} card={card} onDeleted={onDeleted} onClose={() => setConfirming(false)} /> : null}
    </>
  )
}
