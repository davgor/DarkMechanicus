import { useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage, runCommand } from '../api/dm'
import type { EpicSummaryView } from '../../../shared/domain/views'
import { folderToken, type Tokens } from './eventRouting'
import { useLatest } from './useLatest'

export interface EpicListState {
  status: 'loading' | 'ready' | 'error'
  epics: EpicSummaryView[]
  error: string | null
}

const LOADING: EpicListState = { status: 'loading', epics: [], error: null }
type Lists = Record<string, EpicListState>

export function listFor(lists: Lists, path: string): EpicListState {
  return lists[path] ?? LOADING
}

interface ListOptions {
  paths: readonly string[]
  identities?: ReadonlyMap<string, string>
  tokens: Tokens
  onError(error: unknown): void
}

interface Request { identity: string; token: number }
interface Result { identity: string; list: EpicListState }

/** Keep the last good list during refresh. Closing or rebinding a project evicts its list and pending read. */
export function useEpicLists({ paths, identities, tokens, onError }: ListOptions): Lists {
  const [lists, setLists] = useState<Record<string, Result>>({})
  const latest = useRef(new Map<string, Request>())
  const report = useLatest(onError)
  const key = JSON.stringify(paths.map(path => [path, identities?.get(path) ?? path, folderToken(tokens, path)]))
  const wanted = useMemo(() => new Map(
    (JSON.parse(key) as [string, string, number][]).map(([path, identity, token]) => [path, { identity, token }])
  ), [key])

  useEffect(() => {
    const requests = latest.current
    for (const path of requests.keys()) if (!wanted.has(path)) requests.delete(path)
    setLists(previous => {
      const retained = Object.entries(previous).filter(([path, item]) => wanted.get(path)?.identity === item.identity)
      return retained.length === Object.keys(previous).length ? previous : Object.fromEntries(retained)
    })
    const load = async (path: string, request: Request): Promise<void> => {
      const { identity } = request
      try {
        const epics = await runCommand(path, 'listEpics', undefined)
        if (requests.get(path) === request) setLists(previous => ({ ...previous, [path]: { identity, list: { status: 'ready', epics, error: null } } }))
      } catch (error) {
        if (requests.get(path) !== request) return
        setLists(previous => ({
          ...previous,
          [path]: { identity, list: { status: 'error', epics: previous[path]?.identity === identity ? previous[path].list.epics : [], error: errorMessage(error) } }
        }))
        report.current(error)
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
  return Object.fromEntries(Array.from(wanted, ([path, { identity }]) => [
    path, lists[path]?.identity === identity ? lists[path].list : LOADING
  ]))
}
