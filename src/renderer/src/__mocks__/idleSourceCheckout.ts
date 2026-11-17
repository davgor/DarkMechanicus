/**
 * `window.dm.sourceCheckout` for renderer tests that are not about the Dark Mechanicus checkout: none is chosen, the
 * dialog is always cancelled, and associating a folder is refused as untracked.
 */
import type { SourceCheckoutApi, SourceCheckoutView } from '../../../shared/desktop/sourceCheckout'

export function idleSourceCheckout(): SourceCheckoutApi {
  const none: SourceCheckoutView = {
    status: 'none',
    target: null,
    local: null,
    problem: null,
    message: null,
    recovery: 'Choose your Dark Mechanicus checkout.'
  }
  return {
    get: () => Promise.resolve(none),
    pick: () => Promise.resolve({ outcome: 'cancelled' }),
    associate: () => Promise.reject(new Error('That folder is not tracked by Dark Mechanicus.')),
    clear: () => Promise.resolve(none)
  }
}
