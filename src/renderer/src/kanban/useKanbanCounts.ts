import { useEffect, useMemo, useRef, useState } from 'react'
import { runCommand } from '../api/dm'
import { kanbanCountToken, type Tokens } from '../app/eventRouting'
import { useLatest } from '../app/useLatest'

/** Open cards per folder path; a folder is absent until its board has loaded. */
export type KanbanCounts = Record<string, number>

interface CountOptions {
  paths: readonly string[]
  identities?: ReadonlyMap<string, string>
  tokens: Tokens
  onError(error: unknown): void
}

interface CountRequest { identity: string; token: number }
interface CountResult { identity: string; count: number }

/** Reads one scalar per active store and keeps the last verified value during refresh. */
export function useKanbanCounts({ paths, identities, tokens, onError }: CountOptions): KanbanCounts {
  const [counts, setCounts] = useState<Record<string, CountResult>>({})
  const latest = useRef(new Map<string, CountRequest>())
  const report = useLatest(onError)
  const key = JSON.stringify(paths.map(path => [path, identities?.get(path) ?? path, kanbanCountToken(tokens, path)]))
  const wanted = useMemo(() => new Map(
    (JSON.parse(key) as [string, string, number][]).map(([path, identity, token]) => [path, { identity, token }])
  ), [key])

  useEffect(() => {
    const requests = latest.current
    for (const path of requests.keys()) if (!wanted.has(path)) requests.delete(path)
    setCounts(previous => {
      const retained = Object.entries(previous).filter(([path, item]) => wanted.get(path)?.identity === item.identity)
      return retained.length === Object.keys(previous).length ? previous : Object.fromEntries(retained)
    })
    const load = async (path: string, request: CountRequest): Promise<void> => {
      try {
        const count = await runCommand(path, 'getKanbanOpenCount', undefined)
        if (requests.get(path) === request) setCounts(previous => ({ ...previous, [path]: { identity: request.identity, count } }))
      } catch (error) {
        if (requests.get(path) === request) report.current(error)
      }
    }
    for (const [path, request] of wanted) {
      const pending = requests.get(path)
      if (pending?.identity === request.identity && pending.token === request.token) continue
      requests.set(path, request)
      void load(path, request)
    }
  }, [wanted, report])

  useEffect(() => {
    const requests = latest.current
    return () => requests.clear()
  }, [])
  return Object.fromEntries(Object.entries(counts).flatMap(([path, { identity, count }]) =>
    wanted.get(path)?.identity === identity ? [[path, count]] : []
  ))
}
