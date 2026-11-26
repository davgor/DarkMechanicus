import { describe, expect, it } from 'vitest'
import { epicLandingFor, sourceFileLandingFor, threadLandingFor, type Landing } from './landing'

const TICKET: Landing = { kind: 'ticket', epicId: 'ep_1', ticketId: 'tk_1', attemptId: null }
const THREAD: Landing = { kind: 'thread', chatId: 'chat_1', threadId: 'th_1' }
const SOURCE: Landing = { kind: 'sourceFile', folderPath: 'C:/Repo', absolutePath: 'C:/Repo/src/a.ts' }
const AGENT: Landing = { kind: 'epicAgent', epicId: 'ep_1', chatId: 'chat_magos' }
const CHECKPOINT: Landing = { kind: 'epicCheckpoint', epicId: 'ep_1' }

describe('epicLandingFor', () => {
  it('gives the request to the epic it names, and to no other screen', () => {
    expect(epicLandingFor(TICKET, 'ep_1')).toBe(TICKET)
    expect(epicLandingFor(TICKET, 'ep_2')).toBeNull()
    expect(epicLandingFor(THREAD, 'ep_1')).toBeNull()
    expect(epicLandingFor(SOURCE, 'ep_1')).toBeNull()
    expect(epicLandingFor(null, 'ep_1')).toBeNull()
  })

  it('gives Agent-tab and checkpoint requests to the epic they name, and never to a chat or folder', () => {
    expect(epicLandingFor(AGENT, 'ep_1')).toBe(AGENT)
    expect(epicLandingFor(AGENT, 'ep_2')).toBeNull()
    expect(epicLandingFor(CHECKPOINT, 'ep_1')).toBe(CHECKPOINT)
    expect(epicLandingFor(CHECKPOINT, 'ep_2')).toBeNull()
    expect(threadLandingFor(AGENT, 'chat_magos')).toBeNull()
    expect(sourceFileLandingFor(CHECKPOINT, 'C:/Repo')).toBeNull()
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

describe('sourceFileLandingFor', () => {
  it('gives only source requests to their folder, including Windows spelling differences', () => {
    expect(sourceFileLandingFor(SOURCE, 'c:\\Repo')).toBe(SOURCE)
    expect(sourceFileLandingFor(SOURCE, 'C:/Other')).toBeNull()
    expect(sourceFileLandingFor(TICKET, 'C:/Repo')).toBeNull()
    expect(sourceFileLandingFor(THREAD, 'C:/Repo')).toBeNull()
    expect(sourceFileLandingFor(null, 'C:/Repo')).toBeNull()
  })
})
