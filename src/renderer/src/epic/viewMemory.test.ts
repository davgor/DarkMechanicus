import { describe, expect, it } from 'vitest'
import { createViewMemory } from './viewMemory'

describe('view memory', () => {
  it('remembers a view per folder and epic until it is forgotten', () => {
    const memory = createViewMemory()
    expect(memory.recall('/a', 'ep_1')).toBe(null)
    memory.remember('/a', 'ep_1', 'draft')
    memory.remember('/b', 'ep_1', 'saved')
    expect([memory.recall('/a', 'ep_1'), memory.recall('/b', 'ep_1'), memory.recall('/a', 'ep_2')]).toEqual(['draft', 'saved', null])
    memory.remember('/a', 'ep_1', null)
    expect([memory.recall('/a', 'ep_1'), memory.recall('/b', 'ep_1')]).toEqual([null, 'saved'])
  })
})
