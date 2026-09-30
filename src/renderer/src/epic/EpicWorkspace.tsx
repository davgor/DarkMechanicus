import type { TrackedFolderView } from '../../../shared/desktop/api'

export interface EpicWorkspaceProps {
  folder: TrackedFolderView
  epicId: string
  /** Increments whenever events arrive that may affect this epic; reload on change. */
  refreshToken: number
  /** Call after any mutation so the shell refreshes sidebar counts. */
  onChanged(): void
  onOpenEpic(epicId: string): void
}

/** Placeholder replaced by the epic workspace implementation. */
export function EpicWorkspace(props: EpicWorkspaceProps): JSX.Element {
  return (
    <section className="epic-workspace" aria-label="Epic workspace">
      <p>Loading epic {props.epicId}…</p>
    </section>
  )
}
