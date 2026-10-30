/**
 * How the app runs each agent protocol's chats. The session manager looks up the chat's agent, takes
 * the definition for that agent's protocol here, and hands it the agent's launch spec (`launchSpec.ts`).
 */
import type { ChatAdapter, ModelOption } from '../../shared/agents/chat'
import type { AgentProtocol } from '../../shared/desktop/api'
import { acpAdapterDefinition, type AcpFlavor } from './adapters/acp/acpAdapter'
import { genericAcpFlavor } from './adapters/acp/genericAcpFlavor'
import { autonomousFlavor } from './adapters/autonomous'
import { claudeAdapterDefinition } from './adapters/claude'
import { CODEX_ADAPTER } from './adapters/codex'
import { cursorFlavor } from './adapters/cursor'
import type { AgentLaunchSpec } from './launchSpec'

export interface ChatAdapterDefinition {
  /** True when the vendor's process must run as soon as a chat is opened, not on its first message. */
  startOnOpen: boolean
  /** A new adapter, not started yet, that runs the spec (built from the agent registry, never the renderer). */
  create(spec: AgentLaunchSpec): ChatAdapter
  /** The models the agent offers, without a chat. */
  listModels(spec: AgentLaunchSpec): Promise<ModelOption[]>
}

export type ChatAdapterDefinitions = Record<AgentProtocol, ChatAdapterDefinition>

/** The built-in ACP agents' own flavors; any other ACP agent (a custom CLI) runs on the generic one. */
const BUILT_IN_ACP_FLAVORS: Partial<Record<AgentLaunchSpec['kind'], AcpFlavor>> = {
  cursor: cursorFlavor,
  autonomous: autonomousFlavor
}

/** The adapters this build ships. */
export const CHAT_ADAPTERS: ChatAdapterDefinitions = {
  claude: claudeAdapterDefinition,
  codex: CODEX_ADAPTER,
  acp: acpAdapterDefinition((spec) => BUILT_IN_ACP_FLAVORS[spec.kind] ?? genericAcpFlavor(spec.displayName))
}
