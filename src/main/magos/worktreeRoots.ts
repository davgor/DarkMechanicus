/**
 * Red-team fix 20: workers work in git worktrees outside the chat folder, so the arbiter's `allowedRoots` are the
 * folder's registered worktrees (`git worktree list --porcelain`), canonicalized and cached for 60 s per folder. A
 * worktree git does not list (an unregistered sibling) is never a root, and any failure reads as no extra roots, so a
 * path there stays `outside_folder` for the person.
 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

const CACHE_MS = 60_000
/** The arbiter gate is synchronous on the main thread: a git that hangs is cut off quickly and counts as no roots. */
const GIT_TIMEOUT_MS = 3_000
/** Git variables that would point `git -C <folder>` at another repository. */
const REDIRECTING_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE']

interface WorktreeRootsDeps {
  /** `git worktree list --porcelain` in `folder`; throws when git fails. */
  listPorcelain?: (folder: string) => string
  /** The canonical form of a path; throws when it does not exist. */
  canonical?: (path: string) => string
  now?: () => number
}

function gitPorcelain(folder: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  for (const key of REDIRECTING_ENV) delete env[key]
  return execFileSync('git', ['-C', folder, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
  })
}

/** The canonical worktree paths a porcelain listing names; a path that no longer resolves is dropped. */
function parseRoots(porcelain: string, canonical: (path: string) => string): string[] {
  return porcelain.split(/\r?\n/).flatMap(line => {
    if (!line.startsWith('worktree ')) return []
    try {
      return [canonical(line.slice('worktree '.length))]
    } catch {
      return []
    }
  })
}

/** `rootsOf(folder)`: the folder repository's registered worktrees, canonical, read at most once a minute per folder. */
export function createWorktreeRoots(deps: WorktreeRootsDeps = {}): { rootsOf(folder: string): readonly string[] } {
  const list = deps.listPorcelain ?? gitPorcelain
  const canonical = deps.canonical ?? ((path: string) => realpathSync.native(path))
  const now = deps.now ?? Date.now
  const cache = new Map<string, { at: number; roots: readonly string[] }>()
  return {
    rootsOf: folder => {
      const cached = cache.get(folder)
      if (cached !== undefined && now() - cached.at < CACHE_MS) return cached.roots
      let roots: readonly string[]
      try {
        roots = parseRoots(list(folder), canonical)
      } catch {
        roots = []
      }
      cache.set(folder, { at: now(), roots })
      return roots
    }
  }
}
