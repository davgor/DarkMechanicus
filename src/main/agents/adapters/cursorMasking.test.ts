import { describe, expect, it } from 'vitest'
import type { ChatAdapterEvent, ChatItem } from '../../../shared/agents/chat'
import { ATTEMPT_ID, SECRET, cutInsideToken, leaksSecret, maskedThenCut } from '../__mocks__/claimTokenFixture'
import { CLAIM_TOKEN_MASK } from '../claimTokenMask'
import { clip, permissionDetails, summarizeInput } from './cursorProtocol'
import { UpdateTranslator } from './cursorUpdates'

const AT = '2026-01-01T00:00:00.000Z'
/** How much of the secret is left before a cut: too little for the mask to see it unless the text is masked first. */
const KEPT = [0, 5, 15]

function toolCalls(updates: unknown[]): { events: ChatAdapterEvent[]; calls: Extract<ChatItem, { kind: 'tool_call' }>[] } {
  const events: ChatAdapterEvent[] = []
  let count = 0
  const translator = new UpdateTranslator({ newId: () => `id_${++count}`, now: () => AT }, (event) => events.push(event))
  updates.forEach((update) => translator.apply('sess_1', update))
  const calls = events.flatMap((event) => (event.type === 'item' && event.item.kind === 'tool_call' ? [event.item] : []))
  return { events, calls }
}

describe('Cursor updates: text that is cut is masked first', () => {
  it.each(KEPT)('masks a long tool input string cut at its token (%i characters before the cut)', (kept) => {
    const rawInput = { command: cutInsideToken(2000, kept), nested: { list: [cutInsideToken(2000, kept)] } }

    const { events, calls } = toolCalls([{ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Run', kind: 'execute', status: 'pending', rawInput }])

    expect(leaksSecret(events)).toBe(false)
    expect(calls[0]?.input).toEqual({ command: maskedThenCut(2000, kept), nested: { list: [maskedThenCut(2000, kept)] } })
  })

  it.each(KEPT)('masks a tool result cut at its token (%i characters before the cut)', (kept) => {
    const text = cutInsideToken(600, kept)
    const content = [{ type: 'content', content: { type: 'text', text } }]

    const { events, calls } = toolCalls([{ sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Read', kind: 'read', status: 'completed', content }])

    expect(leaksSecret(events)).toBe(false)
    expect(calls[0]?.resultSummary).toBe(maskedThenCut(600, kept))
  })

  it('masks a tool named by a long title that is cut at a token', () => {
    const title = cutInsideToken(80, 6, 40)

    const { events, calls } = toolCalls([{ sessionUpdate: 'tool_call', toolCallId: 't1', title, kind: 'other', status: 'pending' }])

    expect(leaksSecret(events)).toBe(false)
    expect(calls[0]?.name).toBe(maskedThenCut(80, 6, 40))
  })

  it.each(KEPT)('masks the title and the input of a permission request cut at a token (%i characters before the cut)', (kept) => {
    const details = permissionDetails({
      toolCall: { toolCallId: 'p1', title: cutInsideToken(300, kept), kind: 'execute', rawInput: { command: cutInsideToken(2000, kept) } }
    })

    expect(leaksSecret(details)).toBe(false)
    expect(details.summary).toBe(maskedThenCut(300, kept))
    expect(details.input).toEqual({ command: maskedThenCut(2000, kept) })
  })

  it('masks a token already cut short at the end of a string, and leaves text without tokens as it was', () => {
    expect(clip(`done ${ATTEMPT_ID}.${SECRET.slice(0, 3)}`, 300)).toBe(`done ${CLAIM_TOKEN_MASK}`)
    expect(clip('a'.repeat(61), 60)).toBe(`${'a'.repeat(60)}…`)
    expect(clip('short', 60)).toBe('short')
    expect(summarizeInput({ plain: 'ls', count: 2 })).toEqual({ plain: 'ls', count: 2 })
  })
})
