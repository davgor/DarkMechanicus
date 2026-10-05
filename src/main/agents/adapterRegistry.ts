/**
 * How the app runs each agent kind's chats. A vendor adapter (Claude Code, Codex, Cursor) plugs in
 * by adding its definition to `CHAT_ADAPTERS`; the session manager looks the kind up there and
 * hands the definition the executable the person connected.
 */
import type { ChatAdapter, ModelOption } from '../../shared/agents/chat'
import type { AgentKind } from '../../shared/desktop/api'
import { claudeAdapterDefinition } from './adapters/claude'
import { CODEX_ADAPTER } from './adapters/codex'
import { cursorAdapterDefinition } from './adapters/cursor'

export interface ChatAdapterDefinition {
  /** True when the vendor's process must run as soon as a chat is opened, not on its first message. */
  startOnOpen: boolean
  /** A new adapter, not started yet, that runs `executablePath` (from the agent registry, never the renderer). */
  create(executablePath: string): ChatAdapter
  /** The models the agent offers, without a chat. */
  listModels(executablePath: string): Promise<ModelOption[]>
}

export type ChatAdapterDefinitions = Partial<Record<AgentKind, ChatAdapterDefinition>>

/** The adapters this build ships; a kind with none yet cannot start chats. */
export const CHAT_ADAPTERS: ChatAdapterDefinitions = {
  claude: claudeAdapterDefinition,
  codex: CODEX_ADAPTER,
  cursor: cursorAdapterDefinition
}
