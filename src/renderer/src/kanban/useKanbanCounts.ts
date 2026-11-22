import type { KanbanCardSummaryView } from '../../../shared/domain/kanban'
import { useEffect, useRef, useState } from 'react'
import { runCommand } from '../api/dm'
import { folderToken } from '../app/eventRouting'
import type { Tokens } from '../app/eventRouting'
import { useLatest } from '../app/useLatest'

/** Open cards per folder path; a folder is absent until its board has loaded. */
export type KanbanCounts = Record<string, number>
export type KanbanCards = Record<string, KanbanCardSummaryView[]>
interface SidebarBoards { counts: KanbanCounts; cards: KanbanCards }

interface CountOptions {
  /** Folders that are set up and reachable; others have no board. */
  paths: readonly string[]
  tokens: Tokens
  onError(error: unknown): void
}

/**
 * Keeps the open cards and their count for every active folder current for the sidebar: fetches when a folder
 * becomes active or its event token moves (card writes emit workspace events), keeps the previous
 * cards meanwhile, and drops stale responses.
 */
export function useKanbanCounts(options: CountOptions): SidebarBoards {
  const [boards, setBoards] = useState<SidebarBoards>({ counts: {}, cards: {} })
  const fetched = useRef(new Map<string, number>())
  const latest = useRef(new Map<string, object>())
  const onError = useLatest(options.onError)
  const { paths, tokens } = options
  const stateKey = paths.map((path) => `${path}\0${folderToken(tokens, path)}`).join('\n')

  useEffect(() => {
    const load = async (path: string): Promise<void> => {
      const ticket = {}
      latest.current.set(path, ticket)
      try {
        // Only the open lanes (Backlog, In progress, Ready for review) count, so one Done card is enough.
        const { lanes } = await runCommand(path, 'listKanbanCards', { doneLimit: 1 })
        const cards = [...lanes.in_progress, ...lanes.ready_for_review, ...lanes.backlog]
        if (latest.current.get(path) === ticket) {
          setBoards((previous) => ({ counts: { ...previous.counts, [path]: cards.length }, cards: { ...previous.cards, [path]: cards } }))
        }
      } catch (error) {
        if (latest.current.get(path) === ticket) onError.current(error)
      }
    }
    for (const path of paths) {
      const token = folderToken(tokens, path)
      if (fetched.current.get(path) !== token) {
        fetched.current.set(path, token)
        void load(path)
      }
    }
    // The joined key stands in for `paths` and `tokens`, which are new objects on every render.
  }, [stateKey, onError])

  return boards
}
