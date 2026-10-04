import type { DraftOp, TicketInput } from '../../shared/domain/api'
import type { PlanBundle, SprintDef, TicketContent } from '../../shared/domain/bundle'
import { DomainError } from '../errors'
import { acceptanceNodesOf, acceptanceTitle, isAcceptanceTicket } from './acceptance'
import { checkEdgeAddition, indexBundle, ticketLabel, validatePlan } from './graph'
import {
  buildAcceptanceTicket,
  buildSprint,
  buildTicket,
  cloneBundle,
  normalizeCriteria,
  patchSprint,
  patchTicket
} from './normalize'

export interface DraftDeps {
  newId(kind: 'ticket' | 'sprint'): string
  /** Allocates the next ticket display key (e.g. `DM-13`). */
  nextKey(): string
}

export interface DraftOpsResult {
  bundle: PlanBundle
  /** Client-local refs declared in this request mapped to the stable ids they received. */
  refMap: Record<string, string>
}

interface OpState {
  bundle: PlanBundle
  /** A Map, not an object: client refs are untrusted names such as `constructor` or `__proto__`. */
  refMap: Map<string, string>
  deps: DraftDeps
}

type Handler<K extends DraftOp['op']> = (state: OpState, op: Extract<DraftOp, { op: K }>) => void

function reject(message: string, code: 'invalid_input' | 'invalid_graph' | 'not_found' = 'invalid_input'): never {
  throw new DomainError(code, message)
}

function resolveTicket(state: OpState, ref: string): TicketContent {
  const id = state.refMap.get(ref) ?? ref
  const ticket =
    state.bundle.tickets.find((item) => item.id === id) ??
    state.bundle.tickets.find((item) => item.key === ref)
  return ticket ?? reject(`Unknown ticket "${ref}".`, 'not_found')
}

function resolveSprint(state: OpState, ref: string): SprintDef {
  const id = state.refMap.get(ref) ?? ref
  const byOrdinal = /^\d+$/.test(ref) ? Number.parseInt(ref, 10) : -1
  const sprint =
    state.bundle.sprints.find((item) => item.id === id) ??
    state.bundle.sprints.find((item) => item.ordinal === byOrdinal)
  return sprint ?? reject(`Unknown sprint "${ref}".`, 'not_found')
}

function declareRef(state: OpState, ref: string | undefined, id: string): void {
  if (ref === undefined) {
    return
  }
  if (state.refMap.has(ref)) {
    reject(`Client ref "${ref}" is declared twice in one request.`)
  }
  state.refMap.set(ref, id)
}

/**
 * Renumbers the sprints to follow `ordered`. An acceptance node that still has its automatic title
 * (`Sprint N acceptance`) follows its sprint to the new ordinal; a title the planner changed stays.
 */
function renumberSprints(bundle: PlanBundle, ordered: SprintDef[]): void {
  const retitled = new Map<string, string>()
  ordered.forEach((sprint, position) => {
    for (const node of acceptanceNodesOf(bundle, sprint.id)) {
      if (sprint.ordinal !== position + 1 && node.title === acceptanceTitle(sprint.ordinal)) {
        retitled.set(node.id, acceptanceTitle(position + 1))
      }
    }
  })
  bundle.sprints = ordered.map((sprint, position) => ({ ...sprint, ordinal: position + 1 }))
  if (retitled.size > 0) {
    bundle.tickets = bundle.tickets.map((ticket) => {
      const title = retitled.get(ticket.id)
      return title === undefined ? ticket : { ...ticket, title }
    })
  }
}

function orderedSprints(bundle: PlanBundle): SprintDef[] {
  return [...bundle.sprints].sort((a, b) => a.ordinal - b.ordinal)
}

function insertAt<T>(items: T[], item: T, position: number | undefined): T[] {
  const index = position === undefined ? items.length : Math.max(0, Math.min(items.length, position))
  return [...items.slice(0, index), item, ...items.slice(index)]
}

