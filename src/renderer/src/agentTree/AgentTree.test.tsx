// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Callsign } from '../../../shared/agents/callsign'
import type { ChatItem } from '../../../shared/agents/chat'
import { ThreadBlock } from '../agents/ThreadBlock'
import { transcriptTree } from '../agents/threadModel'
import { AgentTree } from './AgentTree'
import { buildAgentTree, type AgentTreeNodeInput } from './agentTreeModel'
import { chatAgentNodes } from './chatAgentNodes'

const now = 100_000
function node(id: string, overrides: Partial<AgentTreeNodeInput> = {}): AgentTreeNodeInput {
  return { id, parentId: null, name: id, secondary: '', chip: null, ticket: null, status: 'running',
    startedAt: null, endedAt: null, lastTool: null, ...overrides }
}
function chain(): AgentTreeNodeInput[] {
  return [node('root', { name: 'Magos', startedAt: now - 72_000 }),
    node('worker', { name: 'Acolyte:DM-2', parentId: 'root' }),
    node('reviewer', { name: 'Inquisitor:DM-2', parentId: 'worker', status: 'needs_you' })]
}
function show(inputs = chain(), selectedId: string | null = 'root') {
  const onSelect = vi.fn()
  const view = render(<AgentTree tree={buildAgentTree(inputs)} selectedId={selectedId} onSelect={onSelect} now={now} />)
  return { ...view, onSelect }
}
function row(name: string): HTMLElement { return screen.getByRole('treeitem', { name }) }
function key(name: string, value: string): void { fireEvent.keyDown(row(name), { key: value }) }
function treeRows(): [string | null, string | null, string | null][] {
  return screen.getAllByRole('treeitem').map((item) => [item.getAttribute('aria-label'), item.getAttribute('aria-level'), item.getAttribute('aria-expanded')])
}
afterEach(cleanup)

describe('AgentTree rows and disclosure', () => {
  it('renders nested levels, selected state, elapsed and click selection', () => {
    const { onSelect } = show()
    expect(screen.getByRole('tree', { name: 'Agents' })).toBeTruthy()
    expect(treeRows()).toEqual([['Magos', '1', 'true'], ['Acolyte:DM-2', '2', 'true'], ['Inquisitor:DM-2', '3', null]])
    expect(row('Magos').getAttribute('aria-selected')).toBe('true')
    expect(row('Acolyte:DM-2').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByText('1m ago')).toBeTruthy()
    fireEvent.click(screen.getByText('Acolyte:DM-2'))
    expect(onSelect.mock.calls).toEqual([['worker']])
  })

  it('collapses descendants with their total count and attention indicator', () => {
    const { onSelect } = show()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Magos' }))
    expect(treeRows()).toEqual([['Magos', '1', 'false']])
    expect(screen.getByText('(+2)')).toBeTruthy()
    expect(screen.getByLabelText('Descendant needs you').className).toBe('at-needs')
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Expand Magos' }))
    expect(screen.getAllByRole('treeitem')).toHaveLength(3)
  })

  it('adds a collapsed Finished group at the real synthetic hierarchy level', () => {
    const { onSelect } = show([...chain(), node('helper', { name: 'Servitor-1', parentId: 'root' }),
      node('old', { name: 'Acolyte:DM-1', parentId: 'root', status: 'done' })])
    expect(treeRows()).toEqual([['Magos', '1', 'true'], ['Acolyte:DM-2', '2', 'true'],
      ['Inquisitor:DM-2', '3', null], ['Servitor-1', '2', null], ['Finished 1', '2', 'false']])
    expect(screen.queryByText('Acolyte:DM-1')).toBeNull()
    fireEvent.click(screen.getByText('Finished 1'))
    expect(row('Acolyte:DM-1').getAttribute('aria-level')).toBe('3')
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Acolyte:DM-1'))
    expect(onSelect).toHaveBeenCalledWith('old')
  })
})

