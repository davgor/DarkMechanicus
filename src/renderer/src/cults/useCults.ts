/**
 * The cults and their runs for the sidebar, from `window.dm.cults`: listed once, then kept current by the `cults:event`
 * push (each event replaces its run's snapshot, or adds a run not seen before), and reloaded after a change made here.
 */
import { useCallback, useEffect, useState } from 'react'
import type { CultDefinitionInput, CultPushEvent, CultRunDetail } from '../../../shared/cults/cultApi'
import type { CultView } from '../../../shared/cults/cult'
import type { CommandResult } from '../../../shared/desktop/api'

/** One cult with its runs, newest first. */
export interface CultEntry {
  cult: CultView
  runs: CultRunDetail[]
}

type CultsState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; cults: CultEntry[] }

export interface CultsModel {
  state: CultsState
  /** Each resolves with null once done, or the reason it was refused. */
  create(input: CultDefinitionInput): Promise<string | null>
  update(cultId: string, input: CultDefinitionInput): Promise<string | null>
  remove(cultId: string): Promise<string | null>
}

const unwrap = <T>(result: CommandResult<T>): T => {
  if (result.ok) return result.data
  throw new Error(result.error.message)
}

async function loadCults(): Promise<CultEntry[]> {
  const cults = unwrap(await window.dm.cults.list())
  return Promise.all(cults.map(async (cult) => ({ cult, runs: unwrap(await window.dm.cults.runs(cult.id)) })))
}

/** The cults with the pushed snapshot in place of its run's older one. */
export function applyRunEvent(entries: CultEntry[], event: CultPushEvent): CultEntry[] {
  const { snapshot } = event
  return entries.map((entry) => {
    if (entry.cult.id !== snapshot.run.cultId) return entry
    const known = entry.runs.some((run) => run.run.id === snapshot.run.id)
    const runs = known ? entry.runs.map((run) => (run.run.id === snapshot.run.id ? snapshot : run)) : [snapshot, ...entry.runs]
    return { ...entry, runs }
  })
}

export function useCults(): CultsModel {
  const [state, setState] = useState<CultsState>({ status: 'loading' })
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let current = true
    loadCults().then(
      (cults) => current && setState({ status: 'ready', cults }),
      (error: unknown) => current && setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    )
    return () => {
      current = false
    }
  }, [version])

  useEffect(
    () =>
      window.dm.cults.onEvent((event) =>
        setState((previous) => (previous.status === 'ready' ? { status: 'ready', cults: applyRunEvent(previous.cults, event) } : previous))
      ),
    []
  )
  const after = useCallback(async (work: Promise<CommandResult<unknown>>): Promise<string | null> => {
    const result = await work
    if (result.ok) setVersion((n) => n + 1)
    return result.ok ? null : result.error.message
  }, [])

  return {
    state,
    create: (input) => after(window.dm.cults.create(input)),
    update: (cultId, input) => after(window.dm.cults.update(cultId, input)),
    remove: (cultId) => after(window.dm.cults.delete(cultId))
  }
}
