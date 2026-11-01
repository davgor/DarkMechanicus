/** Small reads shared by the branch and stash operations: the repository root and the current branch. */
import type { GitRunner } from './runner'

/** The root of the repository `folder` is in; `not_repository` (a GitError) when there is none. */
export async function repositoryRoot(runner: GitRunner, folder: string): Promise<string> {
  const { stdout } = await runner.run({ cwd: folder, args: ['rev-parse', '--show-toplevel'], kind: 'read' })
  return stdout.replace(/\r?\n$/, '')
}

/** The branch HEAD is on (born or not), or null when HEAD is detached. */
export async function currentBranch(runner: GitRunner, root: string): Promise<string | null> {
  const result = await runner.run({ cwd: root, args: ['symbolic-ref', '--quiet', 'HEAD'], kind: 'read', acceptExitCodes: [0, 1] })
  const ref = result.stdout.replace(/\r?\n$/, '')
  return result.code === 0 && ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null
}
