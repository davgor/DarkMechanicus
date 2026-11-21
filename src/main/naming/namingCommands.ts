import { namingOperationSchema, NamingControlError } from '../../shared/agents/chatNaming'
import type { ChatPushEvent } from '../../shared/agents/chatApi'
import type { ChatStore } from '../agents/chatStore'
import type { NamingDispatcher } from './controlPipe'

interface NamingDeps {
  store: Pick<ChatStore, 'getChat' | 'updateChat'>
  push(event: ChatPushEvent): void
}
const normalized = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/gu, ' ').trim()
/** Authenticated metadata publication; manual and system titles always win at the final synchronous fence. */
export function createNamingDispatcher(deps: NamingDeps): NamingDispatcher {
  return (input, context) => {
    const parsed = namingOperationSchema.safeParse(input)
    if (!parsed.success || parsed.data.op !== 'name_chat') throw new NamingControlError('invalid_request')
    const args = parsed.data.args
    const { binding } = context
    const ref = { folder: binding.folder, id: binding.chatId }
    let applied = false
    context.publish(() => {
      const chat = deps.store.getChat(ref)
      if (!chat) throw new NamingControlError('not_found')
      if (chat.titleStatus !== 'pending' || chat.firstPrompt === undefined || chat.runId !== undefined || chat.transferEpicId !== undefined || chat.cardId !== undefined) return
      if ('title' in args) {
        const label = normalized(args.title)
        if (label === '' || normalized(chat.firstPrompt).startsWith(label)) throw new NamingControlError('invalid_input')
        deps.store.updateChat(ref, { title: args.title, titleStatus: 'generated' })
      } else deps.store.updateChat(ref, { title: 'Chat naming failed', titleStatus: 'failed', titleError: args.error })
      applied = true
      deps.push({ type: 'chats_changed', folder: ref.folder, chatId: ref.id })
    })
    return { applied }
  }
}
