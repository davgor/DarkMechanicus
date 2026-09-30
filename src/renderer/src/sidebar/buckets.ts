import { WORK_STATUS_LABELS } from '../../../shared/domain/status'
import type { WorkStatus } from '../../../shared/domain/status'
import type { EpicSummaryView } from '../../../shared/domain/views'

/** The only three sidebar buckets, in display order. Bucket placement comes from epic status. */
const BUCKET_ORDER: readonly WorkStatus[] = ['in_progress', 'backlog', 'completed']

export interface Bucket {
  id: WorkStatus
  label: string
  epics: EpicSummaryView[]
  count: number
}

function compareText(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

/** Open epics sort by creation time, completed ones by completion time. */
function orderingKey(epic: EpicSummaryView): string {
  return epic.status === 'completed' ? (epic.completedAt ?? epic.updatedAt) : epic.createdAt
}

function compareEpics(a: EpicSummaryView, b: EpicSummaryView): number {
  const byTime = compareText(orderingKey(a), orderingKey(b))
  const oldestFirst = a.status === 'completed' ? -byTime : byTime
  return oldestFirst === 0 ? compareText(a.id, b.id) : oldestFirst
}

export function groupEpics(epics: readonly EpicSummaryView[]): Bucket[] {
  return BUCKET_ORDER.map((id) => {
    const inBucket = epics.filter((epic) => epic.status === id).sort(compareEpics)
    return { id, label: WORK_STATUS_LABELS[id], epics: inBucket, count: inBucket.length }
  })
}

export function bucketOfEpic(epics: readonly EpicSummaryView[], epicId: string): WorkStatus | null {
  return epics.find((epic) => epic.id === epicId)?.status ?? null
}
