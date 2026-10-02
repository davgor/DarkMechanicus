/**
 * Maps one parsed board epic (`./parse.ts`) to Dark Mechanicus command inputs: the `create_epic`
 * fields, then the `update_plan_draft` ops that fill the one sprint a new epic starts with. Pure, like
 * the parser. Done criteria are left out; each ticket and the epic intent name the board file they
 * came from, so a later import can recognize work it already brought in.
 */
import type { CreateEpicInput, DraftOp, TicketInput } from '../../shared/domain/api'
import type { BoardCriterion, BoardEpic, BoardTicket } from './parse'

interface BoardEpicImport {
  /** `create_epic` input; the caller adds an idempotency key if it wants one. */
  createEpic: CreateEpicInput
  /** `update_plan_draft` ops for the new epic's draft, all in one request (the parser keeps it within the op limit). */
  ops: DraftOp[]
}

/** A new epic's draft starts with one sprint, which ops reach by its ordinal. */
const FIRST_SPRINT = '1'

function openCriteria(criteria: BoardCriterion[]): string[] {
  return criteria.filter((criterion) => !criterion.checked).map((criterion) => criterion.text)
}

function importNote(epic: BoardEpic): string {
  return epic.sourcePath === null
    ? `Imported from /board epic ${epic.boardId}, which has no epic file; each ticket references its own file.`
    : `Imported from the /board file \`${epic.sourcePath}\`.`
}

/** Client-local ref of a board ticket within the import request. */
function refOf(boardId: string): string {
  return `board-${boardId}`
}

function ticketInput(ticket: BoardTicket): TicketInput {
  return {
    title: ticket.title,
    body: ticket.body,
    acceptanceCriteria: openCriteria(ticket.criteria),
    references: [
      { kind: 'file', label: `Board ticket ${ticket.boardId}`, location: ticket.sourcePath, hash: null, remoteOnly: false }
    ]
  }
}

/** Whether `to` can be reached from `from` along prerequisite → dependent edges. */
function reaches(dependents: Map<string, string[]>, from: string, to: string): boolean {
  const stack = [from]
  const seen = new Set<string>()
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (current === to) {
      return true
    }
    if (!seen.has(current)) {
      seen.add(current)
      stack.push(...(dependents.get(current) ?? []))
    }
  }
  return false
}

/** One prerequisite edge per dependency the board states, leaving out any that would close a cycle. */
function dependencyOps(tickets: BoardTicket[]): DraftOp[] {
  const known = new Set(tickets.map((ticket) => ticket.boardId))
  const dependents = new Map<string, string[]>()
  const ops: DraftOp[] = []
  for (const ticket of tickets) {
    for (const prerequisite of ticket.dependsOn) {
      if (known.has(prerequisite) && !reaches(dependents, ticket.boardId, prerequisite)) {
        dependents.set(prerequisite, [...(dependents.get(prerequisite) ?? []), ticket.boardId])
        ops.push({ op: 'add_dependency', from: refOf(prerequisite), to: refOf(ticket.boardId) })
      }
    }
  }
  return ops
}

/** `create_epic` input and `update_plan_draft` ops that bring one board epic into Dark Mechanicus. */
export function boardEpicImport(epic: BoardEpic): BoardEpicImport {
  const tickets = epic.tickets.map(
    (ticket): DraftOp => ({ op: 'add_ticket', ref: refOf(ticket.boardId), sprint: FIRST_SPRINT, ticket: ticketInput(ticket) })
  )
  return {
    createEpic: {
      title: epic.title,
      intent: [epic.body, importNote(epic)].filter((part) => part !== '').join('\n\n'),
      successCriteria: openCriteria(epic.criteria)
    },
    ops: [
      { op: 'update_sprint', sprint: FIRST_SPRINT, patch: { goal: epic.title } },
      ...tickets,
      ...dependencyOps(epic.tickets)
    ]
  }
}
