import { TODO_TOOL_NAMES, type AgentTodoPhase, type AgentTodoTask } from '../../../shared/agents/agentChat'
import type { ChatItem } from '../../../shared/agents/chat'

export function todoProgress(phases: readonly AgentTodoPhase[]): { closed: number; total: number } {
  let closed = 0
  let total = 0
  for (const phase of phases) {
    for (const task of phase.tasks) {
      total++
      if (task.status === 'completed' || task.status === 'abandoned') closed++
    }
  }
  return { closed, total }
}

export function todoProgressLabel(phases: readonly AgentTodoPhase[]): string | null {
  const { closed, total } = todoProgress(phases)
  return total ? `${closed}/${total}` : null
}

/** Preserve phase/task order and the task itself, including its optional activeForm. */
export function activeTask(phases: readonly AgentTodoPhase[]): AgentTodoTask | null {
  for (const phase of phases) {
    const task = phase.tasks.find((task) => task.status === 'in_progress')
    if (task) return task
  }
  return null
}

export interface TodoMemory {
  hadOpenTasks: boolean
  finishedInTurn: number | null
}

/**
 * Keep one memory per thread. null initializes it, including after a reload.
 * Only an observed open-to-closed transition earns lingering; closed snapshots
 * never earn it. Idle, a different turn, or an empty list permanently expires it.
 */
export function nextTodoMemory(
  memory: TodoMemory | null,
  { phases, turn, busy }: { phases: readonly AgentTodoPhase[]; turn: number; busy: boolean }
): TodoMemory {
  const { closed, total } = todoProgress(phases)
  const hadOpenTasks = closed < total
  const finishedInTurn = !hadOpenTasks && total > 0 && busy
    ? memory?.hadOpenTasks ? turn : memory?.finishedInTurn === turn ? turn : null
    : null
  return { hadOpenTasks, finishedInTurn }
}

/** Read with the memory advanced for the current inputs; open tasks always show. */
export function showsTodoCard(
  memory: TodoMemory | null, phases: readonly AgentTodoPhase[], turn: number, busy: boolean
): boolean {
  const { closed, total } = todoProgress(phases)
  return total > 0 && (closed < total || (busy && memory?.finishedInTurn === turn))
}

export function isTodoToolCall(item: ChatItem): item is Extract<ChatItem, { kind: 'tool_call' }> {
  return item.kind === 'tool_call' && TODO_TOOL_NAMES.some((name) => name === item.name)
}

/** Errors remain news. Lazy copying preserves memoization when no call is hidden. */
export function withoutTodoCalls(items: ChatItem[]): ChatItem[] {
  let visible: ChatItem[] | undefined
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (isTodoToolCall(item) && (item.status === 'running' || item.status === 'completed')) {
      visible ??= items.slice(0, index)
    } else {
      visible?.push(item)
    }
  }
  return visible ?? items
}
