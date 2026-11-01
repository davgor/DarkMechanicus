import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import type { BranchInfo, BranchList } from '../../../shared/git/branches'
import type { RepoStatus } from '../../../shared/git/status'
import type { PullRequestSummary } from '../../../shared/github/pullRequests'
import { callGit } from '../api/git'
import { useResource } from '../app/useResource'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { DeleteDialog, NewBranchDialog, RenameDialog, SwitchDialog } from './BranchDialogs'
import { groupBranches } from './branchGroups'
import type { BranchEntry, BranchGroup } from './branchGroups'
import { PullRequestList, filterPullRequests } from './PullRequestList'
import { useGitRun } from './useGitRun'
import type { PullRequestsModel } from './usePullRequests'

/** `switch` lists every branch to check out; `merge` is the picker of a branch to merge into the current one. */
type Mode = 'switch' | 'merge'

type OpenDialog =
  | { kind: 'switch'; target: BranchEntry }
  | { kind: 'pull'; pull: PullRequestSummary }
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
  /** Absent, or not on GitHub: no Branches | Pull requests switch. */
  pullRequests: PullRequestsModel | undefined
  onChoose(entry: BranchEntry): void
  onChoosePull(pull: PullRequestSummary): void
  onNew(): void
  onPickMerge(): void
  onClose(): void
}

type View = 'branches' | 'pulls'

function ViewSwitch({ view, onChange }: { view: View; onChange(view: View): void }): JSX.Element {
  return (
    <div className="ew-toggle branch-view-switch" role="group" aria-label="Branch menu view">
      <button type="button" aria-pressed={view === 'branches'} onClick={() => onChange('branches')}>Branches</button>
      <button type="button" aria-pressed={view === 'pulls'} onClick={() => onChange('pulls')}>Pull requests</button>
    </div>
  )
}

interface ListKeys {
  count: number
  active: number
  setActive(index: number): void
  choose(index: number): void
  onClose(): void
}

/** Arrow keys move the active row, Enter chooses it, Escape closes the popover. */
function listKeys({ count, active, setActive, choose, onClose }: ListKeys) {
  return (event: KeyboardEvent<HTMLElement>): void => {
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 }
    const move = moves[event.key]
    if (move !== undefined) {
      event.preventDefault()
      setActive(Math.max(0, Math.min(count - 1, active + move)))
    } else if (event.key === 'Enter' && active < count) {
      event.preventDefault()
      choose(active)
    } else if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }
}

