/**
 * Which chats have a live PTY, for the dot on their sidebar rows (`docs/design/chat-shells.md`, "Layout").
 * Main posts a PTY's exit only on the ports attached to it, so the page keeps the latest port of every chat it
 * attached open while the chat is not shown, and counts the chat live until that port tells of the exit.
 * The pane drops its xterm on a switch; the port stays here. What the page has not attached since it loaded
 * (a reload) is not known to be live.
 */
import { createContext, useContext, useSyncExternalStore } from 'react'
import type { TerminalHandle } from '../../../shared/agents/terminalApi'

export interface LiveTerminals {
  /**
   * Holds the chat's terminal from an attach: the one it held before is closed (its PTY runs on), and the chat
   * counts as live until this one exits.
   */
  hold(chatId: string, terminal: TerminalHandle): void
  isLive(chatId: string): boolean
  /** Calls `listener` whenever a chat becomes live or stops being live; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
}

export function createLiveTerminals(): LiveTerminals {
  const held = new Map<string, TerminalHandle>()
  const listeners = new Set<() => void>()
  const changed = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }
  return {
    hold: (chatId, terminal) => {
      const before = held.get(chatId)
      if (before === terminal) {
        return
      }
      before?.close()
      held.set(chatId, terminal)
      terminal.onExit(() => {
        terminal.close()
        if (held.get(chatId) === terminal) {
          held.delete(chatId)
          changed()
        }
      })
      if (before === undefined) {
        changed()
      }
    },
    isLive: (chatId) => held.has(chatId),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

/** The page's registry, from the shell; none outside it (a pane then closes its own terminal when it hides). */
export const LiveTerminalsContext = createContext<LiveTerminals | null>(null)

const NO_CHANGES = (): (() => void) => () => {}

/** Whether the chat has a live PTY, as the page last heard. */
export function useLiveTerminal(chatId: string): boolean {
  const live = useContext(LiveTerminalsContext)
  return useSyncExternalStore(live?.subscribe ?? NO_CHANGES, () => live?.isLive(chatId) ?? false)
}
