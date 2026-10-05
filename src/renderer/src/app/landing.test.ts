import { describe, expect, it } from 'vitest'
import { threadLandingFor, ticketLandingFor, type Landing } from './landing'

const TICKET: Landing = { kind: 'ticket', epicId: 'ep_1', ticketId: 'tk_1', attemptId: null }
const THREAD: Landing = { kind: 'thread', chatId: 'chat_1', threadId: 'th_1' }

describe('ticketLandingFor', () => {
  it('gives the request to the epic it names, and to no other screen', () => {
    expect(ticketLandingFor(TICKET, 'ep_1')).toBe(TICKET)
    expect(ticketLandingFor(TICKET, 'ep_2')).toBeNull()
    expect(ticketLandingFor(THREAD, 'ep_1')).toBeNull()
    expect(ticketLandingFor(null, 'ep_1')).toBeNull()
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
