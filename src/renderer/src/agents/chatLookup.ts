/**
 * Finds out what the ids a Dark Mechanicus call (or a bound thread) carries belong to: the display key
 * and the epic of a ticket, so a marker can say "claimed DM-12" and open it. Nothing here guesses.
 * An attempt names its run and ticket through the desktop's `getAttemptTimeline` (or the chat's own
 * binding, which main already resolved), a run names its epic and its tickets' keys through `getRun`,
 * and a ticket that came with no run is looked for in the runs this chat is bound to. What cannot be
 * found stays unknown: the marker then says "a ticket" and does not link.
 *
 * Reads are asked once per id for as long as the lookup lives (a view of one chat); a failed read is
 * not remembered, so the next ask tries again.
 */
import type { ThreadBinding } from '../../../shared/agents/chatApi'
import { runCommand } from '../api/dm'
import type { MarkerTarget } from './actionMarkers'

interface RunInfo {
  epicId: string
  tickets: readonly { ticketId: string; key: string }[]
}

interface AttemptInfo {
  runId: string
  ticketId: string
}

/** What the folder's store can say about a run and an attempt; null when it does not know them. */
interface LookupReads {
  run(runId: string): Promise<RunInfo | null>
  attempt(attemptId: string): Promise<AttemptInfo | null>
}

/** Whether a lookup could learn something: an id is known, and the key or the epic of its ticket is not. */
export function needsLookup(target: MarkerTarget): boolean {
  if (target.ticketId !== null) {
    return target.ticketKey === null || target.epicId === null
  }
  if (target.attemptId !== null) {
    return true
  }
  return target.runId !== null && target.epicId === null
}

/** A read that failed is no answer: the target stays as it was. */
async function settled<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

async function fromAttempt(target: MarkerTarget, reads: LookupReads): Promise<MarkerTarget> {
  const { attemptId } = target
  if (attemptId === null || (target.ticketId !== null && target.runId !== null)) {
    return target
  }
  const attempt = await settled(() => reads.attempt(attemptId))
  return attempt === null ? target : { ...target, runId: target.runId ?? attempt.runId, ticketId: target.ticketId ?? attempt.ticketId }
}

/** What `run` says about the target: its epic, and the key of its ticket when the run has it; null when the run has nothing to say about it. */
function learned(target: MarkerTarget, runId: string, run: RunInfo): MarkerTarget | null {
  const epicId = target.epicId ?? run.epicId
  if (target.ticketId === null) {
    return { ...target, runId, epicId }
  }
  const ticket = run.tickets.find((candidate) => candidate.ticketId === target.ticketId)
  if (ticket !== undefined) {
    return { ...target, runId, epicId, ticketKey: target.ticketKey ?? ticket.key }
  }
  // A run the call named is the authority on its epic even when the ticket is not in it; a run only guessed at is not.
  return target.runId === runId ? { ...target, epicId } : null
}

async function fromRuns(target: MarkerTarget, reads: LookupReads, knownRuns: readonly string[]): Promise<MarkerTarget> {
  for (const runId of target.runId === null ? knownRuns : [target.runId]) {
    const run = await settled(() => reads.run(runId))
    const found = run === null ? null : learned(target, runId, run)
    if (found !== null) {
      return found
    }
  }
  return target
}

/** The target with everything the reads can add to it; the ids and the key it already had are never replaced. */
export async function resolveTarget(target: MarkerTarget, reads: LookupReads, knownRuns: readonly string[]): Promise<MarkerTarget> {
  if (!needsLookup(target)) {
    return target
  }
  return fromRuns(await fromAttempt(target, reads), reads, knownRuns)
}

/** Every run the chat is bound to, or acts on through a bound attempt, once, in the order bound. */
export function knownRunIds(bindings: readonly ThreadBinding[]): string[] {
  const ids = bindings.map((binding) => binding.runId)
  return [...new Set(ids.filter((id): id is string => id !== null))]
}

/** Asks `read` once per id; a rejected read is forgotten so the next ask goes out again. */
function remembering<T>(): (id: string, read: () => Promise<T>) => Promise<T> {
  const answers = new Map<string, Promise<T>>()
  return (id, read) => {
    let answer = answers.get(id)
    if (answer === undefined) {
      answer = read()
      answers.set(id, answer)
      answer.catch(() => answers.delete(id))
    }
    return answer
  }
}

function boundAttempt(bindings: readonly ThreadBinding[], attemptId: string): AttemptInfo | null {
  for (const binding of bindings) {
    if (binding.kind === 'attempt' && binding.attemptId === attemptId && binding.runId !== null && binding.ticketId !== null) {
      return { runId: binding.runId, ticketId: binding.ticketId }
    }
  }
  return null
}

/** Reads of one tracked folder through the desktop's read commands; an attempt the chat is bound to is answered from the binding. */
export function lookupReads(folder: string, bindings: () => readonly ThreadBinding[]): LookupReads {
  const runs = remembering<RunInfo | null>()
  const attempts = remembering<AttemptInfo | null>()
  return {
    run: (runId) =>
      runs(runId, async () => {
        const run = await runCommand(folder, 'getRun', { runId })
        return run === null ? null : { epicId: run.epicId, tickets: run.tickets.map((ticket) => ({ ticketId: ticket.ticketId, key: ticket.key })) }
      }),
    attempt: (attemptId) =>
      attempts(attemptId, async () => {
        const bound = boundAttempt(bindings(), attemptId)
        if (bound !== null) {
          return bound
        }
        const { runId, ticketId } = await runCommand(folder, 'getAttemptTimeline', { attemptId, limit: 1 })
        return { runId, ticketId }
      })
  }
}
