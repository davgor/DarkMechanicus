import type { WorkStatus } from '../../../shared/domain/status'

/** Persisted expand/collapse state for folders and buckets, keyed by `folderKey`/`bucketKey`. */
export type ExpansionMap = Record<string, boolean>

export const EXPANSION_STORAGE_KEY = 'dm.sidebar.expanded'

/** Active work is open by default; completed work starts collapsed. */
export const BUCKET_DEFAULTS: Record<WorkStatus, boolean> = {
  in_progress: true,
  backlog: true,
  completed: false
}

export function folderKey(path: string): string {
  return `folder:${path}`
}

export function bucketKey(path: string, bucket: WorkStatus): string {
  return `bucket:${path}:${bucket}`
}

export function lookupExpanded(map: ExpansionMap, key: string, fallback: boolean): boolean {
  return map[key] ?? fallback
}

export function isExpansionMap(value: unknown): value is ExpansionMap {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'boolean')
  )
}
