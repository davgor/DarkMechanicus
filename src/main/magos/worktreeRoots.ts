/**
 * Red-team fix 20: workers work in git worktrees outside the chat folder, so the arbiter's `allowedRoots` are the
 * folder's place in each registered worktree (`git worktree list --porcelain`), canonicalized and cached for 60 s per
 * folder. A tracked subfolder (`repo/sub`) allows only `sub` in each worktree, never a worktree's whole root. A worktree
 * git does not list (an unregistered sibling) is never a root, and any failure reads as no extra roots, so a path there
 * stays `outside_folder` for the person. Git and the disk are read asynchronously: the main thread never waits on them.
 */
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const CACHE_MS = 60_000
/** A git that hangs is cut off and counts as no roots, so a prompt waiting on it goes to the person. */
const GIT_TIMEOUT_MS = 3_000
/** Git variables that would point `git -C <folder>` at another repository. */
const REDIRECTING_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE']

const execFileAsync = promisify(execFile)
const realpathNative = promisify(realpath.native)

interface WorktreeRootsDeps {
  /** `git worktree list --porcelain` in `folder`; rejects when git fails. */
  listPorcelain?: (folder: string) => Promise<string>
  /** The canonical form of a path; rejects when it does not exist. */
  canonical?: (path: string) => Promise<string>
  now?: () => number
}

async function gitPorcelain(folder: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  for (const key of REDIRECTING_ENV) delete env[key]
  const { stdout } = await execFileAsync('git', ['-C', folder, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env, windowsHide: true
  })
  return stdout
}

/** The canonical path, or null when it does not resolve. */
async function resolved(path: string, canonical: (path: string) => Promise<string>): Promise<string | null> {
  try {
    return await canonical(path)
  } catch {
    return null
  }
}

/** The canonical worktree paths a porcelain listing names; a path that no longer resolves is dropped. */
async function worktreesOf(porcelain: string, canonical: (path: string) => Promise<string>): Promise<string[]> {
  const listed = porcelain.split(/\r?\n/).flatMap(line => line.startsWith('worktree ') ? [line.slice('worktree '.length)] : [])
  const paths = await Promise.all(listed.map(path => resolved(path, canonical)))
  return paths.filter(path => path !== null)
}

/** `folder` relative to the deepest worktree holding it, or null when none holds it. */
function placeIn(worktrees: readonly string[], folder: string): string | null {
  let best: { depth: number; sub: string } | null = null
  for (const worktree of worktrees) {
    const sub = relative(worktree, folder)
    if (sub === '..' || sub.startsWith(`..${sep}`) || isAbsolute(sub)) continue
    if (best === null || worktree.length > best.depth) best = { depth: worktree.length, sub }
  }
  return best?.sub ?? null
}

/** The folder's canonical place in each registered worktree of its repository; a place that does not exist is dropped. */
async function readRoots(folder: string, list: (folder: string) => Promise<string>, canonical: (path: string) => Promise<string>): Promise<readonly string[]> {
  const [porcelain, own] = await Promise.all([list(folder), resolved(folder, canonical)])
  if (own === null) return []
  const worktrees = await worktreesOf(porcelain, canonical)
  const sub = placeIn(worktrees, own)
  if (sub === null) return []
  if (sub === '') return worktrees
  const places = await Promise.all(worktrees.map(worktree => resolved(join(worktree, sub), canonical)))
  return places.filter(place => place !== null)
}

/** `rootsOf(folder)`: the folder's place in its repository's registered worktrees, canonical, read at most once a minute per folder. */
export function createWorktreeRoots(deps: WorktreeRootsDeps = {}): { rootsOf(folder: string): Promise<readonly string[]> } {
  const list = deps.listPorcelain ?? gitPorcelain
  const canonical = deps.canonical ?? realpathNative
  const now = deps.now ?? Date.now
  const cache = new Map<string, { at: number; roots: Promise<readonly string[]> }>()
  return {
    rootsOf: folder => {
      const cached = cache.get(folder)
      if (cached !== undefined && now() - cached.at < CACHE_MS) return cached.roots
      // One read per folder at a time: concurrent prompts share it.
      const roots = readRoots(folder, list, canonical).catch(() => [])
      cache.set(folder, { at: now(), roots })
      return roots
    }
  }
}
