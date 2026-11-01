import type { BranchInfo, BranchList } from '../../../shared/git/branches'

/** How many branches the Recent group shows. */
const RECENT_LIMIT = 5

export interface BranchEntry {
  /** What the row shows: the local name, or the name on its remote for a remote-only branch. */
  label: string
  /** The name to give git: `origin/x` for a remote-only branch. */
  target: string
  branch: BranchInfo
}

export interface BranchGroup {
  title: string
  entries: BranchEntry[]
}

/** `x` for `origin/x`; a local branch's own name. */
function shortName(branch: BranchInfo): string {
  return branch.remote === null ? branch.name : branch.name.slice(branch.remote.length + 1)
}

/** Local branches, plus remote-tracking ones that no local branch of the same name shadows. */
function entriesOf(list: BranchList): BranchEntry[] {
  const locals = new Set(list.branches.filter((branch) => branch.kind === 'local').map((branch) => branch.name))
  return list.branches
    .filter((branch) => branch.kind === 'local' || !locals.has(shortName(branch)))
    .map((branch) => ({ label: shortName(branch), target: branch.name, branch }))
}

function remoteGroups(entries: readonly BranchEntry[]): BranchGroup[] {
  const groups = new Map<string, BranchEntry[]>()
  for (const entry of entries) {
    const remote = entry.branch.remote ?? ''
    groups.set(remote, [...(groups.get(remote) ?? []), entry])
  }
  return [...groups].map(([title, members]) => ({ title, entries: members.sort((a, b) => a.label.localeCompare(b.label)) }))
}

/**
 * The menu's groups: Default branch, the 5 most recent other local branches, the remaining local ones, then
 * each remote's remote-only branches. A filter keeps the names containing it (any case); empty groups are dropped.
 */
export function groupBranches(list: BranchList, filter: string, withoutCurrent: boolean): BranchGroup[] {
  const needle = filter.trim().toLowerCase()
  const entries = entriesOf(list).filter(
    (entry) => entry.label.toLowerCase().includes(needle) && !(withoutCurrent && entry.branch.isCurrent)
  )
  const isDefault = (entry: BranchEntry): boolean => entry.label === list.defaultBranch
  const defaults = entries.filter(isDefault).sort((a, b) => Number(b.branch.kind === 'local') - Number(a.branch.kind === 'local'))
  const locals = entries.filter((entry) => entry.branch.kind === 'local' && !isDefault(entry)).sort((a, b) => b.branch.lastCommitAt.localeCompare(a.branch.lastCommitAt))
  const remotes = entries.filter((entry) => entry.branch.kind === 'remote' && !isDefault(entry))
  const groups = [
    { title: 'Default branch', entries: defaults.slice(0, 1) },
    { title: 'Recent branches', entries: locals.slice(0, RECENT_LIMIT) },
    { title: 'Other branches', entries: locals.slice(RECENT_LIMIT).sort((a, b) => a.label.localeCompare(b.label)) },
    ...remoteGroups(remotes)
  ]
  return groups.filter((group) => group.entries.length > 0)
}
