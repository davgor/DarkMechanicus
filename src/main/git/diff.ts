/** Reads one file's working-tree diff against HEAD, never running a configured external diff or textconv driver. */
import type { FileDiff } from '../../shared/git/diff'
import type { FileChange } from '../../shared/git/status'
import { GitError } from './errors'
import { parseUnifiedDiff } from './diffParser'
import type { GitRunner } from './runner'

export const DIFF_LIMIT_BYTES = 2 * 1024 * 1024
export const FORCED_DIFF_LIMIT_BYTES = 16 * 1024 * 1024

interface ReadDiffOptions {
  /** Raises the size limit from 2 MiB to 16 MiB. */
  force?: boolean
}

const SAFE_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color']

async function hasCommit(runner: GitRunner, root: string): Promise<boolean> {
  const result = await runner.run({ cwd: root, args: ['rev-parse', '--verify', '--quiet', 'HEAD'], kind: 'read', acceptExitCodes: [0, 1] })
  return result.code === 0
}

export async function readWorkingDiff(runner: GitRunner, root: string, change: FileChange, options: ReadDiffOptions = {}): Promise<FileDiff> {
  const limit = options.force === true ? FORCED_DIFF_LIMIT_BYTES : DIFF_LIMIT_BYTES
  const againstNothing = change.kind === 'untracked' || !(await hasCommit(runner, root))
  const paths = change.oldPath === null ? [change.path] : [change.oldPath, change.path]
  const args = againstNothing
    ? ['diff', '--no-index', ...SAFE_FLAGS, '--', '/dev/null', change.path]
    : ['diff', ...SAFE_FLAGS, '--find-renames', 'HEAD', '--', ...paths]
  try {
    // `--no-index` exits with 1 when the files differ.
    const result = await runner.run({ cwd: root, args, kind: 'read', maxOutputBytes: limit, acceptExitCodes: againstNothing ? [0, 1] : [0] })
    return { ...parseUnifiedDiff(result.stdout), path: change.path, oldPath: change.oldPath }
  } catch (error) {
    if (error instanceof GitError && error.code === 'output_too_large') {
      return { kind: 'too_large', bytes: limit, path: change.path, oldPath: change.oldPath, oldMode: null, newMode: null, hash: '' }
    }
    throw error
  }
}
