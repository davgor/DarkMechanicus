/**
 * A FakeBackend answering the epic Scorecard's reads from a recorded scorecard world (see scorecardWorlds.ts), the
 * world's epic renamed to the workspace's `ep_1`, and a way to change one command's answers in a test (test support
 * only).
 */
import type { CommandName } from '../../../../shared/domain/api'
import type { CommandInput, CommandOutput } from '../../../../shared/desktop/api'
import type { EpicDetailView } from '../../../../shared/domain/views'
import { world } from '../../__mocks__/scorecardWorlds'
import { FakeBackend, scenario } from './fakeBackend'
import { epicDetail } from './fixtures'

/** The recorded epic as the workspace's epic `ep_1`: its reads answered as the core answered them, the rest by the scenario. */
export function epicWorldBackend(key: 'epicActive' | 'epicCompleted', epic: Partial<EpicDetailView> = {}): FakeBackend {
  const recording = world(key)
  const renamed = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replaceAll(recording.ids.epicId, 'ep_1'))
  const calls = recording.calls.map((call) => ({ ...call, input: renamed(call.input), output: renamed(call.output) }))
  const backend = new FakeBackend(scenario({ epic: epicDetail({ status: key === 'epicCompleted' ? 'completed' : 'in_progress', ...epic }) }))
  for (const name of new Set(calls.map((call) => call.name))) {
    const fallback = backend.handlers[name] as ((input: unknown) => unknown) | undefined
    backend.handlers[name] = ((input: unknown) => {
      const found = calls.find((call) => call.name === name && JSON.stringify(call.input) === JSON.stringify(input ?? null))
      return found === undefined ? fallback?.(input) : structuredClone(found.output)
    }) as never
  }
  return backend
}

/** Answers `name` with `change` applied to what the backend answered before (a throw fails the command). */
export function changeAnswers<K extends CommandName>(backend: FakeBackend, name: K, change: (output: CommandOutput<K>, input: CommandInput<K>) => CommandOutput<K>): void {
  const before = backend.handlers[name] as ((input: CommandInput<K>) => CommandOutput<K>) | undefined
  if (before === undefined) throw new Error(`The backend answers no ${name}`)
  backend.handlers[name] = ((input: CommandInput<K>) => change(before(input), input)) as never
}
