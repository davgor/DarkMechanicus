/**
 * The item-based links of chat threads to the Dark Mechanicus runs and attempts they acted on, as chats stored them
 * before they became terminals, app-wide, so main-process code can find the chat and thread behind a run
 * (`byRun`) or an attempt (`byAttempt`) of an old chat. Nothing binds any more: a terminal chat is found by the
 * grant its session used (`grantBindings.ts`). Deleting a chat forgets its bindings (`forgetChat`).
 *
 * A binding names a chat, a thread in it (a `thread` item's id, or null for the chat's main thread), the chat's
 * folder, a run or an attempt, and what the thread was to it: its `orchestrator` or a `worker`.
 *
 * Storage. One JSON line per binding in `file` (`userData/agents/activity-bindings.jsonl`, next to the chat
 * store). Lines that are not valid bindings, that carry a claim token (`<attempt id>.<secret>`), or that repeat an
 * earlier chat, thread and run or attempt are skipped when read; the role first bound stays. Forgetting a deleted
 * chat rewrites the file without its lines.
 */
import { z } from 'zod'
import { chatIdSchema } from '../../shared/agents/chat'
import { nodeChatStoreFs, type ChatRef, type ChatStoreFs } from './chatStore'
import { maskClaimTokens } from './claimTokenMask'

const ID_BODY = '[0-9a-hjkmnp-tv-z]{26}'
const ATTEMPT_ID = new RegExp(`^at_${ID_BODY}$`)
const RUN_ID = new RegExp(`^rn_${ID_BODY}$`)

const bindingBase = {
  chatId: chatIdSchema,
  /** A `thread` item's id; null for the chat's main thread. */
  threadId: z.string().min(1).nullable(),
  /** The chat's canonical folder. */
  folder: z.string().min(1),
  /** What the thread was to the run or attempt. */
  role: z.enum(['orchestrator', 'worker'])
}

const bindingSchema = z.discriminatedUnion('kind', [
  z.object({ ...bindingBase, kind: z.literal('run'), runId: z.string().regex(RUN_ID) }),
  z.object({ ...bindingBase, kind: z.literal('attempt'), attemptId: z.string().regex(ATTEMPT_ID) })
])

export type ActivityBinding = z.infer<typeof bindingSchema>

export interface ActivityBindings {
  /** Every thread bound to the attempt, in the order bound. */
  byAttempt(attemptId: string): ActivityBinding[]
  /** Every thread bound to the run, in the order bound. */
  byRun(runId: string): ActivityBinding[]
  /** Removes every binding of a deleted chat, from memory and from the file. */
  forgetChat(chat: ChatRef): void
}

interface Context {
  file: string
  fs: ChatStoreFs
  /** Every binding in the order bound; null until the file is read. */
  all: ActivityBinding[] | null
}

/** What makes a binding new: its chat, thread and run or attempt. The role is what was first bound. */
function keyOf(binding: ActivityBinding): string {
  const id = binding.kind === 'run' ? binding.runId : binding.attemptId
  return JSON.stringify([binding.chatId, binding.folder, binding.threadId, binding.kind, id])
}

function readLines(fs: ChatStoreFs, path: string): string[] {
  try {
    return fs.readFile(path).split('\n')
  } catch {
    return []
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** A stored line as a binding; null for anything else, and for a line that carries a claim token. */
function bindingOf(line: string): ActivityBinding | null {
  if (line.trim() === '' || maskClaimTokens(line) !== line) {
    return null
  }
  const parsed = bindingSchema.safeParse(parseLine(line))
  return parsed.success ? parsed.data : null
}

function loaded(context: Context): ActivityBinding[] {
  if (context.all !== null) {
    return context.all
  }
  const keys = new Set<string>()
  const all: ActivityBinding[] = []
  for (const binding of readLines(context.fs, context.file).map(bindingOf)) {
    if (binding !== null && !keys.has(keyOf(binding))) {
      keys.add(keyOf(binding))
      all.push(binding)
    }
  }
  context.all = all
  return all
}

function forgetChat(context: Context, chat: ChatRef): void {
  const all = loaded(context)
  const folder = maskClaimTokens(chat.folder)
  const kept = all.filter((binding) => binding.chatId !== chat.id || binding.folder !== folder)
  if (kept.length === all.length) {
    return
  }
  context.fs.replaceFile(context.file, kept.map((binding) => `${JSON.stringify(binding)}\n`).join(''))
  context.all = kept
}

function matching(context: Context, test: (binding: ActivityBinding) => boolean): ActivityBinding[] {
  return loaded(context)
    .filter(test)
    .map((binding) => ({ ...binding }))
}

export function createActivityBindings(options: {
  /** Absolute path of the bindings file (`userData/agents/activity-bindings.jsonl`). */
  file: string
  fs?: ChatStoreFs
}): ActivityBindings {
  const context: Context = { file: options.file, fs: options.fs ?? nodeChatStoreFs, all: null }
  return {
    byAttempt: (attemptId) => matching(context, (binding) => binding.kind === 'attempt' && binding.attemptId === attemptId),
    byRun: (runId) => matching(context, (binding) => binding.kind === 'run' && binding.runId === runId),
    forgetChat: (chat) => {
      forgetChat(context, chat)
    }
  }
}
