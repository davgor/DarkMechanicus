/**
 * What `chats:boundThreads` answers: the chat threads bound to one attempt, one run or one Kanban card
 * (`ActivityBindings.byAttempt`, `byRun` and `byCard`), each as the folder, chat, thread and role that
 * name the thread to open (`chats:open`) and to follow (the push channel). Bindings are kept app-wide, so
 * only the ones of the folder that was asked about are answered: a folder never learns another folder's
 * chats. Nothing about the attempt, run or card itself is passed on, and no claim token is ever kept in a
 * binding.
 */
import type { BoundThread } from '../../shared/agents/chatApi'
import type { ActivityBinding, ActivityBindings } from './activityBindings'

/** What the threads are bound to: an attempt (a worker's thread, and the orchestrator's), a run (its orchestrator) or a Kanban card (the chat Play started). */
export type BoundTarget = { attemptId: string } | { runId: string } | { cardId: string }

function bindingsOf(activity: Pick<ActivityBindings, 'byAttempt' | 'byRun' | 'byCard'>, target: BoundTarget): ActivityBinding[] {
  if ('attemptId' in target) return activity.byAttempt(target.attemptId)
  return 'runId' in target ? activity.byRun(target.runId) : activity.byCard(target.cardId)
}

/** The target's bound threads in the order they were bound, limited to the chats of `folder` (a canonical path). */
export function listBoundThreads(activity: Pick<ActivityBindings, 'byAttempt' | 'byRun' | 'byCard'>, folder: string, target: BoundTarget): BoundThread[] {
  return bindingsOf(activity, target)
    .filter((binding) => binding.folder === folder)
    .map((binding) => ({ folder: binding.folder, chatId: binding.chatId, threadId: binding.threadId, role: binding.role }))
}