/**
 * Where a ticket goes in a sprint when no position is asked for: the end, but ahead of the sprint's
 * acceptance node, which stays last. An acceptance node itself goes to the end.
 */
function defaultPosition(bundle: PlanBundle, sprint: SprintDef, ticket: TicketContent): number | undefined {
  if (isAcceptanceTicket(ticket)) {
    return undefined
  }
  const nodes = new Set(acceptanceNodesOf(bundle, sprint.id).map((node) => node.id))
  const first = sprint.ticketIds.findIndex((id) => nodes.has(id))
  return first === -1 ? undefined : first
}

/**
 * Resolves the tickets that criteria cover (stable id, key, or client ref) to stable ids, because a
 * saved criterion stores the id. A covers of null passes through; it clears the covers.
 */
function resolveCovers<T extends Partial<TicketInput>>(state: OpState, input: T): T {
  if (input.acceptanceCriteria === undefined) {
    return input
  }
  const acceptanceCriteria = input.acceptanceCriteria.map((item) =>
    typeof item === 'string' || typeof item.covers !== 'string'
      ? item
      : { ...item, covers: resolveTicket(state, item.covers).id }
  )
  return { ...input, acceptanceCriteria }
}

const setEpic: Handler<'set_epic'> = (state, op) => {
  if (op.title !== undefined && op.title.trim() === '') {
    reject('The epic needs a title.')
  }
  const epic = state.bundle.epic
  state.bundle.epic = {
    title: op.title === undefined ? epic.title : op.title.trim(),
    intent: op.intent ?? epic.intent,
    successCriteria:
      op.successCriteria === undefined
        ? epic.successCriteria
        : normalizeCriteria(op.successCriteria, epic.successCriteria, 's'),
    ownerRole: op.ownerRole === undefined ? epic.ownerRole : op.ownerRole
  }
}

const addSprint: Handler<'add_sprint'> = (state, op) => {
  const id = state.deps.newId('sprint')
  declareRef(state, op.ref, id)
  const sprint = buildSprint(op.sprint, { id, ordinal: 0 })
  const position = op.position === undefined ? undefined : op.position - 1
  renumberSprints(state.bundle, insertAt(orderedSprints(state.bundle), sprint, position))
  addAcceptanceNode(state, id)
}

/** Gives a sprint its acceptance node, titled for the ordinal the sprint has now. */
function addAcceptanceNode(state: OpState, sprintId: string): void {
  const sprint = state.bundle.sprints.find((item) => item.id === sprintId)
  if (sprint) {
    const node = buildAcceptanceTicket(sprint, { id: state.deps.newId('ticket'), key: state.deps.nextKey() })
    state.bundle.tickets.push(node)
    sprint.ticketIds.push(node.id)
  }
}

const updateSprint: Handler<'update_sprint'> = (state, op) => {
  const sprint = resolveSprint(state, op.sprint)
  state.bundle.sprints = state.bundle.sprints.map((item) =>
    item.id === sprint.id ? patchSprint(item, op.patch) : item
  )
}

const removeSprint: Handler<'remove_sprint'> = (state, op) => {
  const sprint = resolveSprint(state, op.sprint)
  const nodes = acceptanceNodesOf(state.bundle, sprint.id)
  const remaining = sprint.ticketIds.length - nodes.length
  if (remaining > 0) {
    reject(`Sprint ${sprint.ordinal} still has ${remaining} ticket(s). Move or remove them first.`)
  }
  if (state.bundle.sprints.length === 1) {
    reject('A plan keeps at least one sprint.')
  }
  // A sprint with nothing but its acceptance node is empty: the node goes with it.
  for (const node of nodes) {
    dropTicket(state.bundle, node.id)
  }
  renumberSprints(state.bundle, orderedSprints(state.bundle).filter((item) => item.id !== sprint.id))
}

