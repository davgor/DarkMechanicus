import { isActiveRunState, type RunState } from '../../../shared/domain/status'
import type { CheckpointView, EpicDetailView, PlanView, RunView, SprintReportView } from '../../../shared/domain/views'
import type { Runner } from './runner'
import type { OverviewData, WorkspaceData } from './workspaceState'

/**
 * Run states whose checkpoint (gate status and report) the workspace shows. A completed run has no
 * active sprint, so no checkpoint: its overview is read from the run history instead.
 */
const CHECKPOINT_STATES = new Set<RunState>(['running', 'awaiting_checkpoint'])

/** An active run keeps executing the revision it pinned, even after a newer Save. */
function pinnedRevision(epic: EpicDetailView, run: RunView | null): string | null {
  const lagging = run !== null && isActiveRunState(run.state) && run.revisionId !== epic.currentRevisionId
  return lagging ? run.revisionId : null
}

/** The draft's plan, its ticket list and its validation, read together. */
export async function loadDraft(runner: Runner, epicId: string): Promise<Pick<WorkspaceData, 'draft' | 'draftTickets' | 'validation'>> {
  const [draft, draftTickets, validation] = await Promise.all([
    runner('getPlan', { epicId, view: 'draft' }),
    runner('listTickets', { epicId, view: 'draft' }),
    runner('validatePlan', { epicId, view: 'draft' })
  ])
  return { draft, draftTickets, validation }
}

const NO_DRAFT: Pick<WorkspaceData, 'draft' | 'draftTickets' | 'validation'> = { draft: null, draftTickets: [], validation: null }

function loadCheckpoint(runner: Runner, run: RunView | null): Promise<CheckpointView | null> | null {
  if (run === null || !CHECKPOINT_STATES.has(run.state)) {
    return null
  }
  return runner('getCheckpoint', { runId: run.id }).catch(() => null)
}

/** The plan a finished run executed: the current revision, unless a newer one was saved meanwhile. */
async function executedPlan(runner: Runner, epicId: string, run: RunView, saved: PlanView | null): Promise<PlanView | null> {
  if (saved?.revisionId === run.revisionId) {
    return saved
  }
  return runner('getPlan', { epicId, view: 'saved', revisionId: run.revisionId }).catch(() => saved)
}

/** A completed run's overview: the plan it executed and each sprint's latest report, in sprint order. */
export async function loadOverview(runner: Runner, epicId: string, run: RunView | null, saved: PlanView | null): Promise<OverviewData | null> {
  if (run === null || run.state !== 'completed') {
    return null
  }
  const bundle = (await executedPlan(runner, epicId, run, saved))?.bundle ?? null
  const sprints = [...(bundle?.sprints ?? [])].sort((a, b) => a.ordinal - b.ordinal)
  const reports = await Promise.all(
    sprints.map((sprint) => runner('getSprintReport', { runId: run.id, sprintId: sprint.id }).catch(() => null))
  )
  return { bundle, reports: reports.filter((report): report is SprintReportView => report !== null) }
}

/** Every read that needs only the epic, in one parallel round. */
function loadAfterEpic(runner: Runner, epic: EpicDetailView, readDraft: boolean) {
  const epicId = epic.id
  const saved = epic.currentRevisionId !== null
  // A transfer needs a saved plan, and a completed epic has none open (a verified one is in its outcome).
  const transferable = saved && epic.status !== 'completed'
  return Promise.all([
    saved ? runner('getPlan', { epicId, view: 'saved' }) : null,
    runner('getRun', { epicId }),
    saved ? runner('listTickets', { epicId, view: 'saved' }) : [],
    readDraft ? loadDraft(runner, epicId) : NO_DRAFT,
    transferable ? runner('getTransfer', { epicId }) : null
  ])
}

/**
 * Loads the active workspace. The completed run's report is read when opened.
 *
 * After the epic, every read whose input is known runs in one parallel round; only the checkpoint and a pinned
 * revision wait for the run. A draft that holds no change from the saved plan (`draftChanged` false) is read only
 * when `wantsDraft` says it is shown; otherwise its plan, tickets and validation are not transferred at all.
 * `wantsDraft` is asked once the epic arrives, so it sees a view chosen meanwhile.
 */
export async function loadWorkspace(runner: Runner, epicId: string, wantsDraft: () => boolean = () => false): Promise<WorkspaceData> {
  const epic = await runner('getEpic', { epicId })
  const [current, run, savedTickets, drafted, transfer] = await loadAfterEpic(runner, epic, epic.hasDraft && (epic.draftChanged || wantsDraft()))
  const pinned = pinnedRevision(epic, run)
  // The Saved view overlays run state, so it shows the revision that run is actually executing.
  const [saved, checkpoint] = await Promise.all([
    pinned === null ? current : runner('getPlan', { epicId, view: 'saved', revisionId: pinned }),
    loadCheckpoint(runner, run)
  ])
  return {
    epic,
    saved,
    draft: drafted.draft,
    run,
    checkpoint: checkpoint ?? run?.checkpoint ?? null,
    savedTickets,
    draftTickets: drafted.draftTickets,
    validation: drafted.validation,
    transfer
  }
}
