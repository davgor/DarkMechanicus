/**
 * The corrective planner's state for one sprint of one run in one folder, kept for the session outside the components:
 * switching report tabs, leaving the checkpoint for the draft and coming back, a workspace reload or a newer report
 * revision never loses the person's selection and edits. A preview or creation in flight is recorded here too, so a
 * repeated click (even from a remounted screen) starts nothing until it settles.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { EMPTY_PLANNER, type PlannerState } from './improvementView'

const states = new Map<string, PlannerState>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** One planner per sprint of a run in a folder: a newer revision of the sprint's report keeps the selection and edits. */
export function plannerKey(folder: string, report: { runId: string; sprintId: string }): string {
  return `${folder}|${report.runId}|${report.sprintId}`
}

/** The planner state under `key` as it is now (read synchronously, so a second click sees the first one's flag). */
export function plannerState(key: string): PlannerState {
  return states.get(key) ?? EMPTY_PLANNER
}

function updatePlanner(key: string, update: (state: PlannerState) => PlannerState): void {
  states.set(key, update(plannerState(key)))
  for (const listener of listeners) listener()
}

export function usePlanner(key: string): [PlannerState, (update: (state: PlannerState) => PlannerState) => void] {
  const state = useSyncExternalStore(subscribe, () => plannerState(key))
  const update = useCallback((change: (state: PlannerState) => PlannerState) => updatePlanner(key, change), [key])
  return [state, update]
}
