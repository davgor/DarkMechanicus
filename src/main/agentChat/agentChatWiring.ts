/**
 * Composition of the two owners a chat's live process can have: the terminal (`TerminalSessions`, one PTY per chat)
 * and the GUI (`AgentChatSessions`, one structured CLI process per chat). Each refuses to start while the other is
 * live, through a lazy mutual `isLive`: the terminals are built first, so theirs reads the GUI owner through a
 * closure. The GUI owner is also given the Magos arbiter (`createPromptArbitration`) over the main-side settings and
 * the ticket and Standards context of each run's folder. Quit waits for both owners and cancels every arbiter,
 * deleting a chat stops its GUI process before its terminal and record go, and the one native confirmation that may
 * stop a live terminal is built here over an injected dialog. Free of Electron runtime imports so it is unit tested;
 * `bootstrap.ts` only passes the real factories, settings, workspaces and Electron's dialog in.
 */
import type { MessageBoxOptions } from 'electron'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatPushEvent } from '../../shared/agents/chatApi'
import type { ChatRecord } from '../../shared/agents/chat'
import type { ActivityBindings } from '../agents/activityBindings'
import type { ChatRef } from '../agents/chatStore'
import { readArbiterContext, ticketKeyOfAttempt, type ArbiterReads } from '../magos/arbiterContext'
import { endingTerminals, type TerminalSessions } from '../terminals/terminalSessions'
import type { AgentChatSessions, AgentChatSessionsDeps } from './agentChatSessions'
import { createPromptArbitration } from './promptArbitration'

/** What the wiring needs of the terminals: their ownership, their stop of one owner generation, and quit. */
type TerminalOwners = Pick<TerminalSessions, 'isLive' | 'owner' | 'stop' | 'busy' | 'dispose'>
/**
 * What the GUI owner is given: the terminals' ownership, the `chats_changed` push for a persisted surface switch, the
 * Magos gate, the thread bindings and the ticket key of a bound attempt.
 */
export type AgentChatOwnerDeps = Required<Pick<AgentChatSessionsDeps,
  'terminalLive' | 'terminalOwner' | 'stopTerminal' | 'onChatChanged' | 'arbitrate' | 'bindings' | 'ticketKeyOfAttempt'>>

type ArbitrationDeps = Parameters<typeof createPromptArbitration>[0]

/** The Magos arbiter's main-side dependencies. */
export interface ArbiterWiring extends Pick<ArbitrationDeps, 'settings' | 'onAttention' | 'platform' | 'env' | 'arbiterRoot' | 'startArbiter'> {
  /** The read-only workspace of a tracked folder (its own desktop workspace); throws for an untracked one. */
  arbiterReads(folder: string): ArbiterReads
  /** Verified worker attempts of chat threads (`activity`), shared with the GUI owner. */
  bindings: Pick<ActivityBindings, 'bind' | 'threadsOf'>
  /** Canonical registered worktrees of the folder's repository, besides the folder (red-team fix 20). */
  allowedRoots(folder: string): readonly string[]
}

interface AgentChatWiringOptions<T extends TerminalOwners> {
  /** Builds the chat terminals; `agentChatLive` refuses a terminal start while the GUI owns the chat. */
  terminalsFactory: (agentChatLive: (ref: ChatRef) => boolean) => T
  /** Builds the one GUI session manager over the terminals' ownership and the Magos gate. */
  agentChatsFactory: (owners: AgentChatOwnerDeps) => AgentChatSessions
  /** The `chats:event` push: a surface switch tells every window the chat changed. */
  push: (event: ChatPushEvent) => void
  arbiter: ArbiterWiring
}

export interface AgentChatWiring<T extends TerminalOwners> {
  terminals: T
  agentChats: AgentChatSessions
  /** Quit is held while either owner has work under way. */
  busy(): boolean
  /**
   * Resolves once both owners are disposed (every PTY and GUI process closed, its tree killed and its grants revoked)
   * and every arbiter is cancelled, its runner cleaned up or given up on after its bound.
   */
  dispose(): Promise<void>
}

/** Startup: arbiter working folders a previous run left behind (`<arbiterRoot>/*`) are removed, best effort. */
function sweepArbiterRoot(root: string): void {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const entry of entries) {
    try {
      rmSync(join(root, entry), { recursive: true, force: true })
    } catch { /* A folder still held open is removed at the next start. */ }
  }
}

/** The Magos gate over the folder's workspace reads: the binding of a prompt's thread selects its ticket. */
function arbitration(arbiter: ArbiterWiring) {
  const reads = (folder: string | null): ArbiterReads => {
    if (folder === null) throw new Error('A project-less chat has no workspace.')
    return arbiter.arbiterReads(folder)
  }
  return createPromptArbitration({
    settings: arbiter.settings, onAttention: arbiter.onAttention, platform: arbiter.platform, env: arbiter.env,
    arbiterRoot: arbiter.arbiterRoot, startArbiter: arbiter.startArbiter,
    allowedRoots: chat => chat.folder === null ? [] : arbiter.allowedRoots(chat.folder),
    // An async body turns a throwing lookup into a rejection, which the gate reads as nulls.
    readContext: async ({ chat, prompt }) => {
      const binding = chat.folder === null ? null
        : arbiter.bindings.threadsOf({ folder: chat.folder, id: chat.id }).find(bound => bound.kind === 'attempt' && bound.threadId === prompt.threadId) ?? null
      return readArbiterContext(reads(chat.folder), { chat, threadId: prompt.threadId, binding })
    }
  })
}

