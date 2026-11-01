import type { FileChangeKind } from '../../../shared/git/status'

interface Badge {
  letter: string
  label: string
}

const BADGES: Record<FileChangeKind, Badge> = {
  added: { letter: 'A', label: 'Added' },
  modified: { letter: 'M', label: 'Modified' },
  deleted: { letter: 'D', label: 'Deleted' },
  renamed: { letter: 'R', label: 'Renamed' },
  copied: { letter: 'C', label: 'Copied' },
  typechange: { letter: 'U', label: 'Type changed' },
  untracked: { letter: '?', label: 'Untracked' },
  conflicted: { letter: '!', label: 'Conflicted' }
}

/** The one-letter badge of a change and its full word. */
export function badgeOf(kind: FileChangeKind): Badge {
  return BADGES[kind]
}

/** A path split into its directory (with the trailing slash) and file name. */
export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/')
  return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) }
}
