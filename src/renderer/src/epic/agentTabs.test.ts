import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../shared/agents/chat'
import { chatRecord } from '../__mocks__/fixtures'
import { runView } from './__mocks__/fixtures'
import { agentTabs, cycleTab, reopenableChats, runMagosId, tabAfterClose, type AgentTabSignals, type AgentTabsInput } from './agentTabs'

const run = runView()
const magos = chatRecord({ id: 'chat_magos', role: 'orchestrator', runId: run.id, agent: 'omp', surface: 'gui', createdAt: '2026-03-01T12:00:00.000Z' })
const planner = chatRecord({ id: 'chat_plan', role: 'planner', agent: 'omp', surface: 'gui', createdAt: '2026-03-01T09:00:00.000Z' })
const planner2 = chatRecord({ id: 'chat_plan2', role: 'planner', agent: 'claude', surface: 'gui', createdAt: '2026-03-01T11:00:00.000Z' })
const transfer = chatRecord({ id: 'chat_transfer', role: 'orchestrator', transferEpicId: 'ep_1', surface: 'terminal', createdAt: '2026-03-01T10:00:00.000Z' })
const CHATS: readonly ChatRecord[] = [magos, planner2, transfer, planner]

const live = (patch: Partial<AgentTabSignals> = {}): AgentTabSignals => ({ live: true, busy: false, unread: 0, ...patch })
const stopped = (patch: Partial<AgentTabSignals> = {}): AgentTabSignals => ({ live: false, busy: false, unread: 0, ...patch })

function input(patch: Partial<AgentTabsInput> = {}): AgentTabsInput {
  return {
    chats: CHATS, run, selectedId: magos.id,
    names: new Map([[magos.id, 'Magos'], [planner.id, 'Lexmechanic'], [planner2.id, 'Lexmechanic-2']]),
    signals: new Map(), needsYou: new Set(), coordinates: (chat) => chat.agent === 'omp',
    ...patch
  }
}

const ids = (patch: Partial<AgentTabsInput> = {}): string[] => agentTabs(input(patch)).map((tab) => tab.chatId)

describe('agentTabs', () => {
  it('always shows the run’s Magos, live or not, and never offers to close it', () => {
    const tabs = agentTabs(input({ selectedId: planner.id, signals: new Map([[magos.id, stopped()]]) }))
    expect(tabs[0]).toMatchObject({ chatId: magos.id, name: 'Magos', callsign: 'Magos', magos: true, live: false, closable: false })
    expect(agentTabs(input({ signals: new Map([[magos.id, live()]]) }))[0]).toMatchObject({ magos: true, live: true, closable: false })
    expect(runMagosId(CHATS, null)).toBeNull()
    expect(ids({ run: null, selectedId: null })).toEqual([])
  })

  it('shows a stopped planner only while it is selected', () => {
    const signals = new Map([[planner.id, stopped()]])
    expect(ids({ signals })).toEqual([magos.id])
    const selected = agentTabs(input({ signals, selectedId: planner.id }))
    expect(selected.map((tab) => tab.chatId)).toEqual([magos.id, planner.id])
    expect(selected[1]).toMatchObject({ live: false, closable: false })
  })

  it('brings back a planner that mail woke, with its unread count', () => {
    expect(ids({ signals: new Map([[planner.id, stopped({ unread: 1 })]]) })).toEqual([magos.id])
    const woken = agentTabs(input({ signals: new Map([[planner.id, live({ unread: 1 })]]) }))
    expect(woken.map((tab) => tab.chatId)).toEqual([magos.id, planner.id])
    expect(woken[1]).toMatchObject({ name: 'Lexmechanic', callsign: 'Lexmechanic', unread: 1, closable: true })
  })

  it('orders the Magos first, then the other tabs by creation', () => {
    const signals = new Map([[planner.id, live()], [planner2.id, live()], [transfer.id, live()]])
    expect(ids({ signals })).toEqual([magos.id, planner.id, transfer.id, planner2.id])
  })

  it('passes unread, needs-you, busy and coordination through; only a live GUI chat other than the Magos closes', () => {
    const tabs = agentTabs(input({
      signals: new Map([[magos.id, live({ busy: true, unread: 2 })], [planner2.id, live()], [transfer.id, live()]]),
      needsYou: new Set([magos.id, transfer.id])
    }))
    expect(tabs.map(({ chatId, busy, unread, needsYou, coordinates, closable }) => ({ chatId, busy, unread, needsYou, coordinates, closable }))).toEqual([
      { chatId: magos.id, busy: true, unread: 2, needsYou: true, coordinates: true, closable: false },
      { chatId: transfer.id, busy: false, unread: 0, needsYou: true, coordinates: false, closable: false },
      { chatId: planner2.id, busy: false, unread: 0, needsYou: false, coordinates: false, closable: true }
    ])
    // A chat without a root callsign keeps its title and the generic icon.
    expect(tabs[1]).toMatchObject({ name: transfer.title, callsign: null })
  })
})

describe('agentTabs: reopening and moving between tabs', () => {
  it('offers every chat the strip does not show to reopen, newest first', () => {
    const tabs = agentTabs(input({ signals: new Map([[planner2.id, live()]]) }))
    expect(reopenableChats(CHATS, tabs).map((chat) => chat.id)).toEqual([transfer.id, planner.id])
  })

  it('cycles forwards and backwards with wrap-around, and moves a closed selection to the Magos', () => {
    const tabs = agentTabs(input({ signals: new Map([[planner.id, live()], [planner2.id, live()]]) }))
    expect(cycleTab(tabs, magos.id, 1)).toBe(planner.id)
    expect(cycleTab(tabs, planner2.id, 1)).toBe(magos.id)
    expect(cycleTab(tabs, magos.id, -1)).toBe(planner2.id)
    expect(cycleTab(tabs, 'gone', 1)).toBe(magos.id)
    expect(cycleTab([], null, 1)).toBeNull()
    expect(tabAfterClose(tabs, planner.id)).toBe(magos.id)
    const noMagos = agentTabs(input({ run: null, signals: new Map([[planner.id, live()], [planner2.id, live()]]) }))
    expect(tabAfterClose(noMagos, planner.id)).toBe(planner2.id)
    expect(tabAfterClose(noMagos.slice(0, 1), planner.id)).toBeNull()
  })
})
