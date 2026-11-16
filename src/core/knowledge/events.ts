/** Workflow events that can pull scoped knowledge into the orchestrator's context. */
export const KNOWLEDGE_EVENTS = [
  { id: 'run.started', description: 'An orchestrator run has started on an epic or board.' },
  { id: 'ticket.claimed', description: 'A ticket attempt was claimed and is about to be worked.' },
  { id: 'acceptance.claimed', description: 'An attempt was claimed for acceptance review.' },
  { id: 'attempt.accepted', description: 'A reviewer accepted a submitted attempt.' },
  { id: 'attempt.rejected', description: 'A reviewer rejected a submitted attempt.' },
  { id: 'attempt.failed', description: 'A worker reported that an attempt failed.' },
  { id: 'row_check.failed', description: 'A row check on a ticket or attempt failed.' },
  { id: 'sprint.reported', description: 'A sprint report was produced at the checkpoint.' },
  { id: 'checkpoint.approved', description: 'A person approved the sprint checkpoint.' },
  { id: 'kanban.claimed', description: 'A Kanban card was claimed for work.' },
  { id: 'run.recovery', description: 'A run is resuming after an interruption or lost lease.' }
] as const

export type KnowledgeEvent = (typeof KNOWLEDGE_EVENTS)[number]['id']

const EVENT_IDS: ReadonlySet<string> = new Set(KNOWLEDGE_EVENTS.map((event) => event.id))

export function isKnowledgeEvent(value: unknown): value is KnowledgeEvent {
  return typeof value === 'string' && EVENT_IDS.has(value)
}
