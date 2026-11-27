import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { memoryChatFs, REPO, type MemoryChatFs } from './__mocks__/chatFixtures'
import { ATTEMPT_A, ATTEMPT_B, RUN_ID, THREAD_A } from './__mocks__/orchestratorChat'
import { createActivityBindings, type ActivityBinding } from './activityBindings'

const FILE = resolve('/state/agents/activity-bindings.jsonl')
const OTHER_REPO = resolve('/work/other')
const SECRET = 'Qx7vT2mN9pL4kR8sW1yZ3bC6dF0gH5jA'

const ORCHESTRATOR_RUN: ActivityBinding = { chatId: 'chat_1', threadId: null, folder: REPO, role: 'orchestrator', kind: 'run', runId: RUN_ID }
const ORCHESTRATOR_A: ActivityBinding = { chatId: 'chat_1', threadId: null, folder: REPO, role: 'orchestrator', kind: 'attempt', attemptId: ATTEMPT_A }
const WORKER_A: ActivityBinding = { chatId: 'chat_1', threadId: THREAD_A, folder: REPO, role: 'worker', kind: 'attempt', attemptId: ATTEMPT_A }
const OTHER_CHAT_B: ActivityBinding = { chatId: 'chat_2', threadId: null, folder: REPO, role: 'worker', kind: 'attempt', attemptId: ATTEMPT_B }

/** The bindings file as an app from before terminals left it: one JSON line per binding, or raw lines. */
function storedFile(lines: readonly (ActivityBinding | string)[]): MemoryChatFs {
  const fs = memoryChatFs()
  fs.files.set(FILE, lines.map((line) => `${typeof line === 'string' ? line : JSON.stringify(line)}\n`).join(''))
  return fs
}

describe('activity bindings: lookups of what old chats stored', () => {
  it('return the chat, its folder and the thread for an attempt and for a run, in the order stored', () => {
    const bindings = createActivityBindings({ file: FILE, fs: storedFile([ORCHESTRATOR_RUN, ORCHESTRATOR_A, WORKER_A, OTHER_CHAT_B]) })

    expect(bindings.byRun(RUN_ID)).toEqual([ORCHESTRATOR_RUN])
    expect(bindings.byAttempt(ATTEMPT_A)).toEqual([ORCHESTRATOR_A, WORKER_A])
    expect(bindings.byAttempt(ATTEMPT_B)).toEqual([OTHER_CHAT_B])
  })

  it('answer none when nothing was stored', () => {
    const bindings = createActivityBindings({ file: FILE, fs: memoryChatFs() })

    expect([bindings.byRun(RUN_ID), bindings.byAttempt(ATTEMPT_A)]).toEqual([[], []])
  })

  it('give copies, so a caller cannot change what is bound', () => {
    const bindings = createActivityBindings({ file: FILE, fs: storedFile([WORKER_A]) })

    const first = bindings.byAttempt(ATTEMPT_A)[0]
    if (first !== undefined) first.threadId = 'changed'

    expect(bindings.byAttempt(ATTEMPT_A)).toEqual([WORKER_A])
  })

  it('keep the role first stored when a later line repeats the same chat, thread and attempt', () => {
    const bindings = createActivityBindings({ file: FILE, fs: storedFile([WORKER_A, { ...WORKER_A, role: 'orchestrator' }]) })

    expect(bindings.byAttempt(ATTEMPT_A)).toEqual([WORKER_A])
  })
})

describe('activity bindings: lines that are not bindings', () => {
  it('skips a truncated line, a line of another shape and a line that carries a claim token', () => {
    const withToken = JSON.stringify({ ...WORKER_A, threadId: `${ATTEMPT_A}.${SECRET}` })
    const fs = storedFile(['{"chatId":"chat_1","thr', JSON.stringify({ chatId: 'chat_1', kind: 'ticket' }), withToken, WORKER_A])

    expect(createActivityBindings({ file: FILE, fs }).byAttempt(ATTEMPT_A)).toEqual([WORKER_A])
  })

  it('takes an attempt or run id only whole', () => {
    const fs = storedFile([{ ...WORKER_A, attemptId: `${ATTEMPT_A}x` } as ActivityBinding, { ...ORCHESTRATOR_RUN, runId: 'rn_short' } as ActivityBinding])
    const bindings = createActivityBindings({ file: FILE, fs })

    expect([bindings.byAttempt(`${ATTEMPT_A}x`), bindings.byRun('rn_short')]).toEqual([[], []])
  })
})

