import { describe, expect, it } from 'vitest'
import type { ThreadBinding } from '../../shared/agents/chatApi'
import { REPO } from './__mocks__/fakeChatAdapter'
import { ATTEMPT_A, ATTEMPT_B, RUN_ID, THREAD_A } from './__mocks__/orchestratorChat'
import type { ActivityBinding } from './activityBindings'
import { listThreadBindings, type BindingReads } from './threadBindings'

const CHAT = { folder: REPO, id: 'chat_1' }
const EPIC_ID = 'ep_01k8zq2a3b4c5d6e7f8g9h0j1k'
const TICKET_A = 'tk_01k8zq2m3n4p5q6r7s8t9v0w1x'
const TICKET_B = 'tk_01k8zq2y3z4a5b6c7d8e9f0g1h'

const BASE = { chatId: CHAT.id, folder: REPO }
const RUN_BINDING: ActivityBinding = { ...BASE, threadId: null, role: 'orchestrator', kind: 'run', runId: RUN_ID }
const ATTEMPT_BINDING_A: ActivityBinding = { ...BASE, threadId: THREAD_A, role: 'worker', kind: 'attempt', attemptId: ATTEMPT_A }
const ATTEMPT_BINDING_B: ActivityBinding = { ...BASE, threadId: null, role: 'orchestrator', kind: 'attempt', attemptId: ATTEMPT_B }

interface Calls {
  attempts: string[]
  runs: string[]
}

/** Reads over a fixed run with two tickets and two attempts; each read is recorded as "<folder> <id>". */
function reads(overrides: Partial<BindingReads> = {}): { reads: BindingReads; calls: Calls } {
  const calls: Calls = { attempts: [], runs: [] }
  const known = new Map([
    [ATTEMPT_A, TICKET_A],
    [ATTEMPT_B, TICKET_B]
  ])
  return {
    calls,
    reads: {
      attempt: async (folder, attemptId) => {
        calls.attempts.push(`${folder} ${attemptId}`)
        const ticketId = known.get(attemptId)
        return ticketId === undefined ? null : { runId: RUN_ID, ticketId }
      },
      run: async (folder, runId) => {
        calls.runs.push(`${folder} ${runId}`)
        return runId === RUN_ID
          ? {
              epicId: EPIC_ID,
              tickets: [
                { ticketId: TICKET_A, key: 'DM-12' },
                { ticketId: TICKET_B, key: 'DM-13' }
              ]
            }
          : null
      },
      ...overrides
    }
  }
}

function listed(bindings: ActivityBinding[], readers: BindingReads): Promise<ThreadBinding[]> {
  return listThreadBindings({ activity: { byChat: () => bindings }, reads: readers }, CHAT)
}

describe('listThreadBindings', () => {
  it('names each binding by thread, kind, id and role, and resolves the epic of a run', async () => {
    const { reads: readers } = reads()

    expect(await listed([RUN_BINDING], readers)).toEqual([{ threadId: null, role: 'orchestrator', kind: 'run', runId: RUN_ID, epicId: EPIC_ID }])
  })

  it('resolves the run, epic, ticket id and ticket key of an attempt, in the order bound', async () => {
    const { reads: readers } = reads()

    expect(await listed([RUN_BINDING, ATTEMPT_BINDING_A, ATTEMPT_BINDING_B], readers)).toEqual([
      { threadId: null, role: 'orchestrator', kind: 'run', runId: RUN_ID, epicId: EPIC_ID },
      { threadId: THREAD_A, role: 'worker', kind: 'attempt', attemptId: ATTEMPT_A, runId: RUN_ID, epicId: EPIC_ID, ticketId: TICKET_A, ticketKey: 'DM-12' },
      { threadId: null, role: 'orchestrator', kind: 'attempt', attemptId: ATTEMPT_B, runId: RUN_ID, epicId: EPIC_ID, ticketId: TICKET_B, ticketKey: 'DM-13' }
    ])
  })

  it('reads the chat folder, and each run and attempt once however many bindings name it', async () => {
    const { reads: readers, calls } = reads()

    await listed([RUN_BINDING, ATTEMPT_BINDING_A, ATTEMPT_BINDING_B, { ...ATTEMPT_BINDING_A, threadId: 'another_thread' }], readers)

    expect(calls.attempts).toEqual([`${REPO} ${ATTEMPT_A}`, `${REPO} ${ATTEMPT_B}`])
    expect(calls.runs).toEqual([`${REPO} ${RUN_ID}`])
  })

  it('leaves what it cannot read null: an attempt the store does not know, a run it cannot find', async () => {
    const { reads: readers } = reads({ attempt: async () => null, run: async () => null })

    expect(await listed([RUN_BINDING, ATTEMPT_BINDING_A], readers)).toEqual([
      { threadId: null, role: 'orchestrator', kind: 'run', runId: RUN_ID, epicId: null },
      { threadId: THREAD_A, role: 'worker', kind: 'attempt', attemptId: ATTEMPT_A, runId: null, epicId: null, ticketId: null, ticketKey: null }
    ])
  })

  it('keeps the run and ticket id of an attempt whose run cannot be read, and never fails when a read throws', async () => {
    const { reads: readers } = reads({
      run: () => Promise.reject(new Error('The store is busy.')),
      attempt: async (_folder, attemptId) => (attemptId === ATTEMPT_A ? { runId: RUN_ID, ticketId: TICKET_A } : Promise.reject(new Error('boom')))
    })

    expect(await listed([ATTEMPT_BINDING_A, ATTEMPT_BINDING_B, RUN_BINDING], readers)).toEqual([
      { threadId: THREAD_A, role: 'worker', kind: 'attempt', attemptId: ATTEMPT_A, runId: RUN_ID, epicId: null, ticketId: TICKET_A, ticketKey: null },
      { threadId: null, role: 'orchestrator', kind: 'attempt', attemptId: ATTEMPT_B, runId: null, epicId: null, ticketId: null, ticketKey: null },
      { threadId: null, role: 'orchestrator', kind: 'run', runId: RUN_ID, epicId: null }
    ])
  })

  it('answers none, and reads nothing, for a chat with no bindings', async () => {
    const { reads: readers, calls } = reads()

    expect(await listed([], readers)).toEqual([])
    expect(calls).toEqual({ attempts: [], runs: [] })
  })

  it('does not name the chat, folder or anything but the ids it resolves', async () => {
    const { reads: readers } = reads()

    const [binding] = await listed([ATTEMPT_BINDING_A], readers)

    expect(Object.keys(binding ?? {}).sort()).toEqual(['attemptId', 'epicId', 'kind', 'role', 'runId', 'threadId', 'ticketId', 'ticketKey'])
  })
})
