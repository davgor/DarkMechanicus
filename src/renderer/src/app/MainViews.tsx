import type { TrackedFolderView } from '../../../shared/desktop/api'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { Mascot } from '../components/Mascot'

export function LoadingView(): JSX.Element {
  return (
    <div className="main-loading" role="status" aria-busy="true">
      Loading folders…
    </div>
  )
}

/** Shown when no folder is tracked yet. */
export function WelcomeView({ onTrack }: { onTrack(): void }): JSX.Element {
  return (
    <EmptyState
      illustration={<Mascot size={128} />}
      headingLevel={1}
      title="Track a folder to get started"
      action={
        <Button variant="primary" icon="plus" onClick={onTrack}>
          Choose folder
        </Button>
      }
    >
      Dark Mechanicus keeps plans, tickets and run history inside your repositories. Pick a folder to begin.
    </EmptyState>
  )
}

interface UnavailableViewProps {
  folder: TrackedFolderView
  onStopTracking(folder: TrackedFolderView): void
}

/** Shown for a tracked folder that is missing or unreadable. */
export function UnavailableView({ folder, onStopTracking }: UnavailableViewProps): JSX.Element {
  return (
    <EmptyState
      icon="warning"
      headingLevel={1}
      title={`${folder.name} can’t be found`}
      action={<Button onClick={() => onStopTracking(folder)}>Stop tracking folder</Button>}
    >
      Nothing was found at {folder.displayPath}. Reconnect the drive or restore the folder, or stop tracking it. Your
      repository data is not affected.
    </EmptyState>
  )
}
