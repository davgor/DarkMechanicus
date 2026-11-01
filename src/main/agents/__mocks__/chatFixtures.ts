/**
 * Test doubles for the chats: connected agents, tracked folders, and an in-memory chat store with a way to
 * seed the transcript an app from before terminals stored. Not shipped.
 */
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { ChatItem } from '../../../shared/agents/chat'
import { AGENT_DEFINITIONS } from '../../../shared/desktop/agentKinds'
import type { AgentId, AgentView, BuiltInAgentKind } from '../../../shared/desktop/api'
import { createChatStore, type ChatRef, type ChatStore, type ChatStoreFs } from '../chatStore'

export const REPO = resolve('/work/repo')
export const AT = '2026-01-01T00:00:00.000Z'
/** Where `memoryChatStore` keeps its chats. */
const CHAT_ROOT = resolve('/state/agents/chats')

/** A connected built-in agent as the registry lists it, at `/bin/<kind>`. */
export function builtInAgent(kind: BuiltInAgentKind, overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: kind,
    kind,
    displayName: AGENT_DEFINITIONS[kind].displayName,
    executablePath: `/bin/${kind}`,
    args: [],
    version: '1.0.0',
    needsReview: false,
    connectedVia: 'found',
    connectedAt: AT,
    lastProbed: AT,
    ...overrides
  }
}

/** An `agentFor`: the listed agents are connected, anything else is not. */
export function connectedAgents(agents: readonly AgentView[] = [builtInAgent('claude'), builtInAgent('codex'), builtInAgent('cursor')]): (id: AgentId) => AgentView | null {
  return (id) => agents.find((agent) => agent.id === id) ?? null
}

/** The in-memory filesystem, with its files open for tests to inspect. */
export interface MemoryChatFs extends ChatStoreFs {
  files: Map<string, string>
}

/** An in-memory filesystem holding `folders`, shared by stores to stand for an app restart. */
export function memoryChatFs(folders: readonly string[] = [REPO]): MemoryChatFs {
  const files = new Map<string, string>()
  const dirs = new Set(folders)
  return {
    files,
    removeFile(path) {
      files.delete(path)
    },
    replaceFile(path, data) {
      files.set(path, data)
    },
    readFile(path) {
      const data = files.get(path)
      if (data === undefined) {
        throw new Error(`ENOENT: ${path}`)
      }
      return data
    },
    appendFile(path, data) {
      files.set(path, (files.get(path) ?? '') + data)
    },
    mkdirp() {},
    realpath(path) {
      const resolved = resolve(path)
      if (!dirs.has(resolved)) {
        throw new Error(`ENOENT: ${path}`)
      }
      return resolved
    }
  }
}

let chatCount = 0

/** A chat store over `fs` with deterministic, increasing timestamps. */
export function memoryChatStore(fs: ChatStoreFs = memoryChatFs()): ChatStore {
  let tick = 0
  return createChatStore({
    root: CHAT_ROOT,
    fs,
    now: () => {
      tick += 1
      return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
    },
    newId: () => {
      chatCount += 1
      return `chat_${chatCount}`
    }
  })
}

/** Where the store keeps a chat's transcript: `<root>/<hash of the canonical folder>/<chat id>.jsonl`. */
function transcriptPath(chat: ChatRef, root: string = CHAT_ROOT): string {
  const key = createHash('sha256').update(chat.folder).digest('hex').slice(0, 24)
  return join(root, key, `${chat.id}.jsonl`)
}

/**
 * Appends `items` to the chat's transcript as an app from before terminals wrote them, one JSON line each (a later
 * line with the same id replaces the earlier one). `chat.folder` must be the canonical folder, as stored records have it.
 */
export function storeItems(fs: ChatStoreFs, chat: ChatRef, items: readonly ChatItem[], root: string = CHAT_ROOT): void {
  fs.appendFile(
    transcriptPath(chat, root),
    items.map((item) => `${JSON.stringify(item)}\n`).join('')
  )
}
