import { describe, expect, it } from 'vitest'
import { epicLandingFor, threadLandingFor, type Landing } from './landing'

const TICKET: Landing = { kind: 'ticket', epicId: 'ep_1', ticketId: 'tk_1', attemptId: null }
const THREAD: Landing = { kind: 'thread', chatId: 'chat_1', threadId: 'th_1' }

describe('epicLandingFor', () => {
  it('gives the request to the epic it names, and to no other screen', () => {
    expect(epicLandingFor(TICKET, 'ep_1')).toBe(TICKET)
    expect(epicLandingFor(TICKET, 'ep_2')).toBeNull()
    expect(epicLandingFor(THREAD, 'ep_1')).toBeNull()
    expect(epicLandingFor(null, 'ep_1')).toBeNull()
  })
})

describe('threadLandingFor', () => {
  it('gives the request to the chat it names, and to no other screen', () => {
    expect(threadLandingFor(THREAD, 'chat_1')).toBe(THREAD)
    expect(threadLandingFor(THREAD, 'chat_2')).toBeNull()
    expect(threadLandingFor(TICKET, 'chat_1')).toBeNull()
    expect(threadLandingFor(null, 'chat_1')).toBeNull()
  })
})
