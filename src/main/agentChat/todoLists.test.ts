import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { agentTodoPhaseSchema } from '../../shared/agents/agentChat'
import { GRANT_TOKEN_MASK } from '../../core/storedSecrets'
import { CLAIM_TOKEN_MASK } from '../agents/claimTokenMask'
import { ompTodoPhases, taskCreateResult, taskCreateStarted, taskPhases, taskUpdate, todoWritePhases, type TaskList } from './todoLists'

const blockSchema = z.object({ type: z.string(), id: z.string().optional(), name: z.string().optional(), input: z.unknown().optional(), tool_use_id: z.string().optional(), content: z.unknown().optional() })
function frames(protocol: string, name: string): unknown[] {
  return readFileSync(join(__dirname, '__fixtures__', protocol, `${name}.out.jsonl`), 'utf8')
    .trim().split(/\r?\n/).map(line => JSON.parse(line) as unknown)
}
function claudeBlocks(name: string): z.infer<typeof blockSchema>[] {
  const frame = z.object({ message: z.object({ content: z.array(blockSchema) }) })
  return frames('claude', name).flatMap(value => {
    const result = frame.safeParse(value)
    return result.success ? result.data.message.content : []
  })
}
function ompFixture(): unknown {
  const end = z.object({ type: z.literal('tool_execution_end'), result: z.object({ details: z.object({ phases: z.unknown() }) }) })
  return frames('omp', 'todo').flatMap(value => {
    const result = end.safeParse(value)
    return result.success ? [result.data.result.details.phases] : []
  })[0]
}
const empty = (): TaskList => ({ tasks: [], pendingCreates: {} })
const grant = 'dmg_' + 'ab'.repeat(32)
const claim = 'at_' + '0'.repeat(26) + '.' + 's'.repeat(32)
const secrets = `${grant} ${claim}`
const masked = `${GRANT_TOKEN_MASK} ${CLAIM_TOKEN_MASK}`

function created(input: unknown = { subject: 'x' }, result: unknown = 'Task #1 created successfully: x'): TaskList {
  return taskCreateResult(taskCreateStarted(empty(), 'create', input), 'create', result)
}

describe('todoWritePhases', () => {
  it('replaces the golden whole list with each status, without mutating the previous list', () => {
    const calls = claudeBlocks('todo').filter(block => block.name === 'TodoWrite')
    expect(calls).toHaveLength(3)
    const first = todoWritePhases(calls[0].input)
    expect(first).toEqual([{ name: '', tasks: [
      { id: null, content: 'Read file', activeForm: 'Reading file', status: 'in_progress' },
      { id: null, content: 'Edit file', activeForm: 'Editing file', status: 'pending' }
    ] }])
    const before = JSON.stringify(first)
    const second = todoWritePhases(calls[1].input)
    expect(second?.[0].tasks.map(task => task.status)).toEqual(['completed', 'in_progress'])
    expect(JSON.stringify(first)).toBe(before)
    expect(todoWritePhases(calls[2].input)).toEqual(first)
    expect(todoWritePhases({ todos: [] })).toEqual([{ name: '', tasks: [] }])
    expect(second?.every(phase => agentTodoPhaseSchema.safeParse(phase).success)).toBe(true)
  })

  it.each([
    { status: 'pending' }, { content: '', status: 'pending' }, { content: 42, status: 'pending' },
    { content: 'x', status: 'blocked' }, { content: 'x', status: 'unknown' },
    { content: 'x', status: 'pending', activeForm: 42 }, { content: 'x', status: 'pending', blocker: false }
  ])('rejects the entire list for malformed task %j', bad => {
    expect(todoWritePhases({ todos: [{ content: 'good', status: 'completed' }, bad] })).toBeNull()
  })
})

