import { useEffect, useState } from 'react'
import type { RepoStatus } from '../../../shared/git/status'
import type { CompareUrl, PullRequestSummary } from '../../../shared/github/pullRequests'
import { callGit } from '../api/git'
import { useResource } from '../app/useResource'
import { Button } from '../components/Button'
import { useGithub } from '../github/GithubAccount'
import type { PullRequestsModel } from './usePullRequests'
import { attempt } from './useSync'

interface PullRequestBadgeProps {
  folderPath: string
  status: RepoStatus
  pullRequests: PullRequestsModel
  /** Reads the repository state again, after a push. */
  onRefresh(): void
}

interface PushProgress {
  id: string
  phase: string | null
  percent: number | null
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : 'Git did not answer.')

export function DraftBadge(): JSX.Element {
  return <span className="pr-draft">Draft</span>
}

function CurrentPullRequest({ pull }: { pull: PullRequestSummary }): JSX.Element {
  return (
    <button type="button" className="pr-pill" title={`Open #${pull.number} on GitHub`} onClick={() => void window.dm.openExternal(pull.url)}>
      <span className="pr-number mono">{`#${pull.number}`}</span> <span className="pr-title">{pull.title}</span>
      {pull.isDraft ? <> <DraftBadge /></> : null}
    </button>
  )
}

/** The default branch and GitHub's compare page for the branch as it is now. */
function useCompareTarget(folderPath: string, status: RepoStatus): { defaultBranch: string | null; compare: CompareUrl } | null {
  const { name, upstream, ahead, headOid } = status.branch
  const target = useResource({
    key: [folderPath, name, upstream, ahead, headOid].join('\u0000'),
    version: 0,
    load: async () => {
      const [list, compare] = await Promise.all([callGit(window.git.listBranches(folderPath)), callGit(window.git.getCompareUrl(folderPath))])
      return { defaultBranch: list.defaultBranch, compare }
    },
    onError: () => undefined
  })
  return target.status === 'ready' ? target.value : null
}

/** Opens the compare page; for `needs_push` pushes (or publishes) the branch first, showing its progress. */
function useCreatePullRequest(folderPath: string, onRefresh: () => void): { progress: PushProgress | null; failure: string | null; create(compare: CompareUrl): void } {
  const [progress, setProgress] = useState<PushProgress | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(
    () =>
      window.git.onProgress((event) => {
        setProgress((previous) => (previous === null || previous.id !== event.operationId || event.folder !== folderPath ? previous : { ...previous, phase: event.phase, percent: event.percent }))
      }),
    [folderPath]
  )
  const openCompare = (): void => {
    callGit(window.git.getCompareUrl(folderPath)).then(
      (compare) => (compare.kind === 'url' ? void window.dm.openExternal(compare.url) : setFailure('GitHub does not have this branch’s commits yet.')),
      (error: unknown) => setFailure(errorText(error))
    )
  }
  const create = (compare: CompareUrl): void => {
    if (progress !== null) return
    setFailure(null)
    if (compare.kind === 'url') {
      void window.dm.openExternal(compare.url)
      return
    }
    const id = crypto.randomUUID()
    setProgress({ id, phase: null, percent: null })
    void attempt(folderPath, 'push', id).then((error) => {
      setProgress(null)
      onRefresh()
      if (error === null) openCompare()
      else if (error.code !== 'cancelled') setFailure(error.message)
    })
  }
  return { progress, failure, create }
}

function progressText(progress: PushProgress): string {
  const percent = progress.percent === null ? '' : ` ${progress.percent}%`
  return `Pushing… ${progress.phase ?? ''}${percent}`.trim()
}

function CreatePullRequest({ folderPath, status, onRefresh }: Omit<PullRequestBadgeProps, 'pullRequests'>): JSX.Element | null {
  const target = useCompareTarget(folderPath, status)
  const { progress, failure, create } = useCreatePullRequest(folderPath, onRefresh)
  if (target === null || status.branch.name === target.defaultBranch) {
    return null
  }
  const label = target.compare.kind === 'needs_push' ? 'Push and create pull request' : 'Create pull request'
  return (
    <span className="pr-create">
      <Button size="sm" busy={progress !== null} onClick={() => create(target.compare)}>{label}</Button>
      {progress === null ? null : <span role="status" className="muted">{progressText(progress)}</span>}
      {failure === null ? null : <span role="alert" className="pr-failure">{failure}</span>}
    </span>
  )
}

/**
 * The toolbar's pull request: `#N Title` for the branch's open one, else Create pull request on a branch other than
 * the default; signed out, a link to sign in. Nothing for a repository that is not on GitHub.
 */
export function PullRequestBadge({ folderPath, status, pullRequests, onRefresh }: PullRequestBadgeProps): JSX.Element | null {
  const { openSignIn } = useGithub()
  const { state } = pullRequests
  if (state.kind === 'signed-out') {
    return (
      <button type="button" className="pr-sign-in" onClick={openSignIn}>
        Sign in to see pull requests
      </button>
    )
  }
  if (state.kind !== 'ready') {
    return null
  }
  if (state.current !== null) {
    return <CurrentPullRequest pull={state.current} />
  }
  if (status.branch.name === null || status.branch.headOid === null) {
    return null
  }
  return <CreatePullRequest folderPath={folderPath} status={status} onRefresh={onRefresh} />
}
