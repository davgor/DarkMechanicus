// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { ThreadBinding } from '../../../shared/agents/chatApi'
import type { AttemptTimelineView } from '../../../shared/domain/activity'
import type { RunView } from '../../../shared/domain/views'
import { FakeDm } from '../__mocks__/fakeDm'
import type { MarkerTarget } from './actionMarkers'
import { knownRunIds, lookupReads, needsLookup, resolveTarget } from './chatLookup'

type LookupReads = ReturnType<typeof lookupReads>

const RUN = 'rn_01k8zq3v7c2m5n9p4r6t8w0xyb'
const OTHER_RUN = 'rn_01k8zq9z9z9z9z9z9z9z9z9z9z'
const ATTEMPT = 'at_01k8zq4a1b2c3d4e5f6g7h8j9k'
const TICKET = 'tk_01k8zq2m3n4p5q6r7s8t9v0w1x'
const OTHER_TICKET = 'tk_01k8zq2y3z4a5b6c7d8e9f0g1h'
const EPIC = 'ep_01k8zq2a3b4c5d6e7f8g9h0j1k'
const OTHER_EPIC = 'ep_01k8zq8m8n8p8q8r8s8t8v8w8x'

const NONE: MarkerTarget = { epicId: null, runId: null, ticketId: null, attemptId: null, ticketKey: null }

interface Reads {
  reads: LookupReads
  asked: string[]
}

/** Two runs: DM-12 is in the first, DM-30 in the second, which is another epic's. */
function fakeReads(overrides: Partial<LookupReads> = {}): Reads {
  const asked: string[] = []
  return {
    asked,
    reads: {
      run: async (runId) => {
        asked.push(`run ${runId}`)
        if (runId === RUN) {
          return { epicId: EPIC, tickets: [{ ticketId: TICKET, key: 'DM-12' }] }
        }
        return runId === OTHER_RUN ? { epicId: OTHER_EPIC, tickets: [{ ticketId: OTHER_TICKET, key: 'DM-30' }] } : null
      },
      attempt: async (attemptId) => {
        asked.push(`attempt ${attemptId}`)
        return attemptId === ATTEMPT ? { runId: RUN, ticketId: TICKET } : null
      },
      ...overrides
    }
  }
}

const target = (patch: Partial<MarkerTarget>): MarkerTarget => ({ ...NONE, ...patch })

describe('needsLookup', () => {
  it('is true while an id is known and the key or the epic is not, and false when there is nothing to learn or nothing to ask with', () => {
    expect(needsLookup(target({ attemptId: ATTEMPT }))).toBe(true)
    expect(needsLookup(target({ runId: RUN }))).toBe(true)
    expect(needsLookup(target({ ticketId: TICKET, ticketKey: 'DM-12' }))).toBe(true)
    expect(needsLookup(target({ ticketId: TICKET, ticketKey: 'DM-12', epicId: EPIC }))).toBe(false)
    expect(needsLookup(target({ epicId: EPIC }))).toBe(false)
    expect(needsLookup(NONE)).toBe(false)
  })
})

describe('resolveTarget', () => {
  it('finds the ticket and epic of an attempt through its run', async () => {
    const { reads, asked } = fakeReads()

    expect(await resolveTarget(target({ attemptId: ATTEMPT }), reads, [])).toEqual({ epicId: EPIC, runId: RUN, ticketId: TICKET, attemptId: ATTEMPT, ticketKey: 'DM-12' })
    expect(asked).toEqual([`attempt ${ATTEMPT}`, `run ${RUN}`])
  })

  it('finds the key and epic of a ticket in the run the call named', async () => {
    const { reads } = fakeReads()

    expect(await resolveTarget(target({ runId: RUN, ticketId: TICKET }), reads, [])).toEqual(target({ epicId: EPIC, runId: RUN, ticketId: TICKET, ticketKey: 'DM-12' }))
  })

  it('looks for a ticket that came with no run among the runs this chat knows, and takes the one that has it', async () => {
    const { reads } = fakeReads()

    expect(await resolveTarget(target({ ticketId: OTHER_TICKET }), reads, [RUN, OTHER_RUN])).toEqual(target({ epicId: OTHER_EPIC, runId: OTHER_RUN, ticketId: OTHER_TICKET, ticketKey: 'DM-30' }))
  })

  it('finds the epic of a run', async () => {
    const { reads } = fakeReads()

    expect(await resolveTarget(target({ runId: RUN }), reads, [])).toEqual(target({ epicId: EPIC, runId: RUN }))
  })

  it('keeps what the call already said, and asks for nothing when there is nothing to learn', async () => {
    const { reads, asked } = fakeReads()
    const known = target({ epicId: EPIC, ticketId: TICKET, ticketKey: 'DM-12' })

    expect(await resolveTarget(known, reads, [RUN])).toEqual(known)
    expect(await resolveTarget(NONE, reads, [RUN])).toEqual(NONE)
    expect(asked).toEqual([])
  })

  it('leaves the target as it was when nothing is found or a read fails', async () => {
    const { reads } = fakeReads({ attempt: () => Promise.reject(new Error('gone')), run: () => Promise.reject(new Error('gone')) })

    expect(await resolveTarget(target({ attemptId: ATTEMPT }), reads, [])).toEqual(target({ attemptId: ATTEMPT }))
    expect(await resolveTarget(target({ ticketId: TICKET }), fakeReads().reads, [OTHER_RUN])).toEqual(target({ ticketId: TICKET }))
  })

  it('takes the epic of the run the call named, and no key, for a ticket that run does not have', async () => {
    const { reads } = fakeReads()

    expect(await resolveTarget(target({ runId: OTHER_RUN, ticketId: TICKET }), reads, [])).toEqual(target({ epicId: OTHER_EPIC, runId: OTHER_RUN, ticketId: TICKET }))
  })
})