describe('incremental Claude tasks', () => {
  it('binds golden create results and applies golden updates, completion, deletion and unknown ids', () => {
    const blocks = claudeBlocks('tasks')
    let list = empty()
    for (const block of blocks) {
      if (block.name === 'TaskCreate') {
        const before = list
        list = taskCreateStarted(list, block.id!, block.input)
        expect(list.tasks).toBe(before.tasks)
        expect(Object.keys(list.pendingCreates)).toHaveLength(1)
      } else if (block.type === 'tool_result' && block.tool_use_id?.includes('create')) {
        list = taskCreateResult(list, block.tool_use_id, block.content)
        expect(Object.keys(list.pendingCreates)).toHaveLength(0)
      } else if (block.name === 'TaskUpdate') {
        const before = list
        const result = taskUpdate(list, block.input)
        const input = z.object({ taskId: z.string(), status: z.string() }).parse(block.input)
        if (input.taskId === '99') {
          expect(result).toEqual({ list: before, skipped: true })
          expect(result.list).toBe(before)
        } else {
          expect(result.skipped).toBe(false)
          expect(result.list.tasks[0].status).toBe(input.status)
          expect(result.list).not.toBe(before)
        }
        list = result.list
      }
    }
    expect(taskPhases(list)).toEqual([{ name: '', tasks: [
      { id: '1', content: 'Task 1', activeForm: 'Doing task 1', status: 'completed' },
      { id: '2', content: 'Task 2', activeForm: 'Doing task 2', status: 'pending' }
    ] }])
    const deleted = taskUpdate(list, { taskId: '1', status: 'deleted' })
    expect(deleted.skipped).toBe(false)
    expect(deleted.list.tasks.map(task => task.id)).toEqual(['2'])
    expect(list.tasks).toHaveLength(2)
  })

})

describe('incremental Claude task edge cases', () => {
  it('keeps unmatched results unaddressable and ignores unknown or repeated tool results', () => {
    const list = created({ subject: 'x' }, 'created without an id')
    expect(list.tasks).toEqual([{ content: 'x', id: null, status: 'pending' }])
    expect(taskUpdate(list, { taskId: 'null', status: 'completed' })).toEqual({ list, skipped: true })
    expect(taskCreateResult(list, 'missing', 'Task #2')).toBe(list)
    expect(taskCreateResult(list, 'create', 'Task #2')).toBe(list)
    expect(created({ subject: 'x' }, 42).tasks[0].id).toBeNull()
    expect(created({ subject: 'x' }, 'Task #' + '1'.repeat(65)).tasks[0].id).toBeNull()
  })

  it('binds out-of-order creates and treats prototype-named tool ids as ordinary keys', () => {
    let list = taskCreateStarted(empty(), '__proto__', { subject: 'first' })
    list = taskCreateStarted(list, 'constructor', { subject: 'second' })
    const before = JSON.stringify(list)
    const second = taskCreateResult(list, 'constructor', 'Task #2 created successfully')
    expect(JSON.stringify(list)).toBe(before)
    expect(taskCreateResult(second, '__proto__', 'Task #1 created successfully').tasks.map(task => task.id)).toEqual(['2', '1'])
    expect(taskCreateResult(empty(), 'toString', 'Task #3')).toEqual(empty())
    expect(taskCreateStarted(list, '__proto__', { subject: 'replacement' })).toBe(list)
  })

  it.each([undefined, 42, [], {}, { subject: 42 }, { subject: '' }, { subject: 'x', activeForm: null }])('ignores invalid create %j', input => {
    const list = empty()
    expect(taskCreateStarted(list, 'create', input)).toBe(list)
  })

  it.each([undefined, 42, [], {}, { taskId: 1, status: 'pending' }, { taskId: '1', status: 'blocked' }, { taskId: '1', status: 'unknown' }])('skips invalid update %j', input => {
    const list = created()
    const result = taskUpdate(list, input)
    expect(result.skipped).toBe(true)
    expect(result.list).toBe(list)
  })

  it('caps completed and pending creates together at 100 tasks', () => {
    let list = empty()
    for (let i = 0; i < 100; i++) list = taskCreateStarted(list, String(i), { subject: String(i) })
    expect(taskCreateStarted(list, 'overflow', { subject: 'overflow' })).toBe(list)
    for (let i = 0; i < 100; i++) list = taskCreateResult(list, String(i), `Task #${i}`)
    expect(list.tasks).toHaveLength(100)
    expect(taskCreateStarted(list, 'overflow', { subject: 'overflow' })).toBe(list)
    expect(agentTodoPhaseSchema.safeParse(taskPhases(list)[0]).success).toBe(true)
  })
})

