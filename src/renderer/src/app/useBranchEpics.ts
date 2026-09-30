import { runCommand } from '../api/dm'
import type { BranchEpicView } from '../../../shared/domain/views'
import { useResource } from './useResource'
import type { Resource } from './useResource'

/** Epics recorded on other local branches (read-only information), loaded once per mount. */
export function useBranchEpics(path: string, onError: (error: unknown) => void): Resource<BranchEpicView[]> {
  return useResource({
    key: path,
    version: 0,
    load: () => runCommand(path, 'listBranchEpics', undefined),
    onError
  })
}
