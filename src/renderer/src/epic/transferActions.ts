/**
 * The epic workspace's part of a Linear transfer. The person authorizes it (`queueTransfer`) and then either starts
 * an agent on it in a chat or copies its prompt for an agent of their own; both choices queue first, so nothing
 * reaches an agent before the transfer is authorized. While it is open, Resume opens the chat already carrying it
 * out (or starts one), and Cancel transfer withdraws the authorization.
 *
 * A chat that cannot be started (or a prompt that cannot be copied) after the queue succeeded leaves the transfer
 * authorized, as main does: the dialog closes, the banner says why, and the transfer strip that the reload brings
 * offers Resume and Copy prompt to recover. Nothing is queued twice.
 */
import type { StartTransferChatResult } from '../../../shared/agents/chatApi'
import { agentName } from '../agents/agentText'
import type { StartRunChoice, TransferChats } from './orchestration'
import type { Runner } from './runner'
import type { Result } from './workspaceActions'
import type { TransferDialogMode, WorkspaceAction } from './workspaceState'

export interface TransferActionDeps {
  runner: Runner
  epicId: string
  transferChats: TransferChats
  perform<T>(task: () => Promise<T>): Promise<Result<T>>
  dispatch(action: WorkspaceAction): void
  /** A chat was created: the shell fetches the folder's chats again. */
  onChatsChanged(): void
  /** Shows a chat (the shell leaves the epic for it). */
  onOpenChat(chatId: string): void
}

export interface TransferActions {
  /** The dialog's Transfer with agent: queues the transfer (unless resuming), starts the agent on it and opens its chat. */
  transferWithAgent(choice: StartRunChoice, mode: TransferDialogMode): Promise<void>
  /** Copy prompt: queues the transfer (unless resuming) and copies its kickoff for an agent the person starts elsewhere. */
  copyTransferPrompt(mode: TransferDialogMode): Promise<void>
  /** Opens the chat carrying out the open transfer, or the dialog to start one when there is none. */
  resumeTransfer(): Promise<void>
  /** Withdraws the authorization (after the confirmation strip). */
  cancelTransfer(): Promise<void>
}

const COPIED = 'paste it into an agent connected to this folder.'

/** Authorizes a new transfer; resuming one already authorized queues nothing. False when the queue was refused (the banner says why). */
async function authorize(deps: TransferActionDeps, mode: TransferDialogMode): Promise<boolean> {
  if (mode === 'resume') {
    return true
  }
  const queued = await deps.perform(() => deps.runner('queueTransfer', { epicId: deps.epicId }))
  if (!queued.ok) {
    deps.dispatch({ type: 'transfer_dialog', mode: null })
    deps.dispatch({ type: 'banner', text: queued.failure.message })
  }
  return queued.ok
}

/** What starting the transfer chat came to: its chat opens when there is one; otherwise the banner says why, and Resume recovers. */
function chatFeedback(deps: TransferActionDeps, result: Result<StartTransferChatResult>, choice: StartRunChoice): void {
  if (!result.ok) {
    deps.dispatch({ type: 'banner', text: `No transfer chat was started: ${result.failure.message} Press Resume on the transfer to try again.` })
    return
  }
  const { chat, problem } = result.value
  deps.dispatch(problem === null ? { type: 'toast', text: `${agentName(choice.agent)} is carrying out the transfer.` } : { type: 'banner', text: problem })
  if (chat !== null) {
    deps.onChatsChanged()
    deps.onOpenChat(chat.id)
  }
}

export function createTransferActions(deps: TransferActionDeps): TransferActions {
  const closeDialog = (): void => deps.dispatch({ type: 'transfer_dialog', mode: null })
  return {
    async transferWithAgent(choice, mode) {
      if (!(await authorize(deps, mode))) {
        return
      }
      const started = await deps.perform(() => deps.transferChats.start(choice))
      closeDialog()
      chatFeedback(deps, started, choice)
    },
    async copyTransferPrompt(mode) {
      if (!(await authorize(deps, mode))) {
        return
      }
      const copied = await deps.perform(async () => deps.transferChats.copy(await deps.transferChats.prompt()))
      closeDialog()
      const success = mode === 'queue' ? `Transfer authorized. Its prompt is copied: ${COPIED}` : `Transfer prompt copied: ${COPIED}`
      const failure = copied.ok ? '' : `The transfer prompt was not copied: ${copied.failure.message} Press Copy prompt on the transfer to try again.`
      deps.dispatch(copied.ok ? { type: 'toast', text: success } : { type: 'banner', text: failure })
    },
    async resumeTransfer() {
      const found = await deps.perform(() => deps.transferChats.find())
      if (!found.ok) {
        deps.dispatch({ type: 'banner', text: found.failure.message })
      } else if (found.value === null) {
        deps.dispatch({ type: 'transfer_dialog', mode: 'resume' })
      } else {
        deps.onOpenChat(found.value.id)
      }
    },
    async cancelTransfer() {
      deps.dispatch({ type: 'confirm', kind: null })
      const result = await deps.perform(() => deps.runner('cancelTransfer', { epicId: deps.epicId }))
      deps.dispatch(
        result.ok
          ? { type: 'toast', text: 'Transfer canceled. Runs and Save are unlocked; what was created in Linear stays there.' }
          : { type: 'banner', text: result.failure.message }
      )
    }
  }
}