describe('activity bindings: forgetting a deleted chat', () => {
  it('removes every binding of the chat from memory and disk, and keeps the other chats', () => {
    const fs = storedFile([ORCHESTRATOR_RUN, WORKER_A, OTHER_CHAT_B])
    const bindings = createActivityBindings({ file: FILE, fs })

    bindings.forgetChat({ folder: REPO, id: 'chat_1' })

    expect([bindings.byRun(RUN_ID), bindings.byAttempt(ATTEMPT_A), bindings.byAttempt(ATTEMPT_B)]).toEqual([[], [], [OTHER_CHAT_B]])
    expect(fs.files.get(FILE)).toBe(`${JSON.stringify(OTHER_CHAT_B)}\n`)
    expect(createActivityBindings({ file: FILE, fs }).byAttempt(ATTEMPT_A)).toEqual([])
  })

  it('keeps the bindings of a chat with the same id in another folder, and leaves the file alone when nothing matches', () => {
    const fs = storedFile([WORKER_A])
    const before = fs.files.get(FILE)
    const bindings = createActivityBindings({ file: FILE, fs })

    bindings.forgetChat({ folder: OTHER_REPO, id: 'chat_1' })

    expect(bindings.byAttempt(ATTEMPT_A)).toEqual([WORKER_A])
    expect(fs.files.get(FILE)).toBe(before)
  })
})

describe('activity bindings: verified worker persistence', () => {
  it('appends once, dedupes across reloads, and returns only the requested chat attempts', () => {
    const fs = storedFile([ORCHESTRATOR_RUN])
    const bindings = createActivityBindings({ file: FILE, fs })
    bindings.bind(WORKER_A)
    bindings.bind({ ...WORKER_A })
    bindings.bind(OTHER_CHAT_B)
    bindings.bind({ ...WORKER_A, folder: OTHER_REPO })
    const expected = [ORCHESTRATOR_RUN, WORKER_A, OTHER_CHAT_B, { ...WORKER_A, folder: OTHER_REPO }]
    expect(fs.files.get(FILE)).toBe(expected.map(binding => `${JSON.stringify(binding)}\n`).join(''))
    const reloaded = createActivityBindings({ file: FILE, fs })
    reloaded.bind(WORKER_A)
    expect(fs.files.get(FILE)).toBe(expected.map(binding => `${JSON.stringify(binding)}\n`).join(''))
    expect(reloaded.threadsOf({ id: 'chat_1', folder: REPO })).toEqual([WORKER_A])
    expect(reloaded.threadsOf({ id: 'chat_1', folder: OTHER_REPO })).toEqual([{ ...WORKER_A, folder: OTHER_REPO }])
    expect(reloaded.threadsOf({ id: 'chat_1', folder: null })).toEqual([])
    const copy = reloaded.threadsOf({ id: 'chat_1', folder: REPO })[0]
    copy.threadId = 'mutated'
    expect(reloaded.threadsOf({ id: 'chat_1', folder: REPO })).toEqual([WORKER_A])
  })

  it('rejects invalid roles, kinds, ids, and tokens even in unknown fields before touching storage', () => {
    const fs = memoryChatFs()
    const bindings = createActivityBindings({ file: FILE, fs })
    const token = `${ATTEMPT_A}.${SECRET}`
    for (const invalid of [ORCHESTRATOR_RUN, ORCHESTRATOR_A, { ...WORKER_A, attemptId: 'at_short' },
      { ...WORKER_A, threadId: token }, { ...WORKER_A, folder: token }, { ...WORKER_A, token }]) {
      expect(() => bindings.bind(invalid)).toThrow('Invalid worker attempt binding')
    }
    expect(fs.files.has(FILE)).toBe(false)
    expect(bindings.byAttempt(ATTEMPT_A)).toEqual([])
    bindings.bind(WORKER_A)
    expect(fs.files.get(FILE)).toBe(`${JSON.stringify(WORKER_A)}\n`)
    expect(fs.files.get(FILE)).not.toContain(SECRET)
  })

  it('separates a truncated tail from the next complete binding and leaves memory unchanged on write failure', () => {
    const fs = memoryChatFs()
    fs.files.set(FILE, '{"chatId":')
    const bindings = createActivityBindings({ file: FILE, fs })
    const append = fs.appendFile
    fs.appendFile = () => { throw new Error('disk full') }
    expect(() => bindings.bind(WORKER_A)).toThrow('disk full')
    expect(bindings.byAttempt(ATTEMPT_A)).toEqual([])
    fs.appendFile = append
    bindings.bind(WORKER_A)
    expect(fs.files.get(FILE)).toBe(`{"chatId":\n${JSON.stringify(WORKER_A)}\n`)
    expect(createActivityBindings({ file: FILE, fs }).byAttempt(ATTEMPT_A)).toEqual([WORKER_A])
  })
})
