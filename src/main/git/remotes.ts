/** A repository's remotes, which of them fetch, pull and push use, and which ones are on GitHub. */
import { GitError } from './errors'
import type { GitRunner } from './runner'

interface GitRemote {
  name: string
  fetchUrl: string
  pushUrl: string
}

/** A remote line of `git remote -v`: name, tab, URL, then `(fetch)` or `(push)`. */
const REMOTE_LINE = /^(\S+)\t(.*) \((fetch|push)\)$/

/** The remotes of `root`, in git's order, from `git remote -v` (URLs after `insteadOf` rewriting). */
export async function listRemotes(runner: GitRunner, root: string): Promise<GitRemote[]> {
  const { stdout } = await runner.run({ cwd: root, args: ['remote', '-v'], kind: 'read' })
  const remotes = new Map<string, GitRemote>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = REMOTE_LINE.exec(line)
    if (match === null) {
      continue
    }
    const [, name, url, direction] = match
    const remote = remotes.get(name) ?? { name, fetchUrl: url, pushUrl: url }
    if (direction === 'fetch') {
      remote.fetchUrl = url
    } else {
      remote.pushUrl = url
    }
    remotes.set(name, remote)
  }
  return [...remotes.values()]
}

/** A GitHub owner or repository name: letters, digits, `-`, `_` and `.`, but not `.` or `..` alone. */
const NAME = '[A-Za-z0-9_.-]+'
const GITHUB_URLS = [
  new RegExp(`^https://(?:[^@/]+@)?github\\.com/(${NAME})/(${NAME})/?$`, 'i'),
  new RegExp(`^git@github\\.com:(${NAME})/(${NAME})/?$`, 'i'),
  new RegExp(`^ssh://git@github\\.com(?::\\d+)?/(${NAME})/(${NAME})/?$`, 'i')
]

/** `{ owner, repo }` for an https, scp-like or ssh github.com URL, with or without `.git`; null for anything else. Pure. */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const match = GITHUB_URLS.map((pattern) => pattern.exec(url)).find((found) => found !== null)
  if (match === undefined || match === null) {
    return null
  }
  const owner = match[1]
  const repo = match[2].replace(/\.git$/i, '')
  return [owner, repo].some((part) => part === '' || part === '.' || part === '..') ? null : { owner, repo }
}

export interface SyncRemote {
  /** Where fetch and pull go: the upstream's remote, else `origin`. */
  remote: GitRemote
  /** The upstream branch on that remote (`refs/heads/main`), or null when the branch has none. */
  upstreamRef: string | null
  /** Where push goes: git's own push remote (`branch.<name>.pushRemote`, `remote.pushDefault`), else `remote`. */
  pushRemote: GitRemote
}

interface BranchRemotes {
  upstream: { remote: string; ref: string } | null
  push: string
}

/** The current branch's upstream and push remote, from `for-each-ref` (remote names may hold `/`). */
async function readBranchRemotes(runner: GitRunner, root: string, branch: string | null): Promise<BranchRemotes> {
  if (branch === null) {
    return { upstream: null, push: '' }
  }
  const { stdout } = await runner.run({
    cwd: root,
    args: ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(push:remotename)', '--', `refs/heads/${branch}`],
    kind: 'read'
  })
  const [remote = '', ref = '', push = ''] = stdout.replace(/\r?\n$/, '').split('\0')
  return { upstream: remote === '' || ref === '' ? null : { remote, ref }, push }
}

/** The remotes fetch, pull and push use for the current branch; `remote_not_found` with neither an upstream nor origin. */
export async function resolveSyncRemote(runner: GitRunner, root: string, branch: string | null): Promise<SyncRemote> {
  const remotes = await listRemotes(runner, root)
  const named = (name: string | undefined): GitRemote | undefined => remotes.find((remote) => remote.name === name)
  const { upstream, push } = await readBranchRemotes(runner, root, branch)
  const tracked = named(upstream?.remote)
  const remote = tracked ?? named('origin')
  if (remote === undefined) {
    throw new GitError('remote_not_found', '', 'This repository has no upstream remote and no origin.')
  }
  return { remote, upstreamRef: tracked === undefined || upstream === null ? null : upstream.ref, pushRemote: named(push) ?? remote }
}
