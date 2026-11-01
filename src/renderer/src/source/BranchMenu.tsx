import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import type { BranchInfo, BranchList } from '../../../shared/git/branches'
import type { RepoStatus } from '../../../shared/git/status'
import { callGit } from '../api/git'
import { useResource } from '../app/useResource'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { DeleteDialog, NewBranchDialog, RenameDialog, SwitchDialog } from './BranchDialogs'
import { groupBranches } from './branchGroups'
import type { BranchEntry, BranchGroup } from './branchGroups'
import { useGitRun } from './useGitRun'

/** `switch` lists every branch to check out; `merge` is the picker of a branch to merge into the current one. */
type Mode = 'switch' | 'merge'

type OpenDialog =
  | { kind: 'switch'; target: BranchEntry }
  | { kind: 'new' }
  | { kind: 'rename'; from: string }
  | { kind: 'delete'; branch: BranchInfo }

interface RowActions {
  rename(branch: BranchInfo): void
  remove(branch: BranchInfo): void
  merge(entry: BranchEntry): void
}

/** Closes the popover on a press outside it. */
function useOutsidePress(anchor: RefObject<HTMLElement>, onOutside: () => void): void {
  useEffect(() => {
    const onPress = (event: MouseEvent): void => {
      if (!(event.target instanceof Node && anchor.current?.contains(event.target))) onOutside()
    }
    document.addEventListener('mousedown', onPress)
    return () => document.removeEventListener('mousedown', onPress)
  }, [anchor, onOutside])
}

function RowMenu({ entry, current, actions }: { entry: BranchEntry; current: string | null; actions: RowActions }): JSX.Element {
  const { branch } = entry
  const items = [
    ...(branch.kind === 'local' ? [{ label: 'Rename…', onSelect: () => actions.rename(branch) }] : []),
    ...(branch.kind === 'local' && !branch.isCurrent ? [{ label: 'Delete…', onSelect: () => actions.remove(branch) }] : []),
    ...(current !== null && !branch.isCurrent ? [{ label: `Merge into ${current}`, onSelect: () => actions.merge(entry) }] : [])
  ]
  return (
    <div className="menu branch-row-menu" role="menu" aria-label={`${entry.label} actions`}>
      {items.map((item) => (
        <button key={item.label} type="button" role="menuitem" className="menu-item" onClick={item.onSelect}>
          {item.label}
        </button>
      ))}
    </div>
  )
}

interface GroupsProps {
  groups: BranchGroup[]
  active: number
  current: string | null
  /** Null in the merge picker, which has no row menu. */
  actions: RowActions | null
  onChoose(entry: BranchEntry): void
}

