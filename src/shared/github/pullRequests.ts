/** Pull request types shared by main and the renderer. Renderer-safe: no Node imports. */

export interface PullRequestSummary {
  number: number
  title: string
  /** The author's login. */
  author: string
  isDraft: boolean
  /** `https://github.com/<owner>/<repo>/pull/<number>`, built in main (never taken from GitHub's answer). */
  url: string
  /** ISO 8601. */
  updatedAt: string
  baseRef: string
  headRef: string
  /** `owner/repo` of the head; null when the fork was deleted. */
  headRepoFullName: string | null
  /** The head is in another repository (or a deleted fork): it checks out as `pr/<number>`. */
  fromFork: boolean
}

export interface PullRequestInfo {
  /** The GitHub repository of the upstream's remote, else `origin`; null when it is not on GitHub. */
  repository: { owner: string; repo: string } | null
  /** The open pull request whose head is the current branch in this repository. */
  current: PullRequestSummary | null
  open: PullRequestSummary[]
}

export interface PullRequestsRequest {
  /** Ask GitHub again even when the folder's answer is less than 60 s old. */
  refresh?: boolean
}

export interface CheckoutPullRequestRequest {
  number: number
  /** As for switching branches: stash the changes as `dm-stash:<current branch>`, or bring them along. */
  uncommitted: 'stash' | 'bring'
}

/** GitHub's Create pull request page for the current branch, or `needs_push` while GitHub lacks the branch's commits. */
export type CompareUrl = { kind: 'url'; url: string } | { kind: 'needs_push' }