describe('ompTodoPhases', () => {
  it('normalizes golden result and resumed state, retaining blocked blockers and abandoned tasks', () => {
    const expected = [
      { name: 'Implement', tasks: [
        { id: 'todo_T1_1', content: 'Add banner', status: 'in_progress' },
        { id: 'todo_T1_2', content: 'Wait for API', status: 'blocked', blocker: 'API unavailable' }
      ] },
      { name: 'Review', tasks: [{ id: 'todo_T1_3', content: 'Old approach', status: 'abandoned' }] }
    ]
    expect(ompTodoPhases(ompFixture())).toEqual(expected)
    const stateSchema = z.object({ command: z.literal('get_state'), data: z.object({ todoPhases: z.unknown() }) })
    const state = frames('omp', 'init_resume').map(value => stateSchema.safeParse(value)).find(result => result.success)
    expect(state?.success).toBe(true)
    expect(ompTodoPhases(state?.data?.data.todoPhases)).toEqual(expected)
    expect(expected.every(phase => agentTodoPhaseSchema.safeParse(phase).success)).toBe(true)
    expect(ompTodoPhases([])).toEqual([])
  })

  it('drops non-blocked blockers and defaults absent ids to null', () => {
    expect(ompTodoPhases([{ name: '', tasks: ['pending', 'in_progress', 'completed', 'abandoned'].map(status => ({ content: 'x', status, blocker: 'irrelevant' })) }]))
      .toEqual([{ name: '', tasks: ['pending', 'in_progress', 'completed', 'abandoned'].map(status => ({ id: null, content: 'x', status })) }])
  })

  it.each([
    { status: 'pending' }, { content: 'x', status: 'unknown' }, { content: 'x', status: 42 },
    { content: 'x', status: 'blocked', blocker: 42 }, { content: 'x', status: 'pending', activeForm: false },
    { content: 'x', status: 'pending', id: 42 }, { content: 'x', status: 'pending', id: 'a'.repeat(65) }
  ])('rejects all phases when one task is invalid: %j', bad => {
    expect(ompTodoPhases([{ name: 'good', tasks: [{ content: 'good', status: 'pending' }] }, { name: 'bad', tasks: [bad] }])).toBeNull()
  })
})

