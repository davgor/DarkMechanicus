/**
 * One source-control operation at a time per repository. The runner queues single git calls; this holds a whole
 * operation (its status reads, its checks and its writes) so another operation on the same repository cannot run
 * in between, for example a commit's `git reset` landing right after a pull's conflicting merge. Read-only
 * operations and cancel do not take it.
 */
import { canonical, type GitRunner } from './runner'

export interface OperationLocks {
  /** Runs `work` once every operation started earlier in the repository `folder` is in has finished. */
  run<T>(folder: string, work: () => Promise<T>): Promise<T>
}

/** The repository root `folder` is in; the folder itself when git finds none there (the work then reports why). */
async function lockRoot(runner: GitRunner, folder: string): Promise<string> {
  try {
    const top = await runner.run({ cwd: folder, args: ['rev-parse', '--show-toplevel'], kind: 'read' })
    return top.stdout.replace(/\r?\n$/, '')
  } catch {
    return folder
  }
}

/** Keyed by the canonical repository root, the same key the runner queues that repository's writes under. */
export function createOperationLocks(runner: GitRunner, platform: NodeJS.Platform = process.platform): OperationLocks {
  const tails = new Map<string, Promise<void>>()
  return {
    async run(folder, work) {
      const key = canonical(await lockRoot(runner, folder), platform)
      const previous = tails.get(key) ?? Promise.resolve()
      const result = previous.then(work)
      // The next operation starts once this one has settled, whether it succeeded or not.
      const tail = result.then(
        () => undefined,
        () => undefined
      )
      tails.set(key, tail)
      void tail.then(() => {
        if (tails.get(key) === tail) {
          tails.delete(key)
        }
      })
      return result
    }
  }
}
