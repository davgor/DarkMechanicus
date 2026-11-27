/**
 * The epic's top-level agents as browser-style tabs over the Agent stage. Pure: the strip renders what this derives.
 * The run's Magos is always a tab while the run exists; any other chat of the epic is a tab while it is live (a
 * stopped chat that mail wakes comes back) or while it is selected. Workers stay in the rail tree.
 */
import { rootCallsignOf } from '../../../shared/agents/callsign'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { RunView } from '../../../shared/domain/views'

/** What the page knows of a chat now: whether its process runs, whether it is mid-turn, and the mail the person has not seen. */
export interface AgentTabSignals {
  live: boolean
  busy: boolean
  unread: number
}

export interface AgentTabsInput {
  /** The epic's chats (`epicChats`). */
  chats: readonly ChatRecord[]
  run: RunView | null
  /** The selected root chat; a selected worker thread selects its owner here. */
  selectedId: string | null
  /** Each root's name in the rail tree (Magos, Lexmechanic, Lexmechanic-2, or the chat's title). */
  names: ReadonlyMap<string, string>
  signals: ReadonlyMap<string, AgentTabSignals>
  /** Roots with a prompt waiting on the person, their own or a worker's. */
  needsYou: ReadonlySet<string>
  /** Whether the chat's agent is a Skitarii (OMP) agent, the only kind that coordinates over Skitarii mail. */
  coordinates(chat: ChatRecord): boolean
}

export interface AgentTab {
  chatId: string
  name: string
  /** The role art the tab shows; null for a chat without a root callsign. */
  callsign: 'Magos' | 'Lexmechanic' | null
  /** The run's Magos: always a tab and never closed from the strip. */
  magos: boolean
  live: boolean
  busy: boolean
  unread: number
  needsYou: boolean
  coordinates: boolean
  /** Whether the tab offers ✕: a live GUI chat other than the Magos, which the strip can stop. */
  closable: boolean
  /** The chat's agent, for the tooltip. */
  agentId: string
}

const NO_SIGNALS: AgentTabSignals = { live: false, busy: false, unread: 0 }

/** The run's orchestrator chat, whatever the run's state; null without a run or chat. */
export function runMagosId(chats: readonly ChatRecord[], run: RunView | null): string | null {
  if (run === null) return null
  return chats.find((chat) => chat.runId === run.id && chat.role === 'orchestrator')?.id ?? null
}

function byCreation(a: ChatRecord, b: ChatRecord): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** The tabs in strip order: the Magos first, then the others by creation. */
export function agentTabs({ chats, run, selectedId, names, signals, needsYou, coordinates }: AgentTabsInput): AgentTab[] {
  const magosId = runMagosId(chats, run)
  const shown = chats.filter((chat) => chat.id === magosId || chat.id === selectedId || (signals.get(chat.id) ?? NO_SIGNALS).live)
  const ordered = [
    ...shown.filter((chat) => chat.id === magosId),
    ...shown.filter((chat) => chat.id !== magosId).sort(byCreation)
  ]
  return ordered.map((chat) => {
    const { live, busy, unread } = signals.get(chat.id) ?? NO_SIGNALS
    const magos = chat.id === magosId
    const gui = chat.surface === 'gui'
    const role = rootCallsignOf(chat)?.role
    return {
      chatId: chat.id,
      name: names.get(chat.id) ?? chat.title,
      callsign: role === 'Magos' || role === 'Lexmechanic' ? role : null,
      magos,
      live,
      busy,
      unread,
      needsYou: needsYou.has(chat.id),
      coordinates: coordinates(chat),
      closable: !magos && live && gui,
      agentId: chat.agent
    }
  })
}

/** The epic's chats the strip does not show, newest first: what "+" offers to reopen. */
export function reopenableChats(chats: readonly ChatRecord[], tabs: readonly AgentTab[]): ChatRecord[] {
  const shown = new Set(tabs.map((tab) => tab.chatId))
  return chats.filter((chat) => !shown.has(chat.id)).sort((a, b) => byCreation(b, a))
}

/** The tab `step` places from the current one, wrapping around; the first tab when none is current. */
export function cycleTab(tabs: readonly AgentTab[], currentId: string | null, step: number): string | null {
  if (tabs.length === 0) return null
  const index = tabs.findIndex((tab) => tab.chatId === currentId)
  if (index < 0) return tabs[0].chatId
  return tabs[(((index + step) % tabs.length) + tabs.length) % tabs.length].chatId
}

/** Where the selection goes when the selected tab closes: the Magos, else the next tab, else the one before. */
export function tabAfterClose(tabs: readonly AgentTab[], closingId: string): string | null {
  const rest = tabs.filter((tab) => tab.chatId !== closingId)
  const magos = rest.find((tab) => tab.magos)
  if (magos !== undefined) return magos.chatId
  const index = tabs.findIndex((tab) => tab.chatId === closingId)
  return rest[Math.min(Math.max(index, 0), rest.length - 1)]?.chatId ?? null
}
