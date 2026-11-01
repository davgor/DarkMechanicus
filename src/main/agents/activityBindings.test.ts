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
