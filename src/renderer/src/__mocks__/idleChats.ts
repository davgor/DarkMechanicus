/**
 * `window.dm.chats` for renderer tests that are not about chats: no folder has chats, nothing is
 * bound, nothing is pushed, and every other request is refused as unavailable.
 */
import type { ChatsApi } from '../../../shared/agents/chatApi'
import type { CommandResult } from '../../../shared/desktop/api'

function refused(): Promise<CommandResult<never>> {
  return Promise.resolve({ ok: false, error: { code: 'unsupported_capability', message: 'Chats are not part of this test.' } })
}

export function idleChats(): ChatsApi {
  return {
    list: () => Promise.resolve({ ok: true, data: [] }),
    create: refused,
    startOrchestrator: refused,
    read: refused,
    boundThreads: () => Promise.resolve({ ok: true, data: [] }),
    boundTerminal: () => Promise.resolve({ ok: true, data: null }),
    rename: refused,
    delete: refused,
    onEvent: () => () => {}
  }
}
