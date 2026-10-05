/**
 * What `chats:threadBindings` answers: the bindings of one chat (`ActivityBindings.byChat`) with the
 * epic of each run and the run, epic and ticket (id and display key) of each attempt resolved through
 * reads of the folder's own store. A read that finds nothing or fails leaves its fields null: the
 * binding still names its run or attempt, and the answer never fails over one that could not be read.
 * Each run and attempt is read once per call, however many bindings name it.
 */
import type { ThreadBinding } from '../../shared/agents/chatApi'
import type { ActivityBinding, ActivityBindings } from './activityBindings'
import type { ChatRef } from './chatStore'

interface RunRead {
  epicId: string
  tickets: readonly { ticketId: string; key: string }[]
}

interface AttemptRead {
  runId: string
  ticketId: string
}

/** What a folder's store can say about a run and an attempt; null when it does not know them. */
export interface BindingReads {
  attempt(folder: string, attemptId: string): Promise<AttemptRead | null>
  run(folder: string, runId: string): Promise<RunRead | null>
}

interface ThreadBindingDeps {
  activity: Pick<ActivityBindings, 'byChat'>
  reads: BindingReads
}

/** Reads of one folder that remember what they found, so a run named by several bindings is read once. */
interface Reader {
  attempt(attemptId: string): Promise<AttemptRead | null>
  run(runId: string): Promise<RunRead | null>
}

/** Runs a read and keeps its answer, or null when it failed: a binding is shown with less rather than not at all. */
async function settled<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

function remembered<T>(cache: Map<string, Promise<T | null>>, id: string, read: () => Promise<T | null>): Promise<T | null> {
  let answer = cache.get(id)
  if (answer === undefined) {
    answer = settled(read)
    cache.set(id, answer)
  }
  return answer
}

function readerFor(reads: BindingReads, folder: string): Reader {
  const attempts = new Map<string, Promise<AttemptRead | null>>()
  const runs = new Map<string, Promise<RunRead | null>>()
  return {
    attempt: (attemptId) => remembered(attempts, attemptId, () => reads.attempt(folder, attemptId)),
    run: (runId) => remembered(runs, runId, () => reads.run(folder, runId))
  }
}

type AttemptBinding = Extract<ThreadBinding, { kind: 'attempt' }>

async function resolveAttempt(reader: Reader, binding: Extract<ActivityBinding, { kind: 'attempt' }>): Promise<AttemptBinding> {
  const base = { threadId: binding.threadId, role: binding.role, kind: 'attempt' as const, attemptId: binding.attemptId }
  const attempt = await reader.attempt(binding.attemptId)
  if (attempt === null) {
    return { ...base, runId: null, epicId: null, ticketId: null, ticketKey: null }
  }
  const run = await reader.run(attempt.runId)
  const ticket = run?.tickets.find((candidate) => candidate.ticketId === attempt.ticketId)
  return { ...base, runId: attempt.runId, epicId: run?.epicId ?? null, ticketId: attempt.ticketId, ticketKey: ticket?.key ?? null }
}

async function resolve(reader: Reader, binding: ActivityBinding): Promise<ThreadBinding> {
  if (binding.kind === 'attempt') {
    return resolveAttempt(reader, binding)
  }
  const run = await reader.run(binding.runId)
  return { threadId: binding.threadId, role: binding.role, kind: 'run', runId: binding.runId, epicId: run?.epicId ?? null }
}

/** The chat's bindings in the order they were bound, resolved as far as the folder's store allows. */
export function listThreadBindings(deps: ThreadBindingDeps, chat: ChatRef): Promise<ThreadBinding[]> {
  const reader = readerFor(deps.reads, chat.folder)
  return Promise.all(deps.activity.byChat(chat).map((binding) => resolve(reader, binding)))
}
