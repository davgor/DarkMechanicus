import { describe, expect, it } from 'vitest'
import { isKnowledgeEvent, KNOWLEDGE_EVENTS } from './events'

describe('KNOWLEDGE_EVENTS', () => {
  it('has unique ids, each with a description', () => {
    const ids = KNOWLEDGE_EVENTS.map((event) => event.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(11)
    for (const event of KNOWLEDGE_EVENTS) expect(event.description.length).toBeGreaterThan(0)
  })

  it('guards known event ids only', () => {
    expect(isKnowledgeEvent('ticket.claimed')).toBe(true)
    expect(isKnowledgeEvent('run.recovery')).toBe(true)
    expect(isKnowledgeEvent('attempt.submitted')).toBe(false)
    expect(isKnowledgeEvent(42)).toBe(false)
    expect(isKnowledgeEvent(undefined)).toBe(false)
  })
})
