import { describe, expect, it } from 'vitest'
import { CLAIM_TOKEN_MASK } from './claimTokenMask'
import { boardMessage, freshKickoff, type BoardMessageInput } from './conversationMessage'

const ANSWER_ONLY =
  'You were opened from the board to answer the person. Answer only: do not start or take over a run, claim work or save a plan unless the person asks.'
const SYNTHETIC_ATTEMPT = 'at_00000000000000000000000000'
const SYNTHETIC_TOKEN = `${SYNTHETIC_ATTEMPT}.SyntheticTokenSecret_1234567890`

const TICKET_MESSAGE: BoardMessageInput = {
  target: { epicId: 'ep_1', ticketId: 'tk_1' },
  epicTitle: 'Board conversations',
  ticketKey: 'DM-693',
  ticketTitle: 'Build messages',
  body: 'Please answer.',
  attachmentIds: [],
  relay: false
}

describe('conversation board messages', () => {
  it('uses the target-specific heading and reply command for a ticket, epic, and card', () => {
    expect(boardMessage(TICKET_MESSAGE)).toContain('[Board message from the person] on DM-693 "Build messages":')
    expect(boardMessage(TICKET_MESSAGE)).toContain('Reply on the record with add_comment {"epicId":"ep_1","ticketId":"tk_1"}')

    const epic = boardMessage({ ...TICKET_MESSAGE, target: { epicId: 'ep_1' } })
    expect(epic).toContain('[Board message from the person] on epic "Board conversations":')
    expect(epic).toContain('Reply on the record with add_comment {"epicId":"ep_1"}')

    const card = boardMessage({ ...TICKET_MESSAGE, target: { cardId: 'card_1' }, cardKey: 'DM-700', attachmentIds: ['att_1', 'att_2'] })
    expect(card).toContain('[Board message from the person] on card DM-700:')
    expect(card).toContain('Attached images: att_1, att_2 (get_attachment)')
    expect(card).toContain('Reply on the record with add_kanban_message {"cardId":"card_1"}')
  })

  it('sanitizes before masking and adds the relay instruction only when requested', () => {
    const body = `Keep ${SYNTHETIC_ATTEMPT}\u0000.SyntheticTokenSecret_1234567890 safe\u0007.`
    const withoutRelay = boardMessage({ ...TICKET_MESSAGE, body })
    const withRelay = boardMessage({ ...TICKET_MESSAGE, body, relay: true })

    expect(withoutRelay).toContain(`Keep ${CLAIM_TOKEN_MASK} safe.`)
    expect([...withoutRelay].some((character) => character === '\u0000' || character === '\u0007')).toBe(false)
    expect(withoutRelay).not.toContain('worker subagent')
    expect(withRelay).toContain('A worker subagent of yours may be doing DM-693: pass this to it now and post its answer.')
    expect(withRelay).not.toContain(SYNTHETIC_TOKEN)
  })

})

describe('conversation board message fallback labels', () => {
  it('falls back to stable target ids when display names are unavailable', () => {
    const ticket = boardMessage({
      ...TICKET_MESSAGE,
      target: { epicId: 'ep_fallback', ticketId: 'tk_fallback' },
      epicTitle: undefined,
      ticketKey: undefined,
      ticketTitle: undefined,
      relay: true
    })
    const epic = boardMessage({
      ...TICKET_MESSAGE,
      target: { epicId: 'ep_fallback' },
      epicTitle: undefined,
      ticketKey: undefined,
      ticketTitle: undefined,
      relay: true
    })
    const card = boardMessage({
      ...TICKET_MESSAGE,
      target: { cardId: 'kc_fallback' },
      cardKey: undefined,
      ticketKey: undefined,
      relay: true
    })

    expect(ticket).toContain('on tk_fallback:')
    expect(ticket).toContain('doing tk_fallback:')
    expect(epic).toContain('on epic "ep_fallback":')
    expect(epic).toContain('doing ep_fallback:')
    expect(card).toContain('on card kc_fallback:')
    expect(card).toContain('doing kc_fallback:')
  })
})

describe('fresh conversation kickoff', () => {
  it('keeps only the newest 20 history entries in oldest-first order', () => {
    const history = Array.from({ length: 30 }, (_, index) => ({ author: 'person', at: `time-${index}`, body: `history-${index}` }))

    const kickoff = freshKickoff({ ...TICKET_MESSAGE, history, runActive: false })

    expect(kickoff).not.toContain('history-9\n')
    expect(kickoff).toContain('history-10')
    expect(kickoff.indexOf('history-10')).toBeLessThan(kickoff.indexOf('history-29'))
    expect(kickoff.match(/history-\d+/gu)).toHaveLength(20)
  })

  it('drops oldest history until it fits, sanitizes and masks entries, and leaves the answer-only line last', () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      author: `agent-${index}`,
      at: `time-${index}`,
      body: `${index === 19 ? `${SYNTHETIC_ATTEMPT}\u0000.SyntheticTokenSecret_1234567890\u0007` : ''} entry-${index} ${'x'.repeat(2_000)}`
    }))

    const kickoff = freshKickoff({ ...TICKET_MESSAGE, history, runActive: true })

    expect(kickoff.length).toBeLessThanOrEqual(24_000)
    expect(kickoff).not.toContain('entry-0 ')
    expect(kickoff).toContain('entry-19 ')
    expect(kickoff).toContain(CLAIM_TOKEN_MASK)
    expect([...kickoff].some((character) => character === '\u0000' || character === '\u0007')).toBe(false)
    expect(kickoff).toContain('A run of this epic is active under another session.')
    expect(kickoff.endsWith(ANSWER_ONLY)).toBe(true)
  })

  it('omits empty history and inactive-run notices from a fresh kickoff', () => {
    const kickoff = freshKickoff({ ...TICKET_MESSAGE, history: [], runActive: false })

    expect(kickoff).not.toContain('Conversation history:')
    expect(kickoff).not.toContain('A run of this epic is active')
    expect(kickoff.endsWith(ANSWER_ONLY)).toBe(true)
  })
})
