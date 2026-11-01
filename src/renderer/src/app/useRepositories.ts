import { runCommand } from '../api/dm'
import type { RepositoryView } from '../../../shared/domain/views'
import { useResource } from './useResource'
import type { Resource } from './useResource'

/**
 * The child repositories of a folder of repositories, read from its project once per mount; null
 * for a single repository. A null `path` loads nothing (a folder that is not set up or not reachable).
 */
export function useRepositories(
  path: string | null,
  onError: (error: unknown) => void
): Resource<RepositoryView[] | null> {
  return useResource({
    key: path,
    version: 0,
    load: async () => (await runCommand(path ?? '', 'getProject', undefined))?.repositories ?? null,
    onError
  })
}

/** "1 repository", "3 repositories". */
export function repositoryCount(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`
}
