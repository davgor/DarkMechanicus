import { useState } from 'react'
import type { KanbanCardView } from '../../../shared/domain/kanban'
import type { LearningDetailView, LearningView } from '../../../shared/domain/learnings'
import type { RunView } from '../../../shared/domain/views'
import { runCommand } from '../api/dm'
import { type Resource, useResource } from '../app/useResource'

export type LearningFilter = 'active' | 'retired' | 'all'

/** One learning with its history and the source records its provenance links resolve against. */
export interface LearningDetailData {
  detail: LearningDetailView
  /** The learning's source run; null when this folder holds no such run. */
  run: RunView | null
  /** The learning's source card; null when it is not on this folder's board. */
  card: KanbanCardView | null
}

interface ListOptions {
  folder: string
  filter: LearningFilter
  query: string
  /** Changes whenever the folder's events may have changed its learnings. */
  refreshToken: number
  onError(error: unknown): void
}

/** The folder's learnings for a filter and search, reloaded on `refreshToken` changes and on `reload()`. */
export function useLearningList(options: ListOptions): { list: Resource<LearningView[]>; reload(): void } {
  const [version, setVersion] = useState(0)
  const { folder, filter, query } = options
  const list = useResource({
    key: `${folder}\u0000${filter}\u0000${query}`,
    version: `${options.refreshToken}:${version}`,
    load: () => runCommand(folder, 'listLearnings', { state: filter, ...(query === '' ? {} : { query }) }),
    onError: options.onError
  })
  return { list, reload: () => setVersion((previous) => previous + 1) }
}

/** A source record, or null when the folder does not hold it (or it cannot be read): its link stays a plain id. */
async function orNull<T>(read: Promise<T | null>): Promise<T | null> {
  try {
    return await read
  } catch {
    return null
  }
}

async function loadDetail(folder: string, learningId: string): Promise<LearningDetailData> {
  const detail = await runCommand(folder, 'getLearning', { learningId })
  const { source } = detail.learning
  const [run, card] = await Promise.all([
    orNull(runCommand(folder, 'getRun', { runId: source.runId })),
    orNull(runCommand(folder, 'getKanbanCard', { cardId: source.cardId }))
  ])
  return { detail, run, card }
}

interface DetailOptions {
  folder: string
  learningId: string | null
  refreshToken: number
  onError(error: unknown): void
}

/** The open learning's detail and resolved sources, reloaded with the list and on `reload()`. */
export function useLearningDetail(options: DetailOptions): { detail: Resource<LearningDetailData> | null; reload(): void } {
  const [version, setVersion] = useState(0)
  const { folder, learningId } = options
  const detail = useResource({
    key: learningId === null ? null : `${folder}\u0000${learningId}`,
    version: `${options.refreshToken}:${version}`,
    load: () => loadDetail(folder, learningId ?? ''),
    onError: options.onError
  })
  return { detail: learningId === null ? null : detail, reload: () => setVersion((previous) => previous + 1) }
}
