import { describe, expect, it } from 'vitest'
import { FakeBackend, scenario } from '../epic/__mocks__/fakeBackend'
import { event } from '../epic/__mocks__/fixtures'
import { loadHistory } from './ticketData'

const EVENTS = [1, 2, 3, 4, 5].map((seq) => event(seq, `attempt.e${seq}`))

describe('loadHistory', () => {
  it("pages through the ticket's events until a short page", async () => {
    const backend = new FakeBackend(scenario({ events: EVENTS }))
    const events = await loadHistory(backend.runner, 'ep_1', 'tk_202', 2)
    expect(events.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5])
    expect(backend.inputs('listEvents')).toEqual([
      { epicId: 'ep_1', ticketId: 'tk_202', sinceSeq: 0, limit: 2 },
      { epicId: 'ep_1', ticketId: 'tk_202', sinceSeq: 2, limit: 2 },
      { epicId: 'ep_1', ticketId: 'tk_202', sinceSeq: 4, limit: 2 }
    ])
  })

  it('stops after a full page that does not advance the cursor and after the page limit', async () => {
    const stuck = new FakeBackend(scenario({ events: EVENTS }))
    stuck.handlers.listEvents = () => ({ events: EVENTS.slice(0, 2), cursor: 0 })
    expect((await loadHistory(stuck.runner, 'ep_1', 'tk_202', 2)).length).toBe(2)
    const many = Array.from({ length: 30 }, (_, index) => event(index + 1, 'x'))
    const long = new FakeBackend(scenario({ events: many }))
    expect((await loadHistory(long.runner, 'ep_1', 'tk_202', 1)).length).toBe(10)
    const single = new FakeBackend(scenario({ events: EVENTS }))
    expect((await loadHistory(single.runner, 'ep_1', 'tk_202')).length).toBe(5)
    expect(single.inputs('listEvents')).toEqual([{ epicId: 'ep_1', ticketId: 'tk_202', sinceSeq: 0, limit: 500 }])
  })

  it("reads an epic of 3,000 events, 40 of them the ticket's, in one call that returns those 40 in order", async () => {
    const log = Array.from({ length: 3_000 }, (_, index) => event(index + 1, 'bulk', { ticketId: index % 75 === 0 ? 'tk_x' : 'tk_other' }))
    const backend = new FakeBackend(scenario({ events: log }))
    const events = await loadHistory(backend.runner, 'ep_1', 'tk_x')
    expect(backend.inputs('listEvents')).toEqual([{ epicId: 'ep_1', ticketId: 'tk_x', sinceSeq: 0, limit: 500 }])
    expect(events.map((item) => item.seq)).toEqual(Array.from({ length: 40 }, (_, index) => index * 75 + 1))
    expect(events.every((item) => item.ticketId === 'tk_x')).toBe(true)
  })
})
