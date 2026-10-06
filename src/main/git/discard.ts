/** Discards changes. Whatever is thrown away is moved to the OS trash first, so nothing is lost for good. */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { FileChange, RepoState } from '../../shared/git/status'
import { pathArgs } from './args'
import { checkPaths, findInStatus, requireStatus } from './commit'
import { GitInputError } from './errors'
import type { GitRunner } from './runner'
import { readRepoState } from './status'

export type TrashItem = (path: string) => Promise<void>

interface DiscardInput {
  files: readonly FileChange[]
}

/** Moves a copy of the working file to the trash, so the original can then be overwritten by git. */
async function trashCopy(trashItem: TrashItem, file: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dm-discard-'))
  try {
    const copy = join(dir, basename(file))
    copyFileSync(file, copy)
    await trashItem(copy)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function discardFiles(runner: GitRunner, folder: string, input: DiscardInput, trashItem: TrashItem): Promise<RepoState> {
  if (input.files.length === 0) {
    throw new GitInputError('Choose at least one file to discard.')
  }
  const status = await requireStatus(runner, folder)
  const root = status.root
  // Validate everything before touching anything; the status, not the request, says what each file is.
  const changes = input.files.map((file) => {
    checkPaths(file.oldPath === null ? [file.path] : [file.path, file.oldPath])
    const entry = findInStatus(status, file.path)
    if (entry.kind === 'conflicted') {
      throw new GitInputError(`${file.path} has conflicts and cannot be discarded here.`)
    }
    return entry
  })
  const git = (args: string[]): Promise<unknown> => runner.run({ cwd: root, args, kind: 'write' })
  for (const change of changes) {
    const path = join(root, change.path)
    switch (change.kind) {
      case 'modified':
      case 'typechange':
        await trashCopy(trashItem, path)
        await git(['checkout', 'HEAD', ...pathArgs([change.path])])
        break
      case 'deleted':
        await git(['checkout', 'HEAD', ...pathArgs([change.path])])
        break
      case 'untracked':
        await trashItem(path)
        break
      default:
        // added, copied and renamed: the new file is not in HEAD; a rename also brings back its old path.
        await git(['rm', '-q', '--cached', ...pathArgs([change.path])])
        await trashItem(path)
        if (change.oldPath !== null && change.kind === 'renamed') {
          await git(['checkout', 'HEAD', ...pathArgs([change.oldPath])])
        }
    }
  }
  return readRepoState(runner, root)
}