const BOUND: ThreadBinding[] = [
  { threadId: null, role: 'orchestrator', kind: 'run', runId: RUN, epicId: EPIC },
  { threadId: 'th', role: 'worker', kind: 'attempt', attemptId: ATTEMPT, runId: OTHER_RUN, epicId: OTHER_EPIC, ticketId: TICKET, ticketKey: 'DM-12' },
  { threadId: 'th2', role: 'worker', kind: 'attempt', attemptId: 'at_01k8zq5m2n3p4q5r6s7t8v9w0x', runId: null, epicId: null, ticketId: null, ticketKey: null }
]

describe('knownRunIds', () => {
  it('lists each run the chat is bound to or acts on through an attempt, once, in the order bound', () => {
    expect(knownRunIds(BOUND)).toEqual([RUN, OTHER_RUN])
    expect(knownRunIds([])).toEqual([])
  })
})

describe('lookupReads', () => {
  function desktop(): FakeDm {
    const dm = new FakeDm()
    window.dm = dm
    dm.handlers.getRun = (input) => ((input as { runId: string }).runId === RUN ? ({ id: RUN, epicId: EPIC, tickets: [{ ticketId: TICKET, key: 'DM-12' }] } as unknown as RunView) : null)
    dm.handlers.getAttemptTimeline = (input) => ({ attemptId: (input as { attemptId: string }).attemptId, runId: RUN, ticketId: TICKET }) as unknown as AttemptTimelineView
    return dm
  }

  it('reads a run and an attempt through the desktop read commands of the chat folder, and asks only once for each', async () => {
    const dm = desktop()
    const reads = lookupReads('/a', () => [])

    expect(await reads.run(RUN)).toEqual({ epicId: EPIC, tickets: [{ ticketId: TICKET, key: 'DM-12' }] })
    expect(await reads.run(RUN)).toEqual({ epicId: EPIC, tickets: [{ ticketId: TICKET, key: 'DM-12' }] })
    expect(await reads.attempt(ATTEMPT)).toEqual({ runId: RUN, ticketId: TICKET })
    expect(await reads.attempt(ATTEMPT)).toEqual({ runId: RUN, ticketId: TICKET })

    expect(dm.commandCalls.map((call) => [call.folder, call.name])).toEqual([
      ['/a', 'getRun'],
      ['/a', 'getAttemptTimeline']
    ])
    expect(dm.commandCalls[0]?.input).toEqual({ runId: RUN })
    expect(dm.commandCalls[1]?.input).toEqual({ attemptId: ATTEMPT, limit: 1 })
  })

  it('answers an attempt the chat is bound to from the binding, without a read', async () => {
    const dm = desktop()
    const reads = lookupReads('/a', () => BOUND)

    expect(await reads.attempt(ATTEMPT)).toEqual({ runId: OTHER_RUN, ticketId: TICKET })
    expect(dm.commandCalls).toEqual([])
  })

  it('answers null for a run the folder does not know, and tries again after a failed read', async () => {
    const dm = desktop()
    const reads = lookupReads('/a', () => [])

    expect(await reads.run(OTHER_RUN)).toBeNull()

    dm.failures.getAttemptTimeline = { code: 'not_found', message: 'No such attempt.' }
    await expect(reads.attempt(ATTEMPT)).rejects.toThrow('No such attempt.')
    delete dm.failures.getAttemptTimeline
    expect(await reads.attempt(ATTEMPT)).toEqual({ runId: RUN, ticketId: TICKET })
  })
})
