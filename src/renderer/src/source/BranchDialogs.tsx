import { useEffect, useState } from 'react'
import type { BranchInfo, CreateBranchRequest } from '../../../shared/git/branches'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { Field } from '../components/Field'
import { useGitRun } from './useGitRun'

type NameCheck = { state: 'empty' | 'checking' | 'invalid' } | { state: 'valid'; normalized: string }

/** Asks main whether git accepts the name as it is typed; an answer for an older name is dropped. */
function useBranchNameCheck(folderPath: string, name: string): NameCheck {
  const [check, setCheck] = useState<NameCheck>({ state: 'empty' })
  useEffect(() => {
    if (name === '') {
      setCheck({ state: 'empty' })
      return undefined
    }
    let current = true
    setCheck({ state: 'checking' })
    window.git.checkBranchName(folderPath, name).then(
      (result) => {
        if (!current) return
        const valid = result.ok && result.data.valid && result.data.normalized !== null
        setCheck(valid ? { state: 'valid', normalized: result.data.normalized ?? name } : { state: 'invalid' })
      },
      () => current && setCheck({ state: 'invalid' })
    )
    return () => {
      current = false
    }
  }, [folderPath, name])
  return check
}

function NameStatus({ check, verb }: { check: NameCheck; verb: string }): JSX.Element | null {
  if (check.state === 'valid') {
    return <p className="muted branch-name-status">{`Will be ${verb} as ${check.normalized}`}</p>
  }
  return check.state === 'invalid' ? <p className="branch-name-status branch-name-invalid">That is not a valid branch name.</p> : null
}

const Failure = ({ text }: { text: string | null }): JSX.Element | null => (text === null ? null : <p role="alert">{text}</p>)

interface DialogBase {
  folderPath: string
  onClose(): void
  /** After a change succeeded: reads the state again and closes. */
  onDone(): void
}

interface SwitchDialogProps extends DialogBase {
  current: string
  target: { label: string; name: string }
}

/** Switching with uncommitted changes: leave them in a stash on the current branch, or bring them along. */
export function SwitchDialog({ folderPath, current, target, onClose, onDone }: SwitchDialogProps): JSX.Element {
  const { busy, failure, run } = useGitRun()
  const go = (uncommitted: 'stash' | 'bring'): void =>
    run(() => window.git.switchBranch(folderPath, { name: target.name, uncommitted }), onDone)
  return (
    <Dialog title={`Switch to ${target.label}`} description={`You have changes on ${current}.`} onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button busy={busy} onClick={() => go('bring')}>{`Bring my changes to ${target.label}`}</Button>
          <Button variant="primary" busy={busy} onClick={() => go('stash')}>{`Leave my changes on ${current}`}</Button>
        </>
      }
    >
      <p className="muted">Changes you leave are stashed and show under Stashed changes when you come back.</p>
      <Failure text={failure} />
    </Dialog>
  )
}

export function NewBranchDialog({ folderPath, onClose, onDone }: DialogBase): JSX.Element {
  const [name, setName] = useState('')
  const [startPoint, setStartPoint] = useState<CreateBranchRequest['startPoint']>('current')
  const check = useBranchNameCheck(folderPath, name)
  const { busy, failure, run } = useGitRun()
  const create = (): void => {
    if (check.state === 'valid') run(() => window.git.createBranch(folderPath, { name: check.normalized, startPoint }), onDone)
  }
  return (
    <Dialog title="New branch" onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={check.state !== 'valid'} onClick={create}>Create branch</Button>
        </>
      }
    >
      <Field label="Name" value={name} onChange={setName} />
      <NameStatus check={check} verb="created" />
      <fieldset className="branch-base">
        <legend className="field-label">Start from</legend>
        {(['current', 'default'] as const).map((value) => (
          <label key={value} className="branch-base-option">
            <input type="radio" name="branch-base" checked={startPoint === value} onChange={() => setStartPoint(value)} />
            {value === 'current' ? 'Current branch' : 'Default branch'}
          </label>
        ))}
      </fieldset>
      <Failure text={failure} />
    </Dialog>
  )
}

export function RenameDialog({ folderPath, from, onClose, onDone }: DialogBase & { from: string }): JSX.Element {
  const [name, setName] = useState(from)
  const check = useBranchNameCheck(folderPath, name)
  const { busy, failure, run } = useGitRun()
  const ready = check.state === 'valid' && check.normalized !== from
  const rename = (): void => {
    if (check.state === 'valid') run(() => window.git.renameBranch(folderPath, { from, to: check.normalized }), onDone)
  }
  return (
    <Dialog title={`Rename ${from}`} onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={rename}>Rename</Button>
        </>
      }
    >
      <Field label="Name" value={name} onChange={setName} />
      <NameStatus check={check} verb="renamed" />
      <Failure text={failure} />
    </Dialog>
  )
}

/** Deletes a local branch, optionally with its upstream; an unmerged branch asks a second time before forcing. */
export function DeleteDialog({ folderPath, branch, onClose, onDone }: DialogBase & { branch: BranchInfo }): JSX.Element {
  const [deleteRemote, setDeleteRemote] = useState(false)
  const [unmerged, setUnmerged] = useState(false)
  const { busy, failure, run } = useGitRun()
  const remove = (force: boolean): void =>
    run(() => window.git.deleteBranch(folderPath, { name: branch.name, deleteRemote, force }), onDone, (error) => {
      setUnmerged(error.code === 'branch_not_fully_merged')
      return error.code === 'branch_not_fully_merged'
    })
  return (
    <Dialog title={`Delete ${branch.name}?`} onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" busy={busy} onClick={() => remove(unmerged)}>{unmerged ? 'Delete anyway' : 'Delete'}</Button>
        </>
      }
    >
      {branch.upstream === null ? null : (
        <label className="branch-delete-remote">
          <input type="checkbox" checked={deleteRemote} disabled={unmerged} onChange={(event) => setDeleteRemote(event.target.checked)} />
          {`Also delete ${branch.upstream}`}
        </label>
      )}
      {unmerged ? <p role="alert">{`${branch.name} is not fully merged. Its unmerged commits will be lost.`}</p> : null}
      <Failure text={failure} />
    </Dialog>
  )
}
