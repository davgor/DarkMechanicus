import { describe, expect, it } from 'vitest'
import { REPO } from './__mocks__/fakeChatAdapter'
import { ATTEMPT_A, ATTEMPT_B, RUN_ID, THREAD_A } from './__mocks__/orchestratorChat'
import type { ActivityBinding } from './activityBindings'
import { listBoundThreads } from './boundThreads'

const OTHER_RUN = 'rn_01k8zq9z9z9z9z9z9z9z9z9z9z'

const BASE = { chatId: 'chat_1', folder: REPO }
const RUN_ORCHESTRATOR: ActivityBinding = { ...BASE, threadId: null, role: 'orchestrator', kind: 'run', runId: RUN_ID }
const ATTEMPT_ORCHESTRATOR: ActivityBinding = { ...BASE, threadId: null, role: 'orchestrator', kind: 'attempt', attemptId: ATTEMPT_A }
const ATTEMPT_WORKER: ActivityBinding = { ...BASE, threadId: THREAD_A, role: 'worker', kind: 'attempt', attemptId: ATTEMPT_A }

/** The bindings a fixed list holds, asked for like `ActivityBindings` does (every one of the run or attempt, in the order bound). */
function over(bindings: ActivityBinding[]): Parameters<typeof listBoundThreads>[0] {
  return {
    byAttempt: (attemptId) => bindings.filter((binding) => binding.kind === 'attempt' && binding.attemptId === attemptId),
    byRun: (runId) => bindings.filter((binding) => binding.kind === 'run' && binding.runId === runId)
  }
}

describe('listBoundThreads', () => {
  it('names the folder, chat, thread and role of each thread bound to an attempt, in the order bound', () => {
    const found = listBoundThreads(over([ATTEMPT_ORCHESTRATOR, ATTEMPT_WORKER]), REPO, { attemptId: ATTEMPT_A })

    expect(found).toEqual([
      { folder: REPO, chatId: 'chat_1', threadId: null, role: 'orchestrator' },
      { folder: REPO, chatId: 'chat_1', threadId: THREAD_A, role: 'worker' }
    ])
  })

  it('names the threads bound to a run', () => {
    expect(listBoundThreads(over([RUN_ORCHESTRATOR]), REPO, { runId: RUN_ID })).toEqual([{ folder: REPO, chatId: 'chat_1', threadId: null, role: 'orchestrator' }])
  })

  it('answers none for an attempt or a run nothing is bound to', () => {
    const bindings = over([RUN_ORCHESTRATOR, ATTEMPT_WORKER])

    expect(listBoundThreads(bindings, REPO, { attemptId: ATTEMPT_B })).toEqual([])
    expect(listBoundThreads(bindings, REPO, { runId: OTHER_RUN })).toEqual([])
  })

  it('leaves out a binding of another folder, so one folder cannot learn the chats of another', () => {
    const elsewhere: ActivityBinding = { ...ATTEMPT_WORKER, folder: '/elsewhere', chatId: 'chat_9' }

    expect(listBoundThreads(over([elsewhere, ATTEMPT_ORCHESTRATOR]), REPO, { attemptId: ATTEMPT_A })).toEqual([
      { folder: REPO, chatId: 'chat_1', threadId: null, role: 'orchestrator' }
    ])
  })

  it('carries nothing but the four fields: never the attempt or run it was bound to', () => {
    const [found] = listBoundThreads(over([ATTEMPT_WORKER]), REPO, { attemptId: ATTEMPT_A })

    expect(Object.keys(found ?? {}).sort()).toEqual(['chatId', 'folder', 'role', 'threadId'])
  })
})