export function wireAgentChats<T extends TerminalOwners>({ terminalsFactory, agentChatsFactory, push, arbiter }: AgentChatWiringOptions<T>): AgentChatWiring<T> {
  sweepArbiterRoot(arbiter.arbiterRoot)
  const magos = arbitration(arbiter)
  let agentChats: AgentChatSessions | undefined
  // The terminals exist before the GUI manager: until it does, nothing runs in the GUI.
  const terminals = terminalsFactory(ref => agentChats?.isLive(ref) ?? false)
  const gui = agentChatsFactory({
    terminalLive: ref => terminals.isLive(ref),
    terminalOwner: ref => terminals.owner(ref),
    stopTerminal: (ref, generation) => terminals.stop(ref, generation),
    onChatChanged: ref => push({ type: 'chats_changed', folder: ref.folder, chatId: ref.id }),
    arbitrate: magos.arbitrate,
    bindings: arbiter.bindings,
    ticketKeyOfAttempt: async (folder, attemptId) => {
      try {
        return await ticketKeyOfAttempt(arbiter.arbiterReads(folder), attemptId)
      } catch {
        return null
      }
    }
  })
  agentChats = gui
  return {
    terminals,
    agentChats: gui,
    busy: () => terminals.busy() || gui.busy(),
    dispose: async () => {
      await Promise.all([terminals.dispose(), gui.dispose(), magos.dispose()])
    }
  }
}

/**
 * The default `onAttention` of `ArbiterWiring`: one log line naming the event's kind, folder, chat id and prompt id,
 * never the prompt's text or tool input. The seam stays notification-only: a later notifier ticket may plug the OS
 * notifier into it, while the renderer's attention signal comes from the session manager, not from here.
 */
export function loggedAttention(log: (message: string, fields: { kind: string; folder: string | null; chatId: string; promptId: string }) => void): ArbiterWiring['onAttention'] {
  return ({ kind, ref, prompt }) => {
    try {
      log('Magos attention needed:', { kind, folder: ref.folder, chatId: ref.id, promptId: prompt.id })
    } catch { /* Logging never changes an outcome. */ }
  }
}

/**
 * `chats` with deleting a chat stopping its GUI process first (fenced against a new GUI start), then its terminal
 * (fenced likewise), and only then the record: nothing of the chat runs once it is gone.
 */
export function endingAgentChats<C extends { deleteChat(ref: ChatRef): Promise<void> }>(
  chats: C, terminals: Pick<TerminalSessions, 'deleteChat'>, agentChats: Pick<AgentChatSessions, 'deleteChat'>
): C {
  const ending = endingTerminals(chats, terminals)
  return { ...ending, deleteChat: (ref: ChatRef) => agentChats.deleteChat(ref, () => ending.deleteChat(ref)) }
}

/** The button the person clicks to stop a live terminal; Cancel (index 0) is the default and the escape answer. */
const STOP_BUTTON = 1

/** The native confirmation for an explicit terminal→GUI switch: a live terminal's busy state is never inferred. */
function terminalStopDialog(chat: ChatRecord): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Stop the terminal and switch to the GUI?',
    message: `Stop the running terminal of "${chat.title}" and continue in the GUI?`,
    detail: 'Any work the agent is doing in the terminal right now may be interrupted. The same session is kept: the GUI resumes the conversation where the terminal left it.',
    buttons: ['Cancel', 'Stop terminal and switch'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
}

interface NativeConfirmationDeps<S, W> {
  /** The app window that sent the request; null when it is gone. */
  windowFor(sender: S): W | null
  /** Electron's `dialog.showMessageBox`, modal to `window`. */
  showMessageBox(window: W, options: MessageBoxOptions): Promise<{ response: number }>
}

/**
 * The Main-owned confirmation `AgentChatSessions.setSurface` takes for one explicit `agentChat:setSurface` request:
 * a dialog modal to the requesting window. Only a click on "Stop terminal and switch" is a yes; Cancel, Escape,
 * closing the dialog, a window that is gone or a dialog that fails are all a no, with nothing stopped.
 */
export function nativeTerminalStopConfirmation<S, W>(deps: NativeConfirmationDeps<S, W>): (sender: S, chat: ChatRecord) => Promise<boolean> {
  return async (sender, chat) => {
    try {
      const window = deps.windowFor(sender)
      if (window === null) return false
      const { response } = await deps.showMessageBox(window, terminalStopDialog(chat))
      return response === STOP_BUTTON
    } catch {
      return false
    }
  }
}
