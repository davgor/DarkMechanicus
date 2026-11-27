import type { BrowserOperation, BrowserReply } from '../../shared/browser/browserControl'
import { createControlClient, type ControlClientOptions } from './controlClient'
import { BROWSER_PROTOCOL } from './controlProtocol'

export interface BrowserClient {
  request(operation: BrowserOperation, options?: { signal?: AbortSignal }): Promise<BrowserReply>
}

/**
 * The browser pipe's client: one connection per request, no retry (a click or a navigation is not idempotent). The
 * address comes from `DM_BROWSER_PIPE`, which only a chat whose grant holds `browser.drive` is started with.
 */
export function createBrowserClient(options: ControlClientOptions = {}): BrowserClient {
  return createControlClient({ ...options, protocol: BROWSER_PROTOCOL, envVar: 'DM_BROWSER_PIPE' })
}