const addTicket: Handler<'add_ticket'> = (state, op) => {
  const sprint = resolveSprint(state, op.sprint)
  if (op.ticket.title.trim() === '') {
    reject('A ticket needs a title.')
  }
  const id = state.deps.newId('ticket')
  declareRef(state, op.ref, id)
  const ticket = buildTicket(resolveCovers(state, op.ticket), { id, key: state.deps.nextKey() })
  sprint.ticketIds = insertAt(sprint.ticketIds, id, defaultPosition(state.bundle, sprint, ticket))
  state.bundle.tickets.push(ticket)
}

const updateTicket: Handler<'update_ticket'> = (state, op) => {
  const ticket = resolveTicket(state, op.ticket)
  if (op.patch.title !== undefined && op.patch.title.trim() === '') {
    reject(`${ticket.key} needs a title.`)
  }
  const patch = resolveCovers(state, op.patch)
  state.bundle.tickets = state.bundle.tickets.map((item) => (item.id === ticket.id ? patchTicket(item, patch) : item))
}

/** The criterion without its covers: the key is removed, never set to undefined. */
function uncovered(criterion: TicketContent['acceptanceCriteria'][number]): TicketContent['acceptanceCriteria'][number] {
  const next = { ...criterion }
  delete next.covers
  return next
}

/** Removes a ticket, its edges and relations, and the covers of any criterion that named it. */
function dropTicket(bundle: PlanBundle, ticketId: string): void {
  bundle.tickets = bundle.tickets
    .filter((item) => item.id !== ticketId)
    .map((item) =>
      item.acceptanceCriteria.some((criterion) => criterion.covers === ticketId)
        ? {
            ...item,
            acceptanceCriteria: item.acceptanceCriteria.map((criterion) =>
              criterion.covers === ticketId ? uncovered(criterion) : criterion
            )
          }
        : item
    )
  for (const sprint of bundle.sprints) {
    sprint.ticketIds = sprint.ticketIds.filter((id) => id !== ticketId)
  }
  bundle.edges = bundle.edges.filter((edge) => edge.from !== ticketId && edge.to !== ticketId)
  bundle.relations = bundle.relations.filter((rel) => rel.from !== ticketId && rel.to !== ticketId)
}

const removeTicket: Handler<'remove_ticket'> = (state, op) => {
  dropTicket(state.bundle, resolveTicket(state, op.ticket).id)
}

function moveViolation(bundle: PlanBundle, ticketId: string): string | null {
  const index = indexBundle(bundle)
  for (const edge of bundle.edges.filter((item) => item.from === ticketId || item.to === ticketId)) {
    const from = index.sprintOf.get(edge.from)
    const to = index.sprintOf.get(edge.to)
    if (from && to && from.ordinal > to.ordinal) {
      return `${ticketLabel(index, edge.to)} (Sprint ${to.ordinal}) would require ${ticketLabel(index, edge.from)} in later Sprint ${from.ordinal}. A prerequisite must be in the same sprint or an earlier one.`
    }
  }
  return null
}

const moveTicket: Handler<'move_ticket'> = (state, op) => {
  const ticket = resolveTicket(state, op.ticket)
  const target = resolveSprint(state, op.toSprint)
  const current = state.bundle.sprints.find((sprint) => sprint.ticketIds.includes(ticket.id))
  if (isAcceptanceTicket(ticket) && current && current.id !== target.id) {
    reject(
      `${ticket.key} is the acceptance node of Sprint ${current.ordinal} and can't move to another sprint.`,
      'invalid_graph'
    )
  }
  for (const sprint of state.bundle.sprints) {
    sprint.ticketIds = sprint.ticketIds.filter((id) => id !== ticket.id)
  }
  target.ticketIds = insertAt(target.ticketIds, ticket.id, op.position ?? defaultPosition(state.bundle, target, ticket))
  const violation = moveViolation(state.bundle, ticket.id)
  if (violation) {
    reject(`Move rejected. ${violation}`, 'invalid_graph')
  }
}

