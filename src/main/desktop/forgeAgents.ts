import type { ChatRecord } from '../../shared/agents/chat'
import type { ChatRecords } from '../agents/chatRecords'
import type { ChatStore } from '../agents/chatStore'
import type { TerminalSessions } from '../terminals/terminalSessions'
import type { FolderAgentDefaults } from './folderAgentDefaults'

interface ResolverOptions {
  store: Pick<ChatStore, 'listChats' | 'updateChat'>
  chats: Pick<ChatRecords, 'createChat'>
  terminals: Pick<TerminalSessions, 'start' | 'paste' | 'isRunning' | 'deleteChat'>
  agents: { list(): { id: string }[] }
  folderDefaults: Pick<FolderAgentDefaults, 'get'>
  registry: { list(): { path: string; forgeParent?: string }[] }
  beforeArchive?: (chat: ChatRecord) => void
}

async function startResolverTerminal(terminals: ResolverOptions['terminals'], chat: ChatRecord, kickoff: string): Promise<void> {
  const stopped = !terminals.isRunning(chat.id)
  if (stopped && chat.firstPromptDelivery === 'uncertain') throw new Error('The resolver prompt delivery is uncertain. Inspect its chat before restarting it.')
  const delivered = chat.kickoffSent === true || chat.firstPromptDelivery === 'submitted'
  const started = stopped && delivered ? await terminals.paste(chat, kickoff) : await terminals.start(chat, { kickoff })
  if (started.state !== 'running') throw new Error(started.message)
}

export function forgeAgentSessions({ store, chats, terminals, agents, folderDefaults, registry, beforeArchive }: ResolverOptions) {
  const starting = new Map<string, Promise<void>>()
  const begin = async (root: string) => {
    const folder = root
    const prior = store.listChats(folder).find(chat => chat.forgeResolver === root && !chat.archived)
    const connected = agents.list()
    const preferred = folderDefaults.get(folder)
    const agent = connected.find(candidate => candidate.id === preferred)?.id ?? connected[0]?.id
    if (!agent) throw new Error('Connect an agent to resolve Forge World conflicts.')
    const kickoff = 'Resolve the repository merge in the Forge World at ' + root +
      '. Stay on main. Review the Git base and both revisions for every conflicted file, including documentation and attachments. Preserve ticket identities, valid references, repository mappings, and unrelated work; resolve delete/edit conflicts autonomously, validate the resulting records, and finish the merge commit. Never commit machine-private .darkmechanicus/local files. The desktop sync will validate, push main, and archive this background session.'
    const chat = prior ?? chats.createChat({ folder, agent, role: 'worker', allowSave: false, title: 'Resolve Forge World merge', firstPrompt: kickoff })
    const ref = { folder, id: chat.id }
    store.updateChat(ref, { forgeResolver: root })
    await startResolverTerminal(terminals, chat, kickoff)
  }
  return {
    onConflict: (root: string): Promise<void> => {
      const pending = starting.get(root)
      if (pending) return pending
      const work = begin(root).finally(() => starting.delete(root))
      starting.set(root, work)
      return work
    },
    onSynced: async (root: string) => {
      for (const folder of [root, null, ...registry.list().filter(f => f.forgeParent === root).map(f => f.path)]) {
        for (const chat of store.listChats(folder).filter(c => c.forgeResolver === root && !c.archived)) {
          const ref = { folder, id: chat.id }
          await terminals.deleteChat(ref, async () => {
            beforeArchive?.(chat)
            store.updateChat(ref, { archived: true })
          })
        }
      }
    }
  }
}
