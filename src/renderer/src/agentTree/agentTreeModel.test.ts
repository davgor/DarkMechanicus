import { describe, expect, it } from 'vitest'
import { buildAgentTree, elapsedMs, headerText, hueOf, type AgentTreeNode, type AgentTreeNodeInput } from './agentTreeModel'

function node(id: string, overrides: Partial<AgentTreeNodeInput> = {}): AgentTreeNodeInput {
  return {
    id,
    parentId: null,
    name: id,
    secondary: '',
    chip: null,
    ticket: null,
    status: 'idle',
    startedAt: null,
    endedAt: null,
    lastTool: null,
    ...overrides
  }
}

function flatten(roots: AgentTreeNode[]): AgentTreeNode[] {
  const result = [...roots]
  for (let index = 0; index < result.length; index++) {
    result.push(...result[index].children, ...result[index].finished)
  }
  return result
}

describe('buildAgentTree nesting and grouping', () => {
  it('nests three levels even when children precede their parents', () => {
    const { roots, counts } = buildAgentTree([
      node('helper', { parentId: 'worker', status: 'running' }),
      node('worker', { parentId: 'root', status: 'running' }),
      node('root', { status: 'running' })
    ])
    expect(flatten(roots).map(({ id, depth, descendants }) => ({ id, depth, descendants }))).toEqual([
      { id: 'root', depth: 0, descendants: 2 },
      { id: 'worker', depth: 1, descendants: 1 },
      { id: 'helper', depth: 2, descendants: 0 }
    ])
    expect(counts).toEqual({ needsYou: 0, working: 3, done: 0, failed: 0 })
  })

  it('splits active and finished children in input order and counts both groups', () => {
    const { roots, counts } = buildAgentTree([
      node('root'),
      node('done', { parentId: 'root', status: 'done' }),
      node('running', { parentId: 'root', status: 'running' }),
      node('failed', { parentId: 'root', status: 'failed' }),
      node('idle', { parentId: 'root' }),
      node('attention', { parentId: 'root', status: 'needs_you' }),
      node('finished-helper', { parentId: 'done', status: 'done' })
    ])
    expect(roots[0].children.map(({ id }) => id)).toEqual(['running', 'idle', 'attention'])
    expect(roots[0].finished.map(({ id }) => id)).toEqual(['done', 'failed'])
    expect(roots[0].descendants).toBe(6)
    expect(roots[0].finished[0].descendants).toBe(1)
    expect(roots[0].finished[0].finished[0].depth).toBe(2)
    expect(counts).toEqual({ needsYou: 1, working: 1, done: 2, failed: 1 })
  })

  it('retains orphans and their descendants as rooted subtrees', () => {
    const { roots } = buildAgentTree([
      node('orphan', { parentId: 'unknown' }),
      node('child', { parentId: 'orphan' }),
      node('root')
    ])
    expect(roots.map(({ id, parentId }) => [id, parentId])).toEqual([['orphan', null], ['root', null]])
    expect(roots[0].children[0].id).toBe('child')
    expect(roots[0].descendants).toBe(1)
  })
})

describe('buildAgentTree cycles and duplicates', () => {
  it('cuts two-node cycles and self-parent edges without duplicating or dropping nodes', () => {
    const { roots } = buildAgentTree([
      node('a', { parentId: 'b' }),
      node('b', { parentId: 'a' }),
      node('self', { parentId: 'self' })
    ])
    expect(roots.map(({ id }) => id)).toEqual(['a', 'self'])
    expect(roots[0].parentId).toBeNull()
    expect(roots[0].children[0].id).toBe('b')
    expect(roots[1].parentId).toBeNull()
    expect(flatten(roots).map(({ id }) => id).sort()).toEqual(['a', 'b', 'self'])
  })

  it('cuts at the loop rather than dropping a chain that leads into it', () => {
    const { roots } = buildAgentTree([
      node('leaf', { parentId: 'a', status: 'needs_you' }),
      node('a', { parentId: 'b' }),
      node('b', { parentId: 'c' }),
      node('c', { parentId: 'a' })
    ])
    expect(roots.map(({ id }) => id)).toEqual(['a'])
    expect(flatten(roots).map(({ id }) => id).sort()).toEqual(['a', 'b', 'c', 'leaf'])
    expect(roots[0].descendants).toBe(3)
    expect(roots[0].needsYouBelow).toBe(true)
  })

  it('keeps the last duplicate input and its position, counting it only once', () => {
    const replacement = node('duplicate', {
      parentId: 'root', name: 'latest', secondary: 'purpose', chip: 'Worker',
      ticket: { key: 'DM-794', verified: true, mismatch: false }, status: 'done',
      startedAt: 0, endedAt: 100, lastTool: 'read'
    })
    const { roots, counts } = buildAgentTree([
      node('root'),
      node('duplicate', { parentId: 'unknown', status: 'needs_you' }),
      node('first', { parentId: 'root', status: 'done' }),
      replacement
    ])
    expect(roots).toHaveLength(1)
    expect(roots[0].finished.map(({ id }) => id)).toEqual(['first', 'duplicate'])
    expect(roots[0].finished[1]).toMatchObject(replacement)
    expect(roots[0].descendants).toBe(2)
    expect(counts).toEqual({ needsYou: 0, working: 0, done: 2, failed: 0 })
  })
})