/** The Pull requests view is offered in the switch popover of a repository on GitHub, signed in or not. */
function pullsOffered(mode: Mode, pullRequests: PullRequestsModel | undefined): pullRequests is PullRequestsModel {
  const kind = pullRequests?.state.kind
  return mode === 'switch' && kind !== undefined && kind !== 'hidden' && kind !== 'loading'
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

interface BodyProps {
  props: PopoverProps
  list: BranchList | null
  groups: BranchGroup[]
  active: number
}

function BranchesBody({ props, list, groups, active }: BodyProps): JSX.Element {
  const { mode, current, actions, onChoose } = props
  return (
    <>
      <BranchGroups groups={groups} active={active} current={current} actions={mode === 'merge' ? null : actions} onChoose={onChoose} />
      {list !== null && groups.every((group) => group.entries.length === 0) ? <p className="muted branch-empty">No branches match</p> : null}
      <PopoverFooter {...props} />
    </>
  )
}

/** The rows the arrow keys move through: the matching branches, or the matching pull requests. */
function rowsOf(props: PopoverProps, pulls: PullRequestsModel | null, entries: BranchEntry[], filter: string): Pick<ListKeys, 'count' | 'choose'> {
  if (pulls === null) {
    return { count: entries.length, choose: (index) => props.onChoose(entries[index]) }
  }
  const rows = pulls.state.kind === 'ready' ? filterPullRequests(pulls.state.open, filter) : []
  return { count: rows.length, choose: (index) => props.onChoosePull(rows[index]) }
}

function Alerts({ messages }: { messages: Array<string | null> }): JSX.Element {
  return <>{messages.map((message, index) => (message === null ? null : <p key={index} role="alert">{message}</p>))}</>
}

function BranchPopover(props: PopoverProps): JSX.Element {
  const { folderPath, mode, current, failure, pullRequests, onChoosePull, onClose } = props
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const [view, setView] = useState<View>('branches')
  const { list, error } = useBranchList(folderPath)
  const offered = pullsOffered(mode, pullRequests)
  const pulls = offered && view === 'pulls' ? pullRequests : null
  const groups = list === null ? [] : groupBranches(list, filter, mode === 'merge')
  const rows = rowsOf(props, pulls, groups.flatMap((group) => group.entries), filter)
  const reset = (next: () => void): void => {
    next()
    setActive(0)
  }
  return (
    <div className="branch-popover" onKeyDown={listKeys({ ...rows, active, setActive, onClose })}>
      {mode === 'merge' ? <div className="branch-popover-title">{`Merge into ${current ?? ''}`}</div> : null}
      {offered ? <ViewSwitch view={view} onChange={(next) => reset(() => setView(next))} /> : null}
      <input className="input" aria-label={pulls === null ? 'Filter branches' : 'Filter pull requests'} placeholder="Filter" autoFocus value={filter} onChange={(event) => reset(() => setFilter(event.target.value))} />
      <Alerts messages={[pulls === null ? error : null, failure]} />
      {pulls === null ? (
        <BranchesBody props={props} list={list} groups={groups} active={active} />
      ) : (
        <PullRequestList state={pulls.state} filter={filter} active={active} onChoose={onChoosePull} onRefresh={pulls.refresh} />
      )}
    </div>
  )
}

interface BranchMenuProps {
  folderPath: string
  status: RepoStatus
  /** The branch as the toolbar names it (also for a detached HEAD or an unborn branch). */
  label: string
  /** The folder's pull requests, for the Pull requests view; absent, the menu has branches only. */
  pullRequests?: PullRequestsModel
  onRefresh(): void
}

function BranchDialog({ dialog, folderPath, status, onClose, onDone }: Pick<BranchMenuProps, 'folderPath' | 'status'> & { dialog: OpenDialog; onClose(): void; onDone(): void }): JSX.Element {
  const base = { folderPath, onClose, onDone }
  switch (dialog.kind) {
    case 'switch':
      return <SwitchDialog {...base} current={status.branch.name ?? 'this commit'} target={{ label: dialog.target.label, name: dialog.target.target }} />
    case 'pull':
      return <SwitchDialog {...base} current={status.branch.name ?? 'this commit'} target={{ label: `#${dialog.pull.number} ${dialog.pull.title}`, pullRequest: dialog.pull.number }} />
    case 'new':
      return <NewBranchDialog {...base} />
    case 'rename':
      return <RenameDialog {...base} from={dialog.from} />
    case 'delete':
      return <DeleteDialog {...base} branch={dialog.branch} />
  }
}

/** The toolbar's "Current branch" button and its popover: switch, create, rename, delete and merge branches, and check out pull requests. */
export function BranchMenu({ folderPath, status, label, pullRequests, onRefresh }: BranchMenuProps): JSX.Element {
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
  const checkoutPull = (pull: PullRequestSummary): void => {
    if (status.files.length > 0) show({ kind: 'pull', pull })
    else run(() => window.git.checkoutPullRequest(folderPath, { number: pull.number, uncommitted: 'bring' }), done)
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
        <BranchPopover key={mode} folderPath={folderPath} mode={mode} current={current} failure={failure} actions={actions} pullRequests={pullRequests}
          onChoose={(entry) => busy || (mode === 'merge' ? merge(entry) : switchTo(entry))} onChoosePull={(pull) => busy || checkoutPull(pull)}
          onNew={() => show({ kind: 'new' })} onPickMerge={() => setMode('merge')} onClose={close}
        />
      )}
      {dialog === null ? null : <BranchDialog dialog={dialog} folderPath={folderPath} status={status} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  )
}
