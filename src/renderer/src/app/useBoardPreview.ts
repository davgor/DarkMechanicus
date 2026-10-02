import { runCommand } from '../api/dm'
import type { BoardImportView } from '../../../shared/domain/views'
import { useResource } from './useResource'
import type { Resource } from './useResource'

/** What importing the folder's old-style board would do; read again whenever `version` changes. */
export function useBoardPreview(
  path: string,
  version: number | string,
  onError: (error: unknown) => void
): Resource<BoardImportView> {
  return useResource({
    key: path,
    version,
    load: () => runCommand(path, 'previewBoardImport', undefined),
    onError
  })
}
