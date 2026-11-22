import { useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { SourceControlTarget } from '../../../shared/git/api'
import { callGit } from '../api/git'
import { errorMessage } from '../api/dm'
import type { Scheduler } from '../app/scheduler'
import { useRefreshTick } from '../app/useRefreshTick'
import { useResource, type Resource } from '../app/useResource'

export interface SourceTargetModel {
  state: Resource<SourceControlTarget>
  error: string | null
  refresh(): void
}

/** The header and source panel share one read of a Forge member's local code location. */
export function useSourceTarget(folder: TrackedFolderView | null, scheduler: Scheduler): SourceTargetModel {
  const member = folder?.forgeParent !== undefined
  const tick = useRefreshTick({ scheduler, everyMs: 5000, enabled: member })
  const [manual, setManual] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const state = useResource({
    key: member ? folder?.path ?? null : null,
    version: tick + manual,
    load: () => callGit(window.git.getTarget(folder?.path ?? '')),
    onError: failure => setError(errorMessage(failure))
  })
  const local: Resource<SourceControlTarget> = folder === null ? { status: 'loading' } : { status: 'ready', value: { kind: 'available', path: folder.path, displayPath: folder.displayPath } }
  return { state: member ? state : local, error, refresh: () => setManual(value => value + 1) }
}
