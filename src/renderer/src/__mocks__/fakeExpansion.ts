import type { WorkStatus } from '../../../shared/domain/status'
import { BUCKET_DEFAULTS } from '../sidebar/expansion'
import type { Expansion } from '../sidebar/useExpansion'

interface Overrides {
  /** Folder paths that are collapsed. */
  collapsedFolders?: string[]
  /** `${path}:${bucket}` entries, true = expanded, false = collapsed. */
  buckets?: Record<string, boolean>
}

/** Hand-written Expansion that records what the UI asked to toggle or reveal. */
export class FakeExpansion implements Expansion {
  readonly toggled: string[] = []
  readonly revealed: string[] = []

  constructor(private readonly overrides: Overrides = {}) {}

  isFolderExpanded(path: string): boolean {
    return !(this.overrides.collapsedFolders ?? []).includes(path)
  }

  isBucketExpanded(path: string, bucket: WorkStatus): boolean {
    return this.overrides.buckets?.[`${path}:${bucket}`] ?? BUCKET_DEFAULTS[bucket]
  }

  toggleFolder(path: string): void {
    this.toggled.push(`folder:${path}`)
  }

  toggleBucket(path: string, bucket: WorkStatus): void {
    this.toggled.push(`bucket:${path}:${bucket}`)
  }

  reveal(path: string, bucket: WorkStatus | null): void {
    this.revealed.push(bucket === null ? path : `${path}:${bucket}`)
  }
}
