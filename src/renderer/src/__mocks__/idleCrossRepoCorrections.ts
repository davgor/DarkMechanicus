/**
 * `window.dm.crossRepoCorrections` for renderer tests that are not about cross-repository corrections: no checkout is
 * chosen, so nothing can be previewed, created or retried, and no folder has receipts.
 */
import type { CrossRepoCorrectionsApi } from '../../../shared/desktop/crossRepoCorrections'

export function idleCrossRepoCorrections(): CrossRepoCorrectionsApi {
  const none = { ok: false as const, error: { code: 'not_found' as const, message: 'No Dark Mechanicus checkout is chosen on this machine.' } }
  return {
    preview: () => Promise.resolve(none),
    create: () => Promise.resolve(none),
    retry: () => Promise.resolve(none),
    withdraw: () => Promise.resolve(none),
    list: () => Promise.resolve({ ok: true, data: [] }),
    collectResults: () => Promise.resolve(none)
  }
}
