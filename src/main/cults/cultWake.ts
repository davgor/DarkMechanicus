/**
 * The standing cult wake, main's side (`docs/design/cults.md`, section 2). Peer mail does not wake an idle cult member
 * by itself; the trusted predicate `cultWakeAllowed` decides, from main's own records only: both endpoints are chats of
 * the folder, both are live members of the same run this app supervises, and the supervisor's `isWakeOpen` says that
 * run is running (not paused, ending or ended). Then the recipient's wake is armed in its private `cult-wake.json`
 * (mode 0600, beside `cult-control.json`; only main writes the folder) with a fresh number and nothing else: the
 * member's extension (`resources/skitarii/extension/cultWake.ts`) takes it once and starts a turn with its own fixed
 * reminder, never with peer text. Each message arms at most once (no retry, no refund).
 *
 * The moment a run leaves `running` (pause, stop, expiry, kill) and at quit, every armed wake of its members is
 * disarmed (`wake: null`), so one not yet taken never fires. Mail itself is never purged or hidden here.
 */
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CULT_WAKE_FILE } from '../../../resources/skitarii/extension/cultWake'
import type { ChatStore } from '../agents/chatStore'
import { ompFilePaths } from '../terminals/ompSession'
import { writePrivateFile } from '../terminals/privateFile'
import type { CultSupervisor } from './cultSupervisor'

export interface CultWakeDeps {
  userData: string
  supervisor: Pick<CultSupervisor, 'memberOf' | 'isWakeOpen' | 'onWakeClose'>
  chats: Pick<ChatStore, 'listChats'>
  /** The generation of the chat's running launch; null while none runs (nothing to wake). */
  epochOf: (chatId: string) => string | null
  onError?: (error: unknown) => void
}

/** A message as the mail sweep sees it: only its id and its sender's endpoint are read, never its body. */
export interface WakeMessage {
  id: string
  from: { endpointId: string }
}

export interface CultWake {
  /** Whether mail from `senderEndpoint` may wake `recipientEndpoint` (both chats of `folder`) without the person. */
  cultWakeAllowed(folder: string, senderEndpoint: string, recipientEndpoint: string): boolean
  /** Arms the recipient's wake once for the first not-yet-offered message the predicate allows. */
  offer(folder: string, recipient: { id: string; endpointId?: string }, messages: readonly WakeMessage[]): Promise<void>
  /** Disarms every armed wake (quit) and stops listening. */
  dispose(): Promise<void>
}

/** The chat's wake file: `userData/agents/omp/<chatId>/cult-wake.json`. Throws for a malformed chat id. */
export function cultWakePath(userData: string, chatId: string): string {
  return join(dirname(ompFilePaths(userData, chatId).config), CULT_WAKE_FILE)
}

interface ChatWake {
  seq: number
  /** Whether the last queued write arms the wake. */
  wanted: boolean
  chain: Promise<void>
}

export function createCultWake(deps: CultWakeDeps): CultWake {
  const wakes = new Map<string, ChatWake>()
  const offered = new Set<string>()
  const onError = deps.onError ?? (() => {})
  const write = (chatId: string, arm: boolean): Promise<void> => {
    const state = wakes.get(chatId) ?? { seq: 0, wanted: false, chain: Promise.resolve() }
    wakes.set(chatId, state)
    // What the last queued write leaves: a disarm also covers an arm queued but not yet written.
    state.wanted = arm
    state.chain = state.chain.catch(() => {}).then(() => publish(deps, chatId, state, arm)).catch(onError)
    return state.chain
  }
  const disarm = (chatIds: Iterable<string>): Promise<void> =>
    Promise.all([...chatIds].filter((id) => wakes.get(id)?.wanted === true).map((id) => write(id, false))).then(() => {})
  // Awaited by the supervisor before it tells or ends a member of a run that left `running`.
  const off = deps.supervisor.onWakeClose((chatIds) => disarm(chatIds))
  return {
    cultWakeAllowed: (folder, sender, recipient) => cultWakeAllowed(deps, folder, sender, recipient),
    offer: async (folder, recipient, messages) => {
      if (recipient.endpointId === undefined) return
      const fresh = messages.filter((message) => !offered.has(`${recipient.id}\0${message.id}`))
      for (const message of fresh) offered.add(`${recipient.id}\0${message.id}`)
      if (fresh.some((message) => cultWakeAllowed(deps, folder, message.from.endpointId, recipient.endpointId!))) await write(recipient.id, true)
    },
    dispose: async () => {
      off()
      await disarm(wakes.keys())
    }
  }
}

function cultWakeAllowed(deps: CultWakeDeps, folder: string, sender: string, recipient: string): boolean {
  if (sender === recipient) return false
  const chats = deps.chats.listChats(folder)
  const runs = [sender, recipient].map((endpoint) => {
    const chat = chats.find((candidate) => candidate.endpointId === endpoint)
    // The chat's own record and the supervisor's live membership must agree on the run.
    const member = chat?.cultRunId === undefined ? null : deps.supervisor.memberOf(chat.id)
    return member !== null && member.run.id === chat?.cultRunId ? member.run.id : null
  })
  return runs[0] !== null && runs[0] === runs[1] && deps.supervisor.isWakeOpen(runs[0])
}

async function publish(deps: CultWakeDeps, chatId: string, state: ChatWake, arm: boolean): Promise<void> {
  const path = cultWakePath(deps.userData, chatId)
  const epoch = deps.epochOf(chatId)
  if (epoch === null) {
    await rm(path, { force: true })
    return
  }
  if (arm) state.seq += 1
  await writePrivateFile(path, JSON.stringify({ version: 1, chatId, epoch, wake: arm ? state.seq : null }), 0o600)
}
