import type { KanbanCardView } from '../../../shared/domain/kanban'
import type { LearningRecord } from '../../../shared/domain/learnings'
import type { RunView } from '../../../shared/domain/views'

/**
 * Where a learning's provenance link opens. Every target is read from the learning's own source ids and the
 * records they name (the source run, the source card), never from what the window happens to show.
 */
export type SourceTarget =
  | { kind: 'epic'; epicId: string }
  | { kind: 'ticket'; epicId: string; ticketId: string; attemptId: string | null }
  | { kind: 'card'; cardId: string }

/** One provenance row: what it is, the stored id, and where it opens; null when no view shows it (plain id). */
export interface SourceLink {
  name: string
  label: string
  id: string
  target: SourceTarget | null
}

/** The sprint's ordinal as the run knows it, or null when the run records none for that sprint. */
function sprintOrdinal(run: RunView, sprintId: string): number | null {
  if (run.activeSprintId === sprintId) return run.activeSprintOrdinal
  return run.increments.find((increment) => increment.sprintId === sprintId)?.sprintOrdinal ?? null
}

function sprintLabel(run: RunView | null, sprintId: string): string {
  const ordinal = run === null ? null : sprintOrdinal(run, sprintId)
  return ordinal === null ? 'Sprint' : `Sprint ${ordinal}`
}

function cardAttemptLabel(card: KanbanCardView | null, attemptId: string): string {
  const attempt = card?.attempts.find((candidate) => candidate.id === attemptId)
  return attempt === undefined ? 'Card attempt' : `Attempt #${attempt.number}`
}

/**
 * The run, sprint, card and card attempt a learning was published from. `run` is the source run (null when this
 * folder has no such run), `card` the source card (null when it is not on this folder's board): either missing
 * leaves its rows as plain ids.
 */
export function sourceLinks(source: LearningRecord['source'], run: RunView | null, card: KanbanCardView | null): SourceLink[] {
  const epic: SourceTarget | null = run === null ? null : { kind: 'epic', epicId: run.epicId }
  const cardTarget: SourceTarget | null = card === null ? null : { kind: 'card', cardId: card.id }
  return [
    { name: 'Run', label: run === null ? 'Run' : `Run #${run.number}`, id: source.runId, target: epic },
    { name: 'Sprint', label: sprintLabel(run, source.sprintId), id: source.sprintId, target: epic },
    { name: 'Card', label: card === null ? 'Learning card' : `${card.key} ${card.title}`, id: source.cardId, target: cardTarget },
    { name: 'Attempt', label: cardAttemptLabel(card, source.attemptId), id: source.attemptId, target: cardTarget }
  ]
}

function attemptEvidence(run: RunView, attemptId: string): Omit<SourceLink, 'name' | 'id'> | null {
  const attempt = run.attempts.find((candidate) => candidate.id === attemptId)
  if (attempt === undefined) return null
  const key = run.tickets.find((ticket) => ticket.ticketId === attempt.ticketId)?.key ?? 'Ticket'
  return {
    label: `${key} attempt #${attempt.number}`,
    target: { kind: 'ticket', epicId: run.epicId, ticketId: attempt.ticketId, attemptId: attempt.id }
  }
}

function rowCheckEvidence(run: RunView, checkId: string): Omit<SourceLink, 'name' | 'id'> | null {
  const row = run.rows.find((candidate) => candidate.latestCheck?.id === checkId)
  const label = row === undefined ? 'Row check' : `Row ${row.row} check`
  return { label, target: { kind: 'epic', epicId: run.epicId } }
}

/**
 * Where one cited evidence item opens. Its `sourceId` starts with the id of the stored record it was read from (an
 * attempt, a row check or a sprint report of the source run); an attempt opens its ticket's Activity, a row check or
 * report the run's epic. An id the source run does not hold, or no source run, stays a plain id.
 */
export function evidenceLink(sourceId: string, run: RunView | null): Omit<SourceLink, 'name' | 'id'> {
  const head = sourceId.split('/')[0] ?? sourceId
  const plain = { label: sourceId, target: null }
  if (run === null) return plain
  if (head.startsWith('at_')) return attemptEvidence(run, head) ?? plain
  if (head.startsWith('rk_')) return rowCheckEvidence(run, head) ?? plain
  if (head.startsWith('rp_')) return { label: 'Sprint report', target: { kind: 'epic', epicId: run.epicId } }
  return plain
}
