import type { PullRequestSummary } from '../../../shared/github/pullRequests'
import { Button } from '../components/Button'
import { formatAgo } from '../epic/time'
import { SignInPrompt } from '../github/SignInPrompt'
import { DraftBadge } from './PullRequestBadge'
import type { PullRequestsState } from './usePullRequests'

/** The pull requests whose number (`7` or `#7`), title, author or branch contains the filter, ignoring case. */
export function filterPullRequests(open: PullRequestSummary[], filter: string): PullRequestSummary[] {
  const needle = filter.trim().toLowerCase().replace(/^#/, '')
  if (needle === '') return open
  return open.filter((pull) => [String(pull.number), pull.title, pull.author, pull.headRef].some((text) => text.toLowerCase().includes(needle)))
}

interface PullRequestListProps {
  state: PullRequestsState
  filter: string
  active: number
  onChoose(pull: PullRequestSummary): void
  onRefresh(): void
}

function PullRequestRow({ pull, active, onChoose }: { pull: PullRequestSummary; active: boolean; onChoose(): void }): JSX.Element {
  return (
    <div role="option" aria-selected={active} className="branch-row pr-row" onClick={onChoose} ref={active ? (row) => row?.scrollIntoView?.({ block: 'nearest' }) : undefined}>
      <span className="pr-row-title">
        <span className="mono">{`#${pull.number}`}</span> {pull.title}
        {pull.isDraft ? <> <DraftBadge /></> : null}
        {pull.fromFork ? <> <span className="pr-fork" title={pull.headRepoFullName ?? 'Deleted fork'}>Fork</span></> : null}
      </span>
      <span className="pr-row-meta muted">{`${pull.author} · ${formatAgo(pull.updatedAt, Date.now())}`}</span>
    </div>
  )
}

/** The branch menu's Pull requests view: the open pull requests that match the filter, or why there are none. */
export function PullRequestList({ state, filter, active, onChoose, onRefresh }: PullRequestListProps): JSX.Element {
  if (state.kind === 'signed-out') {
    return <SignInPrompt purpose="see pull requests" />
  }
  const pulls = state.kind === 'ready' ? filterPullRequests(state.open, filter) : []
  const empty = state.kind === 'ready' && pulls.length === 0
  return (
    <>
      <div className="pr-list-head">
        <span className="muted">{state.kind === 'loading' ? 'Loading pull requests…' : 'Open pull requests'}</span>
        <Button size="sm" onClick={onRefresh}>Refresh</Button>
      </div>
      {state.kind === 'error' ? <p role="alert">{state.message}</p> : null}
      <div className="branch-list" role="listbox" aria-label="Pull requests">
        {pulls.map((pull, index) => (
          <PullRequestRow key={pull.number} pull={pull} active={index === active} onChoose={() => onChoose(pull)} />
        ))}
      </div>
      {empty ? <p className="muted branch-empty">{state.open.length === 0 ? 'No open pull requests' : 'No pull requests match'}</p> : null}
    </>
  )
}