function BranchGroups({ groups, active, current, actions, onChoose }: GroupsProps): JSX.Element {
  const [menuFor, setMenuFor] = useState<string | null>(null)
  let index = -1
  return (
    <div className="branch-list" role="listbox" aria-label="Branches">
      {groups.map((group) => (
        <div key={group.title} role="group" aria-label={group.title}>
          <div className="branch-group-title" aria-hidden="true">{group.title}</div>
          {group.entries.map((entry) => {
            index += 1
            return (
              <div key={entry.target} className="branch-row-wrap">
                <div role="option" aria-selected={index === active} className="branch-row mono" onClick={() => onChoose(entry)}
                  ref={index === active ? (row) => row?.scrollIntoView?.({ block: 'nearest' }) : undefined}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setMenuFor(actions === null ? null : entry.target)
                  }}
                >
                  {entry.branch.isCurrent ? <Icon name="check" /> : null}
                  {entry.label}
                </div>
                {actions !== null && menuFor === entry.target ? <RowMenu entry={entry} current={current} actions={actions} /> : null}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

interface PopoverProps {
  folderPath: string
  mode: Mode
  current: string | null
  failure: string | null
  actions: RowActions
  onChoose(entry: BranchEntry): void
  onNew(): void
  onPickMerge(): void
  onClose(): void
}

function useBranchList(folderPath: string): { list: BranchList | null; error: string | null } {
  const [error, setError] = useState<string | null>(null)
  const list = useResource<BranchList>({
    key: folderPath,
    version: 0,
    load: () => callGit(window.git.listBranches(folderPath)),
    onError: (failure) => setError(failure instanceof Error ? failure.message : 'Git did not answer.')
  })
  return { list: list.status === 'ready' ? list.value : null, error }
}

function PopoverFooter({ mode, current, onNew, onPickMerge }: Pick<PopoverProps, 'mode' | 'current' | 'onNew' | 'onPickMerge'>): JSX.Element | null {
  if (mode === 'merge') return null
  return (
    <div className="branch-popover-footer">
      <Button size="sm" variant="primary" onClick={onNew}>New branch</Button>
      {current === null ? null : <Button size="sm" onClick={onPickMerge}>{`Choose a branch to merge into ${current}…`}</Button>}
    </div>
  )
}

function BranchPopover(props: PopoverProps): JSX.Element {
  const { folderPath, mode, current, failure, actions, onChoose, onClose } = props
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const { list, error } = useBranchList(folderPath)
  const groups = list === null ? [] : groupBranches(list, filter, mode === 'merge')
  const entries = groups.flatMap((group) => group.entries)
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 }
    const move = moves[event.key]
    if (move !== undefined) {
      event.preventDefault()
      setActive(Math.max(0, Math.min(entries.length - 1, active + move)))
    } else if (event.key === 'Enter' && entries[active] !== undefined) {
      event.preventDefault()
      onChoose(entries[active])
    } else if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }
  return (
    <div className="branch-popover" onKeyDown={onKeyDown}>
      {mode === 'merge' ? <div className="branch-popover-title">{`Merge into ${current ?? ''}`}</div> : null}
      <input className="input" aria-label="Filter branches" placeholder="Filter" autoFocus value={filter}
        onChange={(event) => {
          setFilter(event.target.value)
          setActive(0)
        }}
      />
      {error === null ? null : <p role="alert">{error}</p>}
      {failure === null ? null : <p role="alert">{failure}</p>}
      <BranchGroups groups={groups} active={active} current={current} actions={mode === 'merge' ? null : actions} onChoose={onChoose} />
      {list !== null && entries.length === 0 ? <p className="muted branch-empty">No branches match</p> : null}
      <PopoverFooter {...props} />
    </div>
  )
}

interface BranchMenuProps {
  folderPath: string
  status: RepoStatus
  /** The branch as the toolbar names it (also for a detached HEAD or an unborn branch). */
  label: string
  onRefresh(): void
}

function BranchDialog({ dialog, folderPath, status, onClose, onDone }: Omit<BranchMenuProps, 'label' | 'onRefresh'> & { dialog: OpenDialog; onClose(): void; onDone(): void }): JSX.Element {
  const base = { folderPath, onClose, onDone }
  switch (dialog.kind) {
    case 'switch':
      return <SwitchDialog {...base} current={status.branch.name ?? 'this commit'} target={{ label: dialog.target.label, name: dialog.target.target }} />
    case 'new':
      return <NewBranchDialog {...base} />
    case 'rename':
      return <RenameDialog {...base} from={dialog.from} />
    case 'delete':
      return <DeleteDialog {...base} branch={dialog.branch} />
  }
}

/** The toolbar's "Current branch" button and its popover: switch, create, rename, delete and merge branches. */
export function BranchMenu({ folderPath, status, label, onRefresh }: BranchMenuProps): JSX.Element {
  const anchor = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<Mode | null>(null)
  const [dialog, setDialog] = useState<OpenDialog | null>(null)
  const { busy, failure, run } = useGitRun()
  const current = status.branch.name
  const close = (): void => setMode(null)
  useOutsidePress(anchor, close)
  const done = (): void => {
    setDialog(null)
    setMode(null)
    onRefresh()
  }
  const show = (next: OpenDialog): void => {
    setMode(null)
    setDialog(next)
  }
  // A conflicted merge is left in progress; reading the state again lets the conflict view take over.
  const merge = (entry: BranchEntry): void =>
    run(() => window.git.mergeIntoCurrent(folderPath, { branch: entry.target }), done, (error) => {
      if (error.code === 'merge_conflicts') done()
      return error.code === 'merge_conflicts'
    })
  const switchTo = (entry: BranchEntry): void => {
    if (entry.branch.isCurrent) close()
    else if (status.files.length > 0) show({ kind: 'switch', target: entry })
    else run(() => window.git.switchBranch(folderPath, { name: entry.target, uncommitted: 'bring' }), done)
  }
  const actions: RowActions = { rename: (branch) => show({ kind: 'rename', from: branch.name }), remove: (branch) => show({ kind: 'delete', branch }), merge }
  return (
    <div className="branch-menu" ref={anchor}>
      <button type="button" className="branch-button" aria-haspopup="listbox" aria-expanded={mode !== null} onClick={() => setMode(mode === null ? 'switch' : null)}>
        <span className="branch-button-caption muted">Current branch</span>
        <span className="branch-button-name mono">{label}</span>
        <Icon name="chevron-down" />
      </button>
      {mode === null ? null : (
        <BranchPopover key={mode} folderPath={folderPath} mode={mode} current={current} failure={failure} actions={actions}
          onChoose={(entry) => busy || (mode === 'merge' ? merge(entry) : switchTo(entry))} onNew={() => show({ kind: 'new' })} onPickMerge={() => setMode('merge')} onClose={close}
        />
      )}
      {dialog === null ? null : <BranchDialog dialog={dialog} folderPath={folderPath} status={status} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  )
}
