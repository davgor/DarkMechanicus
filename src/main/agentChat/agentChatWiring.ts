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
import { formatCallsign, rootCallsignOf } from '../../shared/agents/callsign'
import type { ActivityBindings } from '../agents/activityBindings'
import type { ChatRef } from '../agents/chatStore'
import { readArbiterContext, ticketKeyOfAttempt, type ArbiterReads } from '../magos/arbiterContext'
import type { NotificationEvent } from '../notify/notifier'
import { endingTerminals, type TerminalSessions } from '../terminals/terminalSessions'
import type { AgentChatSessions, AgentChatSessionsDeps } from './agentChatSessions'
import type { AttentionEvent } from './pendingPrompts'
import { createPromptArbitration } from './promptArbitration'

/** What the wiring needs of the terminals: their ownership, their stop of one owner generation, and quit. */
type TerminalOwners = Pick<TerminalSessions, 'isLive' | 'owner' | 'stop' | 'busy' | 'dispose'>
/**
 * What the GUI owner is given: the terminals' ownership, the `chats_changed` push for a persisted surface switch, the
 * Magos gate, the thread bindings, the ticket key of a bound attempt and the OS notifier's stall seam.
 */
export type AgentChatOwnerDeps = Required<Pick<AgentChatSessionsDeps,
  'terminalLive' | 'terminalOwner' | 'stopTerminal' | 'onChatChanged' | 'arbitrate' | 'bindings' | 'ticketKeyOfAttempt' | 'onAttention'>>

type ArbitrationDeps = Parameters<typeof createPromptArbitration>[0]

/** The Magos arbiter's main-side dependencies; its attention events go to the wiring's `attention` notifier. */
export interface ArbiterWiring extends Pick<ArbitrationDeps, 'settings' | 'platform' | 'env' | 'arbiterRoot' | 'startArbiter' | 'log'> {
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
  /** The OS notifier for escalated prompts, questions and stalled Magos chats, and the chat record it names. */
  attention: AgentChatAttention
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
function arbitration(arbiter: ArbiterWiring, onAttention: (event: AttentionEvent) => void) {
  const reads = (folder: string | null): ArbiterReads => {
    if (folder === null) throw new Error('A project-less chat has no workspace.')
    return arbiter.arbiterReads(folder)
  }
  return createPromptArbitration({
    settings: arbiter.settings, onAttention, platform: arbiter.platform, env: arbiter.env,
    arbiterRoot: arbiter.arbiterRoot, startArbiter: arbiter.startArbiter, log: arbiter.log,
    allowedRoots: chat => chat.folder === null ? [] : arbiter.allowedRoots(chat.folder),
    // An async body turns a throwing lookup into a rejection, which the gate reads as nulls.
    readContext: async ({ chat, prompt }) => {
      const binding = chat.folder === null ? null
        : arbiter.bindings.threadsOf({ folder: chat.folder, id: chat.id }).find(bound => bound.kind === 'attempt' && bound.threadId === prompt.threadId) ?? null
      return readArbiterContext(reads(chat.folder), { chat, threadId: prompt.threadId, binding })
    }
  })
}

export function wireAgentChats<T extends TerminalOwners>({ terminalsFactory, agentChatsFactory, push, arbiter, attention }: AgentChatWiringOptions<T>): AgentChatWiring<T> {
  sweepArbiterRoot(arbiter.arbiterRoot)
  const onAttention = notifiedAttention(attention)
  const magos = arbitration(arbiter, onAttention)
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
    },
    onAttention
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

/** What the wiring needs to raise an OS notification for an attention event. */
export interface AgentChatAttention {
  /** The OS notifier's `notify` (`notifier.ts`): settings, focus and dedupe are its own. */
  notify(event: NotificationEvent): void
  /** The chat's stored record, for its title and root callsign; null when it is gone. */
  chat(ref: ChatRef): ChatRecord | null
  /** A failed notification, logged by bootstrap; never thrown into the gate or the session. */
  onError(error: unknown): void
}

/** The chat's own name: its title, else its root callsign (`Magos`, `Lexmechanic`), else a generic one. */
function chatName(chat: ChatRecord | null): string {
  const title = chat?.title.trim()
  if (title) return title
  const root = chat === null ? null : rootCallsignOf(chat)
  return root === null ? 'An agent chat' : formatCallsign(root)
}

/**
 * The one attention seam of the Magos gate and the GUI session manager: each event becomes an OS notification that
 * names the chat (a prompt's callsign before the chat's title) and lands on the chat. Only the prompt's title reaches
 * the text, never its detail or tool input; the notifier strips control characters, masks secrets and clips it.
 */
function notifiedAttention(deps: AgentChatAttention): (event: AttentionEvent) => void {
  const translate = (event: AttentionEvent): NotificationEvent => {
    const chat = deps.chat(event.ref)
    if (event.kind === 'run_stalled') {
      const since = Date.now() - event.silentMs
      return {
        kind: 'run_stalled', key: `stall:${event.ref.id}:${since}`, title: `${chatName(chat)} went quiet`, body: 'No output for 5 minutes.',
        target: { kind: 'chat', folder: event.ref.folder, chatId: event.ref.id }
      }
    }
    const { prompt } = event
    const name = prompt.callsign === null ? chatName(chat) : formatCallsign(prompt.callsign)
    return {
      kind: event.kind, key: `prompt:${prompt.id}`, title: `${name} needs you`,
      body: event.kind === 'question' ? `has a question: ${prompt.title}` : `wants to run: ${prompt.title}`,
      target: { kind: 'chat', folder: event.ref.folder, chatId: event.ref.id, ...(prompt.threadId === null ? {} : { threadId: prompt.threadId }), promptId: prompt.id }
    }
  }
  return event => {
    try {
      deps.notify(translate(event))
    } catch (error) {
      try { deps.onError(error) } catch { /* Logging never changes an outcome. */ }
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
