import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fail } from '../errors'
import { nodeFs } from './nodeFs'
import type { FsAdapter, GitAdapter, GitHead } from './types'

type RunGit = (args: string[]) => Promise<{ code: number; stdout: string }>

const HEADS_PREFIX = 'refs/heads/'
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
/** Local branch refs git itself would accept (no traversal, whitespace, or special characters). */
const BRANCH_REF_PATTERN = /^refs\/heads\/(?!.*\.\.)(?!.*\/\/)[^\s~^:?*[\\\u0000-\u001f\u007f]+$/
const MAX_GIT_FILE_BYTES = 1024 * 1024
const MAX_PACKED_REFS_BYTES = 16 * 1024 * 1024
const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
/** Variables that would point git at another repository than the one we pass with -C. */
const REDIRECTING_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE'
]

/** Reads a small metadata file; null when missing, empty/special (size 0), oversized, or unreadable. */
function readSmall(fs: FsAdapter, path: string, limit: number): string | null {
  const size = fs.fileSize(path)
  if (size <= 0 || size > limit) {
    return null
  }
  try {
    return fs.readFile(path)
  } catch {
    return null
  }
}

function resolveGitDir(fs: FsAdapter, root: string): string | null {
  const dotGit = join(root, '.git')
  if (fs.isDirectory(dotGit)) {
    return dotGit
  }
  const pointer = readSmall(fs, dotGit, MAX_GIT_FILE_BYTES)
  const target = pointer === null ? undefined : /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1]
  return target === undefined ? null : resolve(root, target)
}

function commonDirOf(fs: FsAdapter, gitDir: string): string | null {
  const text = readSmall(fs, join(gitDir, 'commondir'), MAX_GIT_FILE_BYTES)?.trim()
  return text ? resolve(gitDir, text) : null
}

function looseRef(fs: FsAdapter, dir: string, ref: string): string | null {
  const text = readSmall(fs, join(dir, ...ref.split('/')), MAX_GIT_FILE_BYTES)?.trim() ?? ''
  return SHA_PATTERN.test(text) ? text : null
}

function packedRef(fs: FsAdapter, dir: string, ref: string): string | null {
  const text = readSmall(fs, join(dir, 'packed-refs'), MAX_PACKED_REFS_BYTES) ?? ''
  for (const line of text.split(/\r?\n/)) {
    const [sha, name] = line.split(' ')
    if (name === ref && sha !== undefined && SHA_PATTERN.test(sha)) {
      return sha
    }
  }
  return null
}

function resolveRef(fs: FsAdapter, gitDir: string, ref: string): string | null {
  const dirs = [gitDir, commonDirOf(fs, gitDir)].filter((dir): dir is string => dir !== null)
  for (const dir of dirs) {
    const found = looseRef(fs, dir, ref) ?? packedRef(fs, dir, ref)
    if (found !== null) {
      return found
    }
  }
  return null
}

function parseHead(fs: FsAdapter, gitDir: string, head: string): GitHead {
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1] ?? ''
  if (BRANCH_REF_PATTERN.test(ref)) {
    return { branch: ref.slice(HEADS_PREFIX.length), commit: resolveRef(fs, gitDir, ref), detached: false }
  }
  return { branch: null, commit: SHA_PATTERN.test(head) ? head : null, detached: true }
}

function readGitHead(fs: FsAdapter, root: string): GitHead | null {
  const gitDir = resolveGitDir(fs, root)
  const head = gitDir === null ? null : readSmall(fs, join(gitDir, 'HEAD'), MAX_GIT_FILE_BYTES)
  if (gitDir === null || head === null) {
    return null
  }
  return parseHead(fs, gitDir, head.trim())
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  for (const key of REDIRECTING_ENV) {
    delete env[key]
  }
  return env
}

function defaultRunGit(root: string): RunGit {
  return (args) =>
    new Promise((settle) => {
      execFile(
        'git',
        ['-C', root, ...args],
        { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: gitEnv(), windowsHide: true },
        (error, stdout) => settle({ code: error ? 1 : 0, stdout })
      )
    })
}

/** Refs and paths become git arguments: refuse anything git could read as an option. */
function safeArg(value: string): string {
  if (value.startsWith('-') || value.includes('\u0000')) {
    fail('unsafe_path', 'Refusing to pass an option-like or NUL-containing value to git.')
  }
  return value
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line !== '')
}

/**
 * Git access for one repository root. `head()` reads `.git` files directly (worktrees included);
 * the other methods run the git CLI and degrade to null/empty results when git is unavailable.
 */
export function createGitAdapter(root: string, options: { fs?: FsAdapter; runGit?: RunGit } = {}): GitAdapter {
  const fs = options.fs ?? nodeFs
  const run = options.runGit ?? defaultRunGit(root)
  const output = async (args: string[]): Promise<string | null> => {
    const result = await run(args)
    return result.code === 0 ? result.stdout : null
  }
  return {
    head: () => readGitHead(fs, root),
    countUncommitted: async (pathspec) => {
      const status = await output(['status', '--porcelain=v1', '-uall', '--', safeArg(pathspec)])
      return status === null ? null : lines(status).length
    },
    listLocalBranches: async () => lines((await output(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])) ?? ''),
    listFiles: async (ref, pathspec) =>
      lines((await output(['ls-tree', '-r', '--name-only', safeArg(ref), '--', safeArg(pathspec)])) ?? ''),
    showFile: async (ref, path) => output(['show', `${safeArg(ref)}:./${safeArg(path)}`])
  }
}
