import type { GithubRepository } from '../../../shared/github/api'

/** The folder name a clone source suggests: its last path segment without `.git` (`owner/repo` gives `repo`). */
export function repositoryName(source: string): string {
  // The scheme and host never name the repository: `https://github.com/` suggests nothing.
  const path = source.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/[/\\]+$/, '')
  const last = path.split(/[/\\:]/).at(-1) ?? ''
  return last.replace(/\.git$/i, '')
}

/** Where a clone named `name` lands under `parent`, joined with the separator the parent already uses. */
export function targetPath(parent: string, name: string): string {
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return `${parent.replace(/[/\\]+$/, '')}${separator}${name}`
}

/** Whether a repository's `owner/name` holds the filter, ignoring case; a blank filter matches everything. */
export function matchesFilter(repository: GithubRepository, filter: string): boolean {
  return repository.fullName.toLowerCase().includes(filter.trim().toLowerCase())
}

interface OwnerGroup {
  owner: string
  repositories: GithubRepository[]
}

/** Repositories grouped by owner, owners in the order they first appear and repositories in their given order. */
export function groupByOwner(repositories: readonly GithubRepository[]): OwnerGroup[] {
  const groups = new Map<string, GithubRepository[]>()
  for (const repository of repositories) {
    const group = groups.get(repository.owner)
    if (group === undefined) groups.set(repository.owner, [repository])
    else group.push(repository)
  }
  return Array.from(groups, ([owner, list]) => ({ owner, repositories: list }))
}
