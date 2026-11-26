import type { ChatItem } from '../../../shared/agents/chat'
import type { AgentChatState } from './agentChatModel'

export const STALL_AFTER_MS = 30_000

type TurnActivity =
  | { kind: 'working'; elapsedMs: number; tool: string | null }
  | { kind: 'waiting' }
  | { kind: 'stalled'; silentMs: number }

/** Held prompts and running tools are intentional waits, not silent-agent stalls. */
export function turnActivity(state: AgentChatState, now: number): TurnActivity | null {
  if (state.status !== 'busy') return null
  if (state.pending !== null) return { kind: 'waiting' }
  let tool: string | null = null
  for (let index = state.items.length - 1; index >= 0; index--) {
    const item = state.items[index]
    if (item.kind === 'tool_call' && item.status === 'running') {
      tool = item.name
      break
    }
  }
  const silentMs = Math.max(0, now - state.lastEventAt)
  if (tool === null && silentMs >= STALL_AFTER_MS) return { kind: 'stalled', silentMs }
  return { kind: 'working', elapsedMs: Math.max(0, now - (state.turnStartedAt ?? now)), tool }
}

/** Whole elapsed seconds below an hour; whole minutes thereafter. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Thread headers carry their start time; tools are selected in transcript order. */
export function threadActivity(items: readonly ChatItem[], threadId: string, now: number): { elapsedMs: number; lastTool: string | null } {
  const first = threadId === '' ? items[0] : items.find((item) => item.kind === 'thread' && item.id === threadId)
  const startedAt = first ? Date.parse(first.at) : NaN
  let lastTool: string | null = null
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item.kind === 'tool_call' && (item.threadId ?? '') === threadId) {
      lastTool = item.name
      break
    }
  }
  return { elapsedMs: Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0, lastTool }
}