describe('validation and security boundaries', () => {
  it('clips content, activeForm and blocker at 500 and phase names at 200 with an ellipsis', () => {
    const long = 'x'.repeat(600)
    const clipped = 'x'.repeat(499) + '…'
    expect(todoWritePhases({ todos: [{ content: long, activeForm: long, status: 'pending' }] })?.[0].tasks[0])
      .toEqual({ id: null, content: clipped, activeForm: clipped, status: 'pending' })
    const phases = ompTodoPhases([{ name: long, tasks: [{ content: long, activeForm: long, blocker: long, status: 'blocked' }] }])
    expect(phases).toEqual([{ name: 'x'.repeat(199) + '…', tasks: [{ id: null, content: clipped, activeForm: clipped, blocker: clipped, status: 'blocked' }] }])
    expect(agentTodoPhaseSchema.safeParse(phases?.[0]).success).toBe(true)
    expect(taskPhases(created({ subject: long, activeForm: long }))[0].tasks[0]).toEqual({ id: '1', content: clipped, activeForm: clipped, status: 'pending' })
    expect(todoWritePhases({ todos: [{ content: 'x'.repeat(500), status: 'pending' }] })?.[0].tasks[0].content).toBe('x'.repeat(500))
  })

  it('accepts the limits and rejects 101 tasks across phases or 21 phases', () => {
    const tasks = Array.from({ length: 100 }, () => ({ content: 'x', status: 'pending' }))
    expect(todoWritePhases({ todos: tasks })?.[0].tasks).toHaveLength(100)
    expect(todoWritePhases({ todos: [...tasks, tasks[0]] })).toBeNull()
    expect(ompTodoPhases([{ name: '', tasks }])?.[0].tasks).toHaveLength(100)
    expect(ompTodoPhases([{ name: '', tasks: [...tasks, tasks[0]] }])).toBeNull()
    expect(ompTodoPhases([{ name: '', tasks }, { name: '', tasks: [tasks[0]] }])).toBeNull()
    const phases = Array.from({ length: 20 }, () => ({ name: '', tasks: [] }))
    expect(ompTodoPhases(phases)).toHaveLength(20)
    expect(ompTodoPhases([...phases, phases[0]])).toBeNull()
  })

})

describe('secret masking and hostile input', () => {
  it('masks grants and claims in all returned free-text fields before clipping', () => {
    const todo = todoWritePhases({ todos: [{ content: secrets, activeForm: secrets, status: 'pending' }] })
    expect(todo?.[0].tasks[0]).toEqual({ id: null, content: masked, activeForm: masked, status: 'pending' })
    const phases = ompTodoPhases([{ name: secrets, tasks: [{ content: secrets, activeForm: secrets, blocker: secrets, status: 'blocked' }] }])
    expect(phases).toEqual([{ name: masked, tasks: [{ id: null, content: masked, activeForm: masked, blocker: masked, status: 'blocked' }] }])
    expect(ompTodoPhases([{ name: '', tasks: [{ id: 'dmg_' + 'a'.repeat(16), content: 'x', status: 'pending' }] }])?.[0].tasks[0].id).toBe(GRANT_TOKEN_MASK)
    const pending = taskCreateStarted(empty(), secrets, { subject: secrets, activeForm: secrets })
    expect(pending.pendingCreates).toEqual({ [masked]: { content: masked, activeForm: masked } })
    expect(taskPhases(taskCreateResult(pending, secrets, 'Task #1'))[0].tasks[0]).toEqual({ id: '1', content: masked, activeForm: masked, status: 'pending' })
    const crossingBoundary = 'x'.repeat(490) + secrets
    const clipped = todoWritePhases({ todos: [{ content: crossingBoundary, status: 'pending' }] })?.[0].tasks[0].content
    expect(clipped).toBe(('x'.repeat(490) + masked).slice(0, 499) + '…')
    expect(clipped).not.toContain('dmg_')
  })

  it.each([undefined, null, 42, 'x', true, [], { todos: 'x' }, [{ name: 42, tasks: [] }], [{ name: 'x', tasks: 'x' }]])('rejects junk without throwing: %j', input => {
    expect(todoWritePhases(input)).toBeNull()
    if (!Array.isArray(input) || input.length !== 0) expect(ompTodoPhases(input)).toBeNull()
  })

  it('does not traverse deeply nested, cyclic or throwing junk', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    let deep: unknown = 42
    for (let i = 0; i < 20_000; i++) deep = { nested: deep }
    for (const value of [cyclic, deep, Object.defineProperty({}, 'todos', { get() { throw new Error('untrusted getter') } })]) {
      expect(todoWritePhases(value)).toBeNull()
      expect(ompTodoPhases(value)).toBeNull()
    }
    const throwing = Object.defineProperty({}, 'subject', { get() { throw new Error('untrusted getter') } })
    const list = empty()
    expect(taskCreateStarted(list, 'create', throwing)).toBe(list)
  })
})
