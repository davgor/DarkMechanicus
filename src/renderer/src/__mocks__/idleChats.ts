/**
 * `window.dm.chats.mail` for renderer tests that do not exercise a mailbox.
 */
import type { ChatMailApi } from '../../../shared/agents/chatApi'
import type { CommandResult } from '../../../shared/desktop/api'

function refused(): Promise<CommandResult<never>> {
  return Promise.resolve({ ok: false, error: { code: 'unsupported_capability', message: 'Chats are not part of this test.' } })
}


/** `window.dm.chats.mail` with no mailbox anywhere: every folder's snapshot is empty and nothing is pushed. */
export function idleChatMail(): ChatMailApi {
  return {
    snapshot: (folder) => Promise.resolve({ ok: true, data: { folder, chats: [] } }),
    state: refused,
    read: refused,
    markSeen: refused,
    allowWake: refused,
    onEvent: () => () => {}
  }
}
