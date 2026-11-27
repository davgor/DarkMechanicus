// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAIM_TOKEN_MASK } from '../../../core/claimTokenMask'
import { mailEntry } from '../__mocks__/fakeChatMail'
import type { ChatMailEntry } from '../../../shared/agents/chatApi'
import { MAIL_CARD_CLIP, MailCard } from './MailCard'

afterEach(cleanup)

function show(patch: Partial<ChatMailEntry> = {}): HTMLElement {
  render(<ol><MailCard mail={mailEntry({ id: 'mm_1', ...patch })} /></ol>)
  return screen.getByRole('article')
}

const head = (card: HTMLElement): string => (card.querySelector('.chat-mail-head')?.textContent ?? '').replace(/\s+/g, ' ').trim()
const body = (card: HTMLElement): string => card.querySelector('.chat-mail-body')?.textContent ?? ''

describe('MailCard', () => {
  it('heads the card with the callsigns in the mail’s direction', () => {
    const received = show({ from: { label: 'Lexmechanic', kind: 'callsign' }, to: { label: 'Magos', kind: 'callsign' } })
    expect(head(received)).toBe('✉ Lexmechanic → Magos Received')
    expect(received.getAttribute('aria-label')).toBe('Received mail')
    cleanup()
    const sent = show({ direction: 'sent', seq: null, from: { label: 'Magos', kind: 'callsign' }, to: { label: 'Lexmechanic', kind: 'callsign' } })
    expect(head(sent)).toBe('✉ Magos → Lexmechanic Sent')
    expect(sent.closest('li')?.className).toBe('chat-mail chat-mail-sent')
  })

  it('labels a chat outside the epic by its stored name, as a name', () => {
    const card = show({ from: { label: 'Helper chat', kind: 'name' } })
    expect(head(card)).toBe('✉ “Helper chat” (name) → Lexmechanic Received')
  })

  it('renders markup and terminal sequences as inert text', () => {
    const card = show({
      body: '<b>bold</b> <script>window.hacked = true</script> <a href="https://example.com">link</a> \u001b[31mred\u001b[0m \u202Eevil',
      from: { label: 'Mag\u001b[2Jos', kind: 'callsign' }
    })
    expect(card.querySelector('b, script, a')).toBeNull()
    expect(body(card)).toBe('<b>bold</b> <script>window.hacked = true</script> <a href="https://example.com">link</a> ␛[31mred␛[0m <U+202E>evil')
    expect(head(card)).toContain('Mag␛[2Jos')
    expect('hacked' in window).toBe(false)
  })

  it('clips a long body until Show all', () => {
    const long = `${'a'.repeat(MAIL_CARD_CLIP)}tail`
    const card = show({ body: long })
    expect(body(card)).toBe(`${'a'.repeat(MAIL_CARD_CLIP)}…`)
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(body(card)).toBe(long)
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull()
  })

  it('keeps a masked token masked and masks a claim token that reached it', () => {
    const token = `at_${'0'.repeat(26)}.${'B'.repeat(32)}`
    const card = show({ body: `masked ${CLAIM_TOKEN_MASK} and raw ${token}` })
    expect(body(card)).toBe(`masked ${CLAIM_TOKEN_MASK} and raw ${CLAIM_TOKEN_MASK}`)
  })

  it('names the message it replies to', () => {
    const card = show({ inReplyTo: 'mm_parent' })
    expect(card.querySelector('.chat-mail-reply')?.textContent).toBe('Reply to mm_parent')
    cleanup()
    expect(show().querySelector('.chat-mail-reply')).toBeNull()
  })
})
