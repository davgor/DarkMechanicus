/**
 * Composition of the two owners a chat's live process can have: the terminal (`TerminalSessions`, one PTY per chat)
 * and the GUI (`AgentChatSessions`, one structured CLI process per chat). Each refuses to start while the other is
 * live, through a lazy mutual `isLive`: the terminals are built first, so theirs reads the GUI owner through a
 * closure. Quit waits for both, deleting a chat stops its GUI process before its terminal and record go, and the one
 * native confirmation that may stop a live terminal is built here over an injected dialog. Free of Electron runtime
 * imports so it is unit tested; `bootstrap.ts` only passes the real factories and Electron's dialog in.
 */
import type { MessageBoxOptions } from 'electron'
import type { ChatPushEvent } from '../../shared/agents/chatApi'
import type { ChatRecord } from '../../shared/agents/chat'
import type { ChatRef } from '../agents/chatStore'
import { endingTerminals, type TerminalSessions } from '../terminals/terminalSessions'
import type { AgentChatSessions, AgentChatSessionsDeps } from './agentChatSessions'

/** What the wiring needs of the terminals: their ownership, their stop of one owner generation, and quit. */
type TerminalOwners = Pick<TerminalSessions, 'isLive' | 'owner' | 'stop' | 'busy' | 'dispose'>
/** What the GUI owner is given of the terminals, and the `chats_changed` push for a persisted surface switch. */
export type AgentChatOwnerDeps = Pick<AgentChatSessionsDeps, 'terminalLive' | 'terminalOwner' | 'stopTerminal' | 'onChatChanged'>

interface AgentChatWiringOptions<T extends TerminalOwners> {
  /** Builds the chat terminals; `agentChatLive` refuses a terminal start while the GUI owns the chat. */
  terminalsFactory: (agentChatLive: (ref: ChatRef) => boolean) => T
  /** Builds the one GUI session manager over the terminals' ownership. */
  agentChatsFactory: (owners: AgentChatOwnerDeps) => AgentChatSessions
  /** The `chats:event` push: a surface switch tells every window the chat changed. */
  push: (event: ChatPushEvent) => void
}

export interface AgentChatWiring<T extends TerminalOwners> {
  terminals: T
  agentChats: AgentChatSessions
  /** Quit is held while either owner has work under way. */
  busy(): boolean
  /** Resolves once both owners are disposed: every PTY and GUI process closed, its tree killed and its grants revoked. */
  dispose(): Promise<void>
}

export function wireAgentChats<T extends TerminalOwners>({ terminalsFactory, agentChatsFactory, push }: AgentChatWiringOptions<T>): AgentChatWiring<T> {
  let agentChats: AgentChatSessions | undefined
  // The terminals exist before the GUI manager: until it does, nothing runs in the GUI.
  const terminals = terminalsFactory(ref => agentChats?.isLive(ref) ?? false)
  const gui = agentChatsFactory({
    terminalLive: ref => terminals.isLive(ref),
    terminalOwner: ref => terminals.owner(ref),
    stopTerminal: (ref, generation) => terminals.stop(ref, generation),
    onChatChanged: ref => push({ type: 'chats_changed', folder: ref.folder, chatId: ref.id })
  })
  agentChats = gui
  return {
    terminals,
    agentChats: gui,
    busy: () => terminals.busy() || gui.busy(),
    dispose: async () => {
      await Promise.all([terminals.dispose(), gui.dispose()])
    }
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
