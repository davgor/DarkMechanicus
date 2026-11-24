import type { ChatRecord } from '../../shared/agents/chat'
import type { AgentAuthState, AgentId } from '../../shared/desktop/api'
import type { ChatRecords } from '../agents/chatRecords'
import type { ChatStore } from '../agents/chatStore'
import type { TerminalSessions } from '../terminals/terminalSessions'
import type { FolderAgentDefaults } from './folderAgentDefaults'

interface ResolverOptions {
  store: Pick<ChatStore, 'listChats' | 'updateChat'>
  chats: Pick<ChatRecords, 'createChat'>
  terminals: Pick<TerminalSessions, 'start' | 'paste' | 'isRunning' | 'deleteChat'>
  agents: { list(): { id: AgentId }[] }
  checkAuth(id: AgentId): Promise<AgentAuthState>
  folderDefaults: Pick<FolderAgentDefaults, 'get'>
  registry: { list(): { path: string; forgeParent?: string }[] }
  beforeArchive?: (chat: ChatRecord) => void | Promise<void>
}

async function startResolverTerminal(terminals: ResolverOptions['terminals'], chat: ChatRecord, kickoff: string): Promise<boolean> {
  if (terminals.isRunning(chat.id)) return true
  if (chat.firstPromptDelivery === 'uncertain') throw new Error('The resolver prompt delivery is uncertain. Inspect its chat before restarting it.')
  const delivered = chat.kickoffSent === true || chat.firstPromptDelivery === 'submitted'
  const started = delivered ? await terminals.paste(chat, kickoff) : await terminals.start(chat, { kickoff })
  if (started.state === 'signed_out') return false
  if (started.state !== 'running') throw new Error(started.message)
  return true
}

function resolverCandidates({ agents, folderDefaults }: ResolverOptions, root: string, prior: ChatRecord[]): Set<AgentId> {
  const connected = new Set(agents.list().map(candidate => candidate.id))
  if (connected.size === 0) throw new Error('Connect an agent to resolve Forge World conflicts.')
  const preferred = folderDefaults.get(root)
  const candidates = new Set<AgentId>()
  if (preferred !== null && connected.has(preferred)) candidates.add(preferred)
  for (const chat of prior) {
    if (connected.has(chat.agent)) candidates.add(chat.agent)
  }
  for (const id of connected) candidates.add(id)
  return candidates
}

async function beginResolver(options: ResolverOptions, root: string, assertCurrent?: () => void): Promise<void> {
  const { store, chats, terminals, checkAuth } = options
  const prior = store.listChats(root).filter(chat => chat.forgeResolver === root && !chat.archived)
  if (prior.some(chat => terminals.isRunning(chat.id))) return
  if (prior.some(chat => chat.firstPromptDelivery === 'uncertain')) throw new Error('The resolver prompt delivery is uncertain. Inspect its chat before restarting it.')

  const candidates = resolverCandidates(options, root, prior)
  const kickoff = 'Resolve the repository merge in the Forge World at ' + JSON.stringify(root) +
    '. Stay on main and use the Git merge base and both merge parents to review every conflict. If no merge is in progress, stop without editing. ' +
    'For incompatible changes, prefer existing remote main (MERGE_HEAD, theirs) when this merge fetched remote main. ' +
    'When recovering an off-main local branch into existing local main, prefer HEAD (ours) instead. Check the merge message and Git refs to identify the parent roles before choosing. ' +
    'Preserve compatible changes from both sides, including within each file; do not take one side wholesale. Review delete/edit conflicts, ticket identities, references, repository mappings, documentation and attachments. ' +
    'Validate the resolved records and finish the merge commit with both parents. Do not abort the merge, rewrite history, push, or commit machine-private .darkmechanicus/local files. The desktop will validate, push main, and archive this background session.'
  for (const id of candidates) {
    if (await checkAuth(id).catch(() => 'unknown') !== 'signed_in') continue
    assertCurrent?.()
    const chat = prior.find(candidate => candidate.agent === id) ??
      await chats.createChat({ folder: root, agent: id, role: 'worker', allowSave: false, title: 'Resolve Forge World merge', firstPrompt: kickoff })
    store.updateChat(chat, { forgeResolver: root })
    assertCurrent?.()
    if (await startResolverTerminal(terminals, chat, kickoff)) return
  }
  throw new Error('Sign in to an agent to resolve Forge World conflicts.')
}

export function forgeAgentSessions(options: ResolverOptions) {
  const { store, terminals, registry, beforeArchive } = options
  const starting = new Map<string, Promise<void>>()
  return {
    onConflict: (root: string, assertCurrent?: () => void): Promise<void> => {
      const pending = starting.get(root)
      if (pending) return pending
      const work = beginResolver(options, root, assertCurrent).finally(() => starting.delete(root))
      starting.set(root, work)
      return work
    },
    onSynced: async (root: string) => {
      for (const folder of [root, null, ...registry.list().filter(f => f.forgeParent === root).map(f => f.path)]) {
        for (const chat of store.listChats(folder).filter(c => c.forgeResolver === root && !c.archived)) {
          const ref = { folder, id: chat.id }
          await terminals.deleteChat(ref, async () => {
            await beforeArchive?.(chat)
            store.updateChat(ref, { archived: true })
          })
        }
      }
    }
  }
}