describe('buildAgentTree attention and depth', () => {
  it('bubbles attention only to ancestors, including through finished parents', () => {
    const { roots } = buildAgentTree([
      node('root'),
      node('parent', { parentId: 'root', status: 'done' }),
      node('leaf', { parentId: 'parent', status: 'needs_you' }),
      node('sibling', { parentId: 'parent' }),
      node('other-root')
    ])
    expect(Object.fromEntries(flatten(roots).map(({ id, needsYouBelow }) => [id, needsYouBelow]))).toEqual({
      root: true, parent: true, leaf: false, sibling: false, 'other-root': false
    })
  })

  it('handles deep trees iteratively without modifying frozen inputs', () => {
    const inputs = Object.freeze(Array.from({ length: 20_000 }, (_, index) => Object.freeze(node(String(index), {
      parentId: index === 0 ? 'missing' : String(index - 1),
      status: index === 19_999 ? 'needs_you' : 'idle'
    }))).reverse())
    const { roots } = buildAgentTree(inputs)
    const all = flatten(roots)
    expect(all).toHaveLength(20_000)
    expect(roots[0].descendants).toBe(19_999)
    expect(roots[0].needsYouBelow).toBe(true)
    expect(all[19_999].depth).toBe(19_999)
    expect(inputs[19_999].parentId).toBe('missing')
    expect(all.every((entry) => entry.hue === hueOf(entry.id))).toBe(true)
  })
})

describe('headerText', () => {
  it('joins nonzero counts in attention, working, done, failed order', () => {
    expect(headerText({ needsYou: 1, working: 3, done: 5, failed: 0 }, true)).toBe('1 needs you · 3 working · 5 done')
    expect(headerText({ needsYou: 1, working: 3, done: 5, failed: 1 }, true)).toBe('1 needs you · 3 working · 5 done · 1 failed')
    expect(headerText({ needsYou: 0, working: 0, done: 0, failed: 2 }, true)).toBe('2 failed')
  })

  it('distinguishes all-idle nodes from an empty forest', () => {
    const idle = buildAgentTree([node('idle')])
    const empty = buildAgentTree([])
    expect(idle.counts).toEqual(empty.counts)
    expect(headerText(idle.counts, idle.roots.length > 0)).toBe('Idle')
    expect(headerText(empty.counts, empty.roots.length > 0)).toBe('No agents')
    expect(empty.roots).toEqual([])
  })
})

describe('hueOf', () => {
  it('matches FNV-1a vectors including UTF-16 surrogate units', () => {
    expect(['', 'a', 'b', 'hello', '😀'].map(hueOf)).toEqual([5, 4, 5, 3, 0])
  })

  it('is stable and in the integer range 0 through 7', () => {
    for (const id of ['', 'Magos', 'Acolyte:DM-794', '中文', '😀', ...Array.from({ length: 100 }, (_, i) => String(i))]) {
      const hue = hueOf(id)
      expect(hueOf(id)).toBe(hue)
      expect(Number.isInteger(hue)).toBe(true)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThanOrEqual(7)
    }
  })
})

describe('elapsedMs', () => {
  it('uses now while active and endedAt when finished, including zero timestamps', () => {
    expect(elapsedMs(node('active', { startedAt: 100 }), 500)).toBe(400)
    expect(elapsedMs(node('finished', { startedAt: 100, endedAt: 300 }), 500)).toBe(200)
    expect(elapsedMs(node('zero-start', { startedAt: 0 }), 500)).toBe(500)
    expect(elapsedMs(node('zero-end', { startedAt: -100, endedAt: 0 }), 500)).toBe(100)
  })

  it('returns null without a start timestamp', () => {
    expect(elapsedMs(node('unknown'), 500)).toBeNull()
    expect(elapsedMs(node('unknown', { endedAt: 300 }), 500)).toBeNull()
  })
})