const addDependency: Handler<'add_dependency'> = (state, op) => {
  const from = resolveTicket(state, op.from)
  const to = resolveTicket(state, op.to)
  const issue = checkEdgeAddition(state.bundle, { from: from.id, to: to.id })
  if (issue) {
    reject(`Dependency not added. ${issue.message}`, 'invalid_graph')
  }
  state.bundle.edges.push({ from: from.id, to: to.id })
}

const removeDependency: Handler<'remove_dependency'> = (state, op) => {
  const from = resolveTicket(state, op.from)
  const to = resolveTicket(state, op.to)
  const before = state.bundle.edges.length
  state.bundle.edges = state.bundle.edges.filter((edge) => !(edge.from === from.id && edge.to === to.id))
  if (state.bundle.edges.length === before) {
    reject(`${to.key} does not require ${from.key}.`, 'not_found')
  }
}

const addRelation: Handler<'add_relation'> = (state, op) => {
  const from = resolveTicket(state, op.from)
  const to = resolveTicket(state, op.to)
  if (from.id === to.id) {
    reject(`${from.key} can't relate to itself.`)
  }
  const exists = state.bundle.relations.some(
    (rel) => rel.kind === op.kind && rel.from === from.id && rel.to === to.id
  )
  if (!exists) {
    state.bundle.relations.push({ kind: op.kind, from: from.id, to: to.id })
  }
}

const removeRelation: Handler<'remove_relation'> = (state, op) => {
  const from = resolveTicket(state, op.from)
  const to = resolveTicket(state, op.to)
  state.bundle.relations = state.bundle.relations.filter(
    (rel) => !(rel.kind === op.kind && rel.from === from.id && rel.to === to.id)
  )
}

const setPolicies: Handler<'set_policies'> = (state, op) => {
  const next = { ...state.bundle, policies: { ...state.bundle.policies, ...op.patch } }
  const invalid = validatePlan(next).errors.find((issue) => issue.code === 'invalid_policy')
  if (invalid) {
    reject(invalid.message)
  }
  state.bundle.policies = next.policies
}

const setRationale: Handler<'set_rationale'> = (state, op) => {
  state.bundle.rationale = op.rationale
}

const HANDLERS: { [K in DraftOp['op']]: Handler<K> } = {
  set_epic: setEpic,
  add_sprint: addSprint,
  update_sprint: updateSprint,
  remove_sprint: removeSprint,
  add_ticket: addTicket,
  update_ticket: updateTicket,
  remove_ticket: removeTicket,
  move_ticket: moveTicket,
  add_dependency: addDependency,
  remove_dependency: removeDependency,
  add_relation: addRelation,
  remove_relation: removeRelation,
  set_policies: setPolicies,
  set_rationale: setRationale
}

function applyOne(state: OpState, op: DraftOp): void {
  // Own properties only: inherited names such as `constructor` are unknown operations too.
  const handler = (Object.hasOwn(HANDLERS, op.op) ? HANDLERS[op.op] : undefined) as
    | Handler<DraftOp['op']>
    | undefined
  if (!handler) {
    reject(`Unknown draft operation "${String((op as { op: unknown }).op)}".`)
  }
  handler(state, op)
}

/**
 * Applies ops in order to a copy of the bundle. All-or-nothing: the first rejected op aborts the
 * whole request with a concrete reason and the op index; nothing is persisted by this function.
 */
export function applyDraftOps(bundle: PlanBundle, ops: DraftOp[], deps: DraftDeps): DraftOpsResult {
  const state: OpState = { bundle: cloneBundle(bundle), refMap: new Map(), deps }
  ops.forEach((op, opIndex) => {
    try {
      applyOne(state, op)
    } catch (error: unknown) {
      if (error instanceof DomainError) {
        throw new DomainError(error.code, error.message, { ...error.details, opIndex, op: op.op })
      }
      throw error
    }
  })
  return { bundle: state.bundle, refMap: Object.fromEntries(state.refMap) }
}