describe('AgentTree keyboard navigation', () => {
  it('moves, expands, collapses and selects with one roving tab stop', () => {
    const { onSelect } = show()
    row('Magos').focus()
    key('Magos', 'ArrowDown')
    expect(document.activeElement).toBe(row('Acolyte:DM-2'))
    key('Acolyte:DM-2', 'ArrowRight')
    expect(document.activeElement).toBe(row('Inquisitor:DM-2'))
    key('Inquisitor:DM-2', 'ArrowLeft')
    expect(document.activeElement).toBe(row('Acolyte:DM-2'))
    key('Acolyte:DM-2', 'ArrowLeft')
    expect(row('Acolyte:DM-2').getAttribute('aria-expanded')).toBe('false')
    key('Acolyte:DM-2', 'ArrowRight')
    expect(row('Acolyte:DM-2').getAttribute('aria-expanded')).toBe('true')
    key('Acolyte:DM-2', 'Enter')
    key('Acolyte:DM-2', ' ')
    expect(onSelect.mock.calls).toEqual([['worker'], ['worker']])
    expect(screen.getAllByRole('treeitem').map((item) => item.tabIndex)).toEqual([-1, 0, -1])
    expect(screen.getAllByRole('button').every((button) => button.tabIndex === -1)).toBe(true)
  })

  it('supports Home, End, ArrowUp and boundaries through visible rows only', () => {
    show()
    key('Magos', 'End')
    expect(document.activeElement).toBe(row('Inquisitor:DM-2'))
    key('Inquisitor:DM-2', 'ArrowDown')
    expect(document.activeElement).toBe(row('Inquisitor:DM-2'))
    key('Inquisitor:DM-2', 'ArrowUp')
    expect(document.activeElement).toBe(row('Acolyte:DM-2'))
    key('Acolyte:DM-2', 'Home')
    key('Magos', 'ArrowUp')
    expect(document.activeElement).toBe(row('Magos'))
    key('Magos', 'ArrowLeft')
    key('Magos', 'End')
    expect(document.activeElement).toBe(row('Magos'))
  })

  it('navigates and activates the Finished group without selecting a synthetic id', () => {
    const { onSelect } = show([node('root', { name: 'Magos' }), node('done', { parentId: 'root', status: 'done' })])
    key('Magos', 'End')
    key('Finished 1', 'Enter')
    key('Finished 1', 'ArrowRight')
    expect(document.activeElement).toBe(row('done'))
    key('done', 'ArrowLeft')
    key('Finished 1', ' ')
    expect(row('Finished 1').getAttribute('aria-expanded')).toBe('false')
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('AgentTree text and model updates', () => {
  it('renders literal text, ticket provenance, status, tool and full secondary title', () => {
    const { container } = show([node('root', { name: '<b>x</b>', secondary: '<i>full secondary</i>', chip: 'worker',
      ticket: { key: 'DM-2', verified: false, mismatch: false }, lastTool: 'Read' }),
    node('other', { ticket: { key: 'DM-3', verified: true, mismatch: true }, status: 'failed' })])
    expect(screen.getByText('<b>x</b>')).toBeTruthy()
    expect(container.querySelector('b, i')).toBeNull()
    expect(screen.getByText('DM-2').className).toBe('at-unverified')
    expect(screen.getByText('DM-2').title).toBe('Not confirmed by a claim')
    expect(screen.getByText('DM-3').parentElement?.title).toBe('Label named another ticket; the claim wins')
    expect(screen.getByText('DM-3').className).toBe('')
    expect(screen.getByText('<i>full secondary</i>').title).toBe('<i>full secondary</i>')
    expect(screen.getByText('Read').className).toBe('at-tool')
    expect(screen.getByLabelText('Failed').getAttribute('data-status')).toBe('failed')
    expect(container.querySelector('.at-dot')?.getAttribute('data-hue')).toMatch(/^[0-7]$/)
  })

  it('preserves local expansion across new model objects and restores a tab stop after removal', () => {
    const { rerender, onSelect } = show()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Acolyte:DM-2' }))
    rerender(<AgentTree tree={buildAgentTree(chain())} selectedId="worker" onSelect={onSelect} now={now + 1000} label="Run agents" />)
    expect(row('Acolyte:DM-2').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('tree', { name: 'Run agents' })).toBeTruthy()
    rerender(<AgentTree tree={buildAgentTree([chain()[0]])} selectedId={null} onSelect={onSelect} now={now} />)
    expect(row('Magos').tabIndex).toBe(0)
    expect(row('Magos').getAttribute('aria-expanded')).toBeNull()
  })

  it('distinguishes an empty tree from idle and uses ended time for elapsed', () => {
    const { rerender, onSelect } = show([])
    expect(screen.getByText('No agents')).toBeTruthy()
    rerender(<AgentTree tree={buildAgentTree([node('idle', { status: 'idle', startedAt: 0, endedAt: 72_000 })])}
      selectedId={null} onSelect={onSelect} now={now} />)
    expect(screen.getByText('Idle')).toBeTruthy()
    expect(screen.getByText('1m ago')).toBeTruthy()
  })
})

describe('AgentTree from a chat transcript mixing legacy and stamped threads', () => {
  type ThreadItem = Extract<ChatItem, { kind: 'thread' }>
  const servitor = (ordinal: number): Callsign => ({ role: 'Servitor', ticketKey: null, ordinal, purpose: null, ticketVerified: false })
  const thread = (id: string, callsign?: Callsign): ThreadItem => ({
    id, at: '2026-11-25T10:00:00.000Z', kind: 'thread', parentItemId: null, label: 'Explore', state: 'running', ...(callsign ? { callsign } : {})
  })
  // A thread stored before callsigns existed, then one main stamped Servitor-1 because it counted only stamped threads.
  const fixture: ChatItem[] = [thread('th_legacy'), thread('th_stamped', servitor(1))]
  function treeOf(items: readonly ChatItem[]) {
    return buildAgentTree(chatAgentNodes({
      root: { id: 'chat:c1', chat: { role: 'orchestrator', runId: 'run-1' }, fallbackName: 'Claude', secondary: '', status: 'running', startedAt: null, endedAt: null },
      items, savedTickets: []
    }))
  }
  function subagentNames(): (string | null)[] {
    return screen.getAllByRole('treeitem').slice(1).map((item) => item.getAttribute('aria-label'))
  }
  /** The heading the transcript gives the legacy thread (the first item), rendered as the chat renders it. */
  function blockName(items: readonly ChatItem[]): string | null {
    const node = transcriptTree(items).flatMap((row) => row.threads).find(({ item }) => item.id === 'th_legacy')!
    const { container, unmount } = render(<ol><ThreadBlock node={node} renderRow={() => null} /></ol>)
    const name = container.querySelector('.chat-thread-label')?.textContent ?? null
    unmount()
    return name
  }

  it('assigns unique Servitor-N callsigns', () => {
    render(<AgentTree tree={treeOf(fixture)} selectedId={null} onSelect={vi.fn()} now={now} />)
    const names = subagentNames()
    expect([...names].sort()).toEqual(['Servitor-1', 'Servitor-2'])
    expect(new Set(names).size).toBe(names.length)
  })

  it('names a live legacy thread alike in the tree and its transcript block, from first render through main\'s stamp', () => {
    const view = render(<AgentTree tree={treeOf(fixture)} selectedId={null} onSelect={vi.fn()} now={now} />)
    expect(subagentNames()[0]).toBe('Servitor-2')
    expect(blockName(fixture)).toBe('Servitor-2')
    // Main's next event for the live thread carries the ordinal it reserved for it (agentChatSessions seeds the same one).
    const restamped = [thread('th_legacy', servitor(2)), fixture[1]!]
    view.rerender(<AgentTree tree={treeOf(restamped)} selectedId={null} onSelect={vi.fn()} now={now} />)
    expect(subagentNames()).toEqual(['Servitor-2', 'Servitor-1'])
    expect(blockName(restamped)).toBe('Servitor-2')
  })
})
