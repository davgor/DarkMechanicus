import { useMemo } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { WorkStatus } from '../../../shared/domain/status'
import { usePersistentState } from '../app/usePersistentState'
import {
  AGENTS_DEFAULT,
  BUCKET_DEFAULTS,
  EXPANSION_STORAGE_KEY,
  agentsKey,
  bucketKey,
  folderKey,
  isExpansionMap,
  lookupExpanded
} from './expansion'
import type { ExpansionMap } from './expansion'

export interface Expansion {
  isFolderExpanded(path: string): boolean
  isBucketExpanded(path: string, bucket: WorkStatus): boolean
  /** The Agents block (the folder's chats). */
  isAgentsExpanded(path: string): boolean
  toggleFolder(path: string): void
  toggleBucket(path: string, bucket: WorkStatus): void
  toggleAgents(path: string): void
  /** Expands a folder, and one of its buckets when given, e.g. to show a newly opened epic. */
  reveal(path: string, bucket: WorkStatus | null): void
  /** Expands a folder and its Agents block, e.g. to show a chat that was just created. */
  revealAgents(path: string): void
}

type SetMap = Dispatch<SetStateAction<ExpansionMap>>

function buildExpansion(map: ExpansionMap, setMap: SetMap): Expansion {
  const folderOpen = (path: string, from: ExpansionMap): boolean =>
    lookupExpanded(from, folderKey(path), true)
  const bucketOpen = (path: string, bucket: WorkStatus, from: ExpansionMap): boolean =>
    lookupExpanded(from, bucketKey(path, bucket), BUCKET_DEFAULTS[bucket])
  return {
    isFolderExpanded: (path) => folderOpen(path, map),
    isBucketExpanded: (path, bucket) => bucketOpen(path, bucket, map),
    isAgentsExpanded: (path) => lookupExpanded(map, agentsKey(path), AGENTS_DEFAULT),
    toggleFolder: (path) =>
      setMap((previous) => ({ ...previous, [folderKey(path)]: !folderOpen(path, previous) })),
    toggleBucket: (path, bucket) =>
      setMap((previous) => ({
        ...previous,
        [bucketKey(path, bucket)]: !bucketOpen(path, bucket, previous)
      })),
    toggleAgents: (path) =>
      setMap((previous) => ({
        ...previous,
        [agentsKey(path)]: !lookupExpanded(previous, agentsKey(path), AGENTS_DEFAULT)
      })),
    revealAgents: (path) =>
      setMap((previous) => ({ ...previous, [folderKey(path)]: true, [agentsKey(path)]: true })),
    reveal: (path, bucket) =>
      setMap((previous) => ({
        ...previous,
        [folderKey(path)]: true,
        ...(bucket === null ? {} : { [bucketKey(path, bucket)]: true })
      }))
  }
}

/** Folder and bucket collapse state, persisted across reloads. */
export function useExpansion(): Expansion {
  const [map, setMap] = usePersistentState<ExpansionMap>(EXPANSION_STORAGE_KEY, {}, isExpansionMap)
  return useMemo(() => buildExpansion(map, setMap), [map, setMap])
}
