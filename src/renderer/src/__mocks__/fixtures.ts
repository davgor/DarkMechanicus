/**
 * Test-only builders for renderer tests. Lives under __mocks__ so fireguard treats it as support
 * code rather than a production module.
 */
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type {
  BoardImportView,
  BoardOpenEpicView,
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
    draftChanged: false,
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
    profileConflicts: [],
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

/** The open epic 014 of the old board fixture, not imported yet. */
export function boardOpenEpic(patch: Partial<BoardOpenEpicView> = {}): BoardOpenEpicView {
  return {
    boardId: '014',
    kind: 'epic',
    title: 'Cross-host validation and release',
    folder: 'in-progress',
    sourcePath: 'board/in-progress/014-cross-host-release.md',
    sourcePaths: ['board/in-progress/014-cross-host-release.md', 'board/done/014.1-package-mcp-entry.md'],
    ticketCount: 2,
    doneTickets: [{ boardId: '014.1', title: 'Package the MCP entry', sourcePath: 'board/done/014.1-package-mcp-entry.md' }],
    state: 'new',
    epicId: null,
    ...patch
  }
}

/** An old board with one open epic, two done epics and one skipped file. */
export function boardImport(patch: Partial<BoardImportView> = {}): BoardImportView {
  return {
    open: [boardOpenEpic()],
    done: [
      {
        boardId: '008',
        title: 'Desktop experience mockups',
        sourcePath: 'board/done/008-desktop-mockups.md',
        sourcePaths: ['board/done/008-desktop-mockups.md'],
        ticketCount: 1
      },
      {
        boardId: '013',
        title: 'Sprint checkpoints and recovery',
        sourcePath: 'board/done/013-checkpoints-and-recovery.md',
        sourcePaths: ['board/done/013-checkpoints-and-recovery.md'],
        ticketCount: 6
      }
    ],
    skipped: [{ path: 'board/backlog/notes.txt', reason: 'is not a Markdown file' }],
    ...patch
  }
}

/** What a repository without an old board answers. */
export const NO_BOARD: BoardImportView = { open: [], done: [], skipped: [] }
