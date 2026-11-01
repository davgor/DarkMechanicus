import { useEffect, useRef, useState } from 'react'
import { runCommand } from '../api/dm'
import { folderToken } from '../app/eventRouting'
import type { Tokens } from '../app/eventRouting'
import { useLatest } from '../app/useLatest'

/** Open cards per folder path; a folder is absent until its board has loaded. */
export type KanbanCounts = Record<string, number>

interface CountOptions {
  /** Folders that are set up and reachable; others have no board. */
  paths: readonly string[]
  tokens: Tokens
  onError(error: unknown): void
}

/**
 * Keeps the open card count of every active folder current for the sidebar: fetches when a folder
 * becomes active or its event token moves (card writes emit workspace events), keeps the previous
 * count meanwhile, and drops stale responses.
 */
export function useKanbanCounts(options: CountOptions): KanbanCounts {
  const [counts, setCounts] = useState<KanbanCounts>({})
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
        const open = lanes.backlog.length + lanes.in_progress.length + lanes.ready_for_review.length
        if (latest.current.get(path) === ticket) {
          setCounts((previous) => ({ ...previous, [path]: open }))
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

  return counts
}
