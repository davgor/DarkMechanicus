import { describe, expect, it } from 'vitest'
import type { AttentionItem } from '../../../shared/agents/agentChat'
import type { AgentTreeNodeInput } from '../agentTree/agentTreeModel'
import { agentRows, needsYouRows, type NeedsYouCount, type NeedsYouRow } from './needsYou'

function prompt(chatId: string, threadId: string | null, arbitration: AttentionItem['arbitration'], promptId = `${chatId}:${threadId}:${arbitration}`): AttentionItem {
  return { chatId, promptId, kind: 'approval', threadId, callsign: null, arbitration, title: 'Run tests?', shown: true }
}

// Magos (chat_orch) > Acolyte (th_w) > Inquisitor (th_r), plus Servitor (th_s) under Magos and a planner chat.
const rows: NeedsYouRow[] = [
  { id: 'chat_orch', chatId: 'chat_orch', threadId: null, parentId: null },
  { id: 'th_w', chatId: 'chat_orch', threadId: 'th_w', parentId: 'chat_orch' },
  { id: 'th_r', chatId: 'chat_orch', threadId: 'th_r', parentId: 'th_w' },
  { id: 'th_s', chatId: 'chat_orch', threadId: 'th_s', parentId: 'chat_orch' },
  { id: 'chat_plan', chatId: 'chat_plan', threadId: null, parentId: null }
]

function attention(...items: AttentionItem[]): Map<string, AttentionItem[]> {
  const byChat = new Map<string, AttentionItem[]>()
  for (const item of items) byChat.set(item.chatId, [...(byChat.get(item.chatId) ?? []), item])
  return byChat
}

function total(counts: ReadonlyMap<string, NeedsYouCount>): number {
  return [...counts.values()].reduce((sum, count) => sum + count.own, 0)
}

describe('needsYouRows', () => {
  it('counts own prompts per row and bubbles them through every ancestor across three levels', () => {
    const counts = needsYouRows(rows, attention(
      prompt('chat_orch', 'th_r', 'off'),
      prompt('chat_orch', 'th_w', 'escalated'),
      prompt('chat_orch', null, 'off'),
      prompt('chat_plan', null, 'escalated', 'p1'),
      prompt('chat_plan', null, 'off', 'p2')
    ))
    expect(Object.fromEntries(counts)).toEqual({
      chat_orch: { own: 1, descendants: 2, deciding: 0 },
      th_w: { own: 1, descendants: 1, deciding: 0 },
      th_r: { own: 1, descendants: 0, deciding: 0 },
      th_s: { own: 0, descendants: 0, deciding: 0 },
      chat_plan: { own: 2, descendants: 0, deciding: 0 }
    })
    expect(total(counts)).toBe(5)
  })

  it('bubbles to a collapsed ancestor the same way; collapse never hides a count', () => {
    const collapsed = rows.map((row) => ({ ...row, collapsed: row.id === 'th_w' || row.id === 'chat_orch' }))
    const counts = needsYouRows(collapsed, attention(prompt('chat_orch', 'th_r', 'off')))
    expect(counts.get('th_w')).toEqual({ own: 0, descendants: 1, deciding: 0 })
    expect(counts.get('chat_orch')).toEqual({ own: 0, descendants: 1, deciding: 0 })
    expect(total(counts)).toBe(1)
  })

  it('reports prompts the Magos is deciding separately and never counts or bubbles them', () => {
    const counts = needsYouRows(rows, attention(prompt('chat_orch', 'th_r', 'deciding'), prompt('chat_orch', 'th_s', 'off')))
    expect(counts.get('th_r')).toEqual({ own: 0, descendants: 0, deciding: 1 })
    expect(counts.get('th_w')).toEqual({ own: 0, descendants: 0, deciding: 0 })
    expect(counts.get('chat_orch')).toEqual({ own: 0, descendants: 1, deciding: 0 })
    expect(total(counts)).toBe(1)
  })

  it('ignores prompts of unknown chats or threads and survives a parent cycle', () => {
    const cyclic: NeedsYouRow[] = [
      { id: 'a', chatId: 'chat', threadId: 'a', parentId: 'b' },
      { id: 'b', chatId: 'chat', threadId: 'b', parentId: 'a' }
    ]
    const counts = needsYouRows(cyclic, attention(prompt('chat', 'a', 'off'), prompt('other', null, 'off'), prompt('chat', 'zz', 'off')))
    expect(counts.get('a')).toEqual({ own: 1, descendants: 0, deciding: 0 })
    expect(counts.get('b')).toEqual({ own: 0, descendants: 1, deciding: 0 })
  })
})

describe('agentRows', () => {
  const node = (id: string, parentId: string | null): AgentTreeNodeInput => ({
    id, parentId, name: id, secondary: '', chip: null, ticket: null, status: 'running', startedAt: null, endedAt: null, lastTool: null
  })

  it('maps roots to their main thread and threads to the root chat at the top of the chain', () => {
    expect(agentRows([node('chat_orch', null), node('th_w', 'chat_orch'), node('th_r', 'th_w')])).toEqual([
      { id: 'chat_orch', chatId: 'chat_orch', threadId: null, parentId: null },
      { id: 'th_w', chatId: 'chat_orch', threadId: 'th_w', parentId: 'chat_orch' },
      { id: 'th_r', chatId: 'chat_orch', threadId: 'th_r', parentId: 'th_w' }
    ])
  })
})
