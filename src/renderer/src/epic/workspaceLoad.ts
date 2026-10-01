import { isActiveRunState, type RunState } from '../../../shared/domain/status'
import type { CheckpointView, EpicDetailView, RunView } from '../../../shared/domain/views'
import type { Runner } from './runner'
import type { WorkspaceData } from './workspaceState'

/** Run states whose checkpoint (gate status and report) the workspace shows. */
const CHECKPOINT_STATES = new Set<RunState>(['running', 'awaiting_checkpoint'])

/** An active run keeps executing the revision it pinned, even after a newer Save. */
function pinnedRevision(epic: EpicDetailView, run: RunView | null): string | null {
  const lagging = run !== null && isActiveRunState(run.state) && run.revisionId !== epic.currentRevisionId
  return lagging ? run.revisionId : null
}

async function loadPlans(runner: Runner, epic: EpicDetailView): Promise<Pick<WorkspaceData, 'saved' | 'draft' | 'run'>> {
  const epicId = epic.id
  const [current, draft, run] = await Promise.all([
    epic.currentRevisionId === null ? null : runner('getPlan', { epicId, view: 'saved' }),
    epic.hasDraft ? runner('getPlan', { epicId, view: 'draft' }) : null,
    runner('getRun', { epicId })
  ])
  const pinned = pinnedRevision(epic, run)
  // The Saved view overlays run state, so it shows the revision that run is actually executing.
  const saved = pinned === null ? current : await runner('getPlan', { epicId, view: 'saved', revisionId: pinned })
  return { saved, draft, run }
}

function loadCheckpoint(runner: Runner, run: RunView | null): Promise<CheckpointView | null> | null {
  if (run === null || !CHECKPOINT_STATES.has(run.state)) {
    return null
  }
  return runner('getCheckpoint', { runId: run.id }).catch(() => null)
}

/** Loads everything the epic workspace shows, skipping reads for things that do not exist. */
export async function loadWorkspace(runner: Runner, epicId: string): Promise<WorkspaceData> {
  const epic = await runner('getEpic', { epicId })
  const { saved, draft, run } = await loadPlans(runner, epic)
  const [checkpoint, savedTickets, draftTickets, validation] = await Promise.all([
    loadCheckpoint(runner, run),
    saved === null ? [] : runner('listTickets', { epicId, view: 'saved' }),
    draft === null ? [] : runner('listTickets', { epicId, view: 'draft' }),
    draft === null ? null : runner('validatePlan', { epicId, view: 'draft' })
  ])
  return { epic, saved, draft, run, checkpoint: checkpoint ?? run?.checkpoint ?? null, savedTickets, draftTickets, validation }
}
