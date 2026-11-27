/**
 * The desktop's side of the cult control channel (`docs/design/cults.md`, sections 1 to 3): one private file per member
 * chat, `cult-control.json` beside its `context-outbox.json` (mode 0600; only main writes the folder), holding the last
 * actions main asked of the member, each with a sequence number. The member's Skitarii extension polls it and applies
 * each new action once (`resources/skitarii/extension/cultControl.ts`): `interrupt` aborts the turn (`ctx.abort()`),
 * `shutdown` closes the session (`ctx.shutdown()`), and every other action is a fixed template the extension ships.
 * Only fixed action codes and validated values are written, never text a peer wrote.
 *
 * The file is stamped with the `epoch` of the member's running launch: its generation, which also names the launch's
 * client descriptor. A watcher applies only a file of its own launch, so a restarted member never re-applies what an
 * earlier launch was told; and the first action for a new launch starts the list afresh.
 */
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CULT_CONTROL_FILE, type CultControlAction, type CultPetition } from '../../../resources/skitarii/extension/cultControl'
import { ompFilePaths } from '../terminals/ompSession'
import { writePrivateFile } from '../terminals/privateFile'

/** What the file keeps, as the extension accepts; a member applies them long before this many pile up. */
const KEPT_ACTIONS = 32

export type CultControlRequest =
  | { action: Exclude<CultControlAction, 'petition'> }
  | { action: 'petition'; petition: CultPetition }

export interface CultControl {
  /** Appends the action to the chat's control file; writes of one chat land in order. */
  send(chatId: string, request: CultControlRequest): Promise<void>
  /** Removes the chat's control file once it has left its run. */
  clear(chatId: string): Promise<void>
}

/** The chat's control file: `userData/agents/omp/<chatId>/cult-control.json`. Throws for a malformed chat id. */
export function cultControlPath(userData: string, chatId: string): string {
  return join(dirname(ompFilePaths(userData, chatId).config), CULT_CONTROL_FILE)
}

interface CultControlOptions {
  userData: string
  /** The generation of the chat's running launch (`TerminalSessions.generationOf`); null while none runs. */
  epochOf: (chatId: string) => string | null
}

interface ChatControl {
  seq: number
  /** The launch the kept actions were written for. */
  epoch: string | null
  actions: ({ seq: number } & CultControlRequest)[]
  /** The last write or removal, which the next one waits for. */
  chain: Promise<void>
}

/** An action for a chat with no running launch is dropped: no session could apply it, and the next launch must not. */
export function createCultControl(options: CultControlOptions): CultControl {
  const chats = new Map<string, ChatControl>()
  const queue = (chatId: string, work: (state: ChatControl) => Promise<void>): Promise<void> => {
    const state = chats.get(chatId) ?? { seq: 0, epoch: null, actions: [], chain: Promise.resolve() }
    chats.set(chatId, state)
    state.chain = state.chain.catch(() => {}).then(() => work(state))
    return state.chain
  }
  return {
    send: (chatId, request) => {
      const path = cultControlPath(options.userData, chatId)
      return queue(chatId, async (state) => {
        const epoch = options.epochOf(chatId)
        if (epoch === null) return
        if (state.epoch !== epoch) state.actions = []
        state.epoch = epoch
        state.seq += 1
        state.actions = [...state.actions, { seq: state.seq, ...request }].slice(-KEPT_ACTIONS)
        await writePrivateFile(path, JSON.stringify({ version: 1, chatId, epoch, actions: state.actions }), 0o600)
      })
    },
    clear: (chatId) => {
      const path = cultControlPath(options.userData, chatId)
      return queue(chatId, async (state) => {
        state.actions = []
        await rm(path, { force: true })
      })
    }
  }
}
