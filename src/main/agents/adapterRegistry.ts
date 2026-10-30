/**
 * How the app runs each agent protocol's chats. The session manager looks up the chat's agent, takes
 * the definition for that agent's protocol here, and hands it the executable the person connected.
 */
import type { ChatAdapter, ModelOption } from '../../shared/agents/chat'
import type { AgentProtocol } from '../../shared/desktop/api'
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

export type ChatAdapterDefinitions = Record<AgentProtocol, ChatAdapterDefinition>

/** The adapters this build ships; ACP agents run on the Cursor adapter for now. */
export const CHAT_ADAPTERS: ChatAdapterDefinitions = {
  claude: claudeAdapterDefinition,
  codex: CODEX_ADAPTER,
  acp: cursorAdapterDefinition
}
