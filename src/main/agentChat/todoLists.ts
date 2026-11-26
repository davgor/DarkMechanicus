import { z } from 'zod'
import type { AgentTodoPhase, AgentTodoTask } from '../../shared/agents/agentChat'
import { maskAgentChatSecretsDeep } from './secretMask'

const claudeStatus = z.enum(['pending', 'in_progress', 'completed'])
const taskFields = {
  content: z.string().min(1),
  activeForm: z.string().optional(),
  blocker: z.string().optional()
}
const todoWriteSchema = z.object({ todos: z.array(z.object({ ...taskFields, status: claudeStatus })).max(100) })
const ompSchema = z.array(z.object({
  name: z.string(),
  tasks: z.array(z.object({
    ...taskFields,
    id: z.string().max(64).nullable().optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'abandoned', 'blocked'])
  })).max(100)
})).max(20)
const createSchema = z.object({ subject: z.string().min(1), activeForm: z.string().optional() })
const updateSchema = z.object({ taskId: z.string(), status: z.enum(['pending', 'in_progress', 'completed', 'deleted']) })

function parse<T>(schema: z.ZodType<T>, input: unknown): T | null {
  // Untrusted inputs may contain throwing accessors, not just JSON values.
  try {
    const result = schema.safeParse(input)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

function text(value: string, limit = 500): string {
  const masked = maskAgentChatSecretsDeep(value)
  return masked.length > limit ? masked.slice(0, limit - 1) + '…' : masked
}

function task(value: Omit<AgentTodoTask, 'id'> & { id?: string | null }): AgentTodoTask {
  return {
    id: value.id == null ? null : text(value.id, 64),
    content: text(value.content),
    status: value.status,
    ...(value.activeForm === undefined ? {} : { activeForm: text(value.activeForm) }),
    ...(value.status !== 'blocked' || value.blocker === undefined ? {} : { blocker: text(value.blocker) })
  }
}

/** A successful TodoWrite replaces the entire list; null means keep the previous list. */
export function todoWritePhases(input: unknown): AgentTodoPhase[] | null {
  const value = parse(todoWriteSchema, input)
  return value === null ? null : [{ name: '', tasks: value.todos.map(task) }]
}

/** Pass result.details.phases or get_state.data.todoPhases, not the enclosing frame. */
export function ompTodoPhases(input: unknown): AgentTodoPhase[] | null {
  const value = parse(ompSchema, input)
  if (value === null || value.reduce((count, phase) => count + phase.tasks.length, 0) > 100) return null
  return value.map(phase => ({ name: text(phase.name, 200), tasks: phase.tasks.map(task) }))
}

export type TaskList = {
  tasks: AgentTodoTask[]
  pendingCreates: Record<string, { content: string; activeForm?: string }>
}

/** Inputs are retained only until their matching successful tool result arrives. */
export function taskCreateStarted(list: TaskList, toolUseId: string, input: unknown): TaskList {
  const value = parse(createSchema, input)
  if (value === null || typeof toolUseId !== 'string') return list
  const key = maskAgentChatSecretsDeep(toolUseId)
  if (Object.hasOwn(list.pendingCreates, key) || list.tasks.length + Object.keys(list.pendingCreates).length >= 100) return list
  return {
    tasks: list.tasks,
    pendingCreates: {
      ...list.pendingCreates,
      [key]: { content: text(value.subject), ...(value.activeForm === undefined ? {} : { activeForm: text(value.activeForm) }) }
    }
  }
}

export function taskCreateResult(list: TaskList, toolUseId: string, resultText: unknown): TaskList {
  if (typeof toolUseId !== 'string') return list
  const key = maskAgentChatSecretsDeep(toolUseId)
  if (!Object.hasOwn(list.pendingCreates, key)) return list
  const pending = list.pendingCreates[key]
  const pendingCreates = { ...list.pendingCreates }
  delete pendingCreates[key]
  const match = typeof resultText === 'string' ? /Task #(\d+)/.exec(resultText) : null
  const id = match && match[1].length <= 64 ? match[1] : null
  return { tasks: [...list.tasks, { ...pending, id, status: 'pending' }], pendingCreates }
}

/** Skipped updates preserve object identity, allowing callers to count one skipped line. */
export function taskUpdate(list: TaskList, input: unknown): { list: TaskList; skipped: boolean } {
  const value = parse(updateSchema, input)
  if (value === null) return { list, skipped: true }
  const index = list.tasks.findIndex(item => item.id !== null && item.id === value.taskId)
  if (index < 0) return { list, skipped: true }
  const tasks = list.tasks.slice()
  if (value.status === 'deleted') tasks.splice(index, 1)
  else tasks[index] = task({ ...tasks[index], status: value.status })
  return { list: { tasks, pendingCreates: list.pendingCreates }, skipped: false }
}

export function taskPhases(list: TaskList): AgentTodoPhase[] {
  return [{ name: '', tasks: list.tasks.map(task) }]
}
