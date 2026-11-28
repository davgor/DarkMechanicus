/**
 * `window.dm.cults` for renderer tests that are not about cults: no cults, no runs, no models, and every change refused.
 */
import type { CultsApi } from '../../../shared/cults/cultApi'
import type { CommandResult } from '../../../shared/desktop/api'

export function idleCults(): CultsApi {
  const refused = <T>(): Promise<CommandResult<T>> =>
    Promise.resolve({ ok: false, error: { code: 'operation_unavailable', message: 'Cults are not available in this test.' } })
  return {
    list: () => Promise.resolve({ ok: true, data: [] }),
    get: refused,
    create: refused,
    update: refused,
    delete: refused,
    models: () => Promise.resolve({ ok: true, data: { options: [], reason: 'No models in this test.' } }),
    archetypes: refused,
    start: refused,
    pause: refused,
    resume: refused,
    stop: refused,
    killNow: refused,
    raiseCap: refused,
    decidePetition: refused,
    dismissAcolyte: refused,
    runs: () => Promise.resolve({ ok: true, data: [] }),
    pipeline: refused,
    onEvent: () => () => {}
  }
}
