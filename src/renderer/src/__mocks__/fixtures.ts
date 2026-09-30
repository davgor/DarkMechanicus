/**
 * Test-only builders for renderer tests. Lives under __mocks__ so fireguard treats it as support
 * code rather than a production module.
 */
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type {
  EpicDetailView,
  EpicSummaryView,
  EventView,
  RunSummaryView,
  StorageStatusView
} from '../../../shared/domain/views'

export const EPIC_A = 'ep_0000000000000000000000000a'
export const EPIC_B = 'ep_0000000000000000000000000b'
export const EPIC_C = 'ep_0000000000000000000000000c'

/**
 * ISO timestamp for noon on a calendar date in the machine's own time zone, so date labels
 * (which are shown in local time) come out the same wherever the tests run.
 */
export function localNoonIso(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12).toISOString()
}

export function folderView(patch: Partial<TrackedFolderView> = {}): TrackedFolderView {
  return {
    path: '/home/u/code/alpha',
    name: 'alpha',
    displayPath: '~/code/alpha',
    initialized: true,
    available: true,
    addedAt: '2026-01-01T00:00:00.000Z',
    ...patch
  }
}

export function runSummary(patch: Partial<RunSummaryView> = {}): RunSummaryView {
  return {
    id: 'rn_00000000000000000000000001',
    state: 'running',
    revisionNumber: 1,
    activeSprintOrdinal: 2,
    sprintCount: 3,
    pauseReason: null,
    ...patch
  }
}

export function epicSummary(patch: Partial<EpicSummaryView> = {}): EpicSummaryView {
  return {
    id: EPIC_A,
    title: 'Planning vertical slice',
    status: 'backlog',
    revision: 1,
    currentRevisionId: 'rv_00000000000000000000000001',
    currentRevisionNumber: 1,
    hasDraft: false,
    draftRevision: null,
    ticketCount: 4,
    sprintCount: 2,
    run: null,
    branch: null,
    pendingSave: false,
    conflict: null,
    createdAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:00:00.000Z',
    completedAt: null,
    ...patch
  }
}

export function epicDetail(patch: Partial<EpicDetailView> = {}): EpicDetailView {
  return {
    ...epicSummary(),
    intent: '',
    successCriteria: [],
    ownerRole: null,
    provenance: null,
    outcome: null,
    ...patch
  }
}

export function storageStatus(patch: Partial<StorageStatusView> = {}): StorageStatusView {
  return {
    initialized: true,
    repoRoot: '/home/u/code/alpha',
    projectId: 'pj_00000000000000000000000001',
    projectName: 'alpha',
    schemaVersion: 1,
    outbox: { pending: 0, failed: 0, lastError: null },
    lastFlushAt: null,
    branch: { current: 'main', recorded: 'main', changed: false, repository: true },
    uncommittedRecordFiles: 0,
    conflicts: [],
    sessions: { active: 0, byRole: {} },
    ...patch
  }
}

export function eventView(patch: Partial<EventView> = {}): EventView {
  return {
    seq: 1,
    at: '2026-01-01T12:00:00.000Z',
    kind: 'epic.updated',
    epicId: null,
    runId: null,
    ticketId: null,
    sessionId: null,
    payload: {},
    ...patch
  }
}
