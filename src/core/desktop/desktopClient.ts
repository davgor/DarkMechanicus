import type { NamingOperation, NamingReply } from '../../shared/agents/chatNaming'
import { createControlClient, type ControlClientOptions } from './controlClient'
import { NAMING_PROTOCOL } from './controlProtocol'

export interface DesktopClient {
  request(operation: NamingOperation, options?: { signal?: AbortSignal }): Promise<NamingReply>
}

/** One connection per request, no retry (naming changes metadata). No Electron dependency. */
export function createDesktopClient(options: ControlClientOptions = {}): DesktopClient {
  return createControlClient({ ...options, protocol: NAMING_PROTOCOL, envVar: 'DM_DESKTOP_PIPE' })
}
