import type { ChatRecords } from '../agents/chatRecords'
import type { ChatStore } from '../agents/chatStore'
import type { TerminalSessions } from '../terminals/terminalSessions'
import type { FolderAgentDefaults } from './folderAgentDefaults'

interface ResolverOptions {
  store: Pick<ChatStore, 'listChats' | 'updateChat'>
  chats: Pick<ChatRecords, 'createChat'>
  terminals: Pick<TerminalSessions, 'start' | 'deleteChat'>
  agents: { list(): { id: string }[] }
  folderDefaults: Pick<FolderAgentDefaults, 'get'>
  registry: { list(): { path: string; forgeParent?: string }[] }
}

export function forgeAgentSessions({ store, chats, terminals, agents, folderDefaults, registry }: ResolverOptions) {
  return {
    onConflict: async (root: string, folder: string | null) => {
      const prior = store.listChats(folder).find(chat => chat.forgeResolver === root && !chat.archived)
      const agent = (folder && folderDefaults.get(folder)) ?? agents.list()[0]?.id
      if (!agent) throw new Error('Connect an agent to resolve Forge World conflicts.')
      const kickoff = 'Resolve the ticket-file merge in the Forge World at ' + root +
        '. Review both revisions, preserve ticket identities and valid references, resolve delete/edit conflicts autonomously, validate the resulting records, and finish the merge commit. The desktop sync will push and archive this session.'
      const chat = prior ?? chats.createChat({ folder, agent, role: 'worker', allowSave: false, title: 'Resolve Forge World merge', firstPrompt: kickoff })
      const ref = { folder, id: chat.id }
      store.updateChat(ref, { forgeResolver: root })
      const started = await terminals.start(ref, { kickoff })
      if (started.state !== 'running') throw new Error(started.message)
    },
    onSynced: async (root: string) => {
      for (const folder of [null, ...registry.list().filter(f => f.forgeParent === root).map(f => f.path)]) {
        for (const chat of store.listChats(folder).filter(c => c.forgeResolver === root && !c.archived)) {
          const ref = { folder, id: chat.id }
          await terminals.deleteChat(ref, async () => { store.updateChat(ref, { archived: true }) })
        }
      }
    }
  }
}
