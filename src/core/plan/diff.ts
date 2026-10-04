import type {
  CapabilityProfile,
  DependencyEdge,
  EpicContent,
  PlanBundle,
  PlanPolicies,
  Relation,
  RelationKind,
  SprintDef,
  TicketContent,
  TicketCriterion
} from '../../shared/domain/bundle'
import type { ChangeKind, PlanChange } from '../../shared/domain/views'
import { canonicalJson } from '../canonical'
import { type BundleIndex, indexBundle, sortedSprints, ticketLabel } from './graph'

type Phrase = string | null

const SEPARATOR = '; '

const RELATION_TEXT: Record<RelationKind, string> = {
  related_to: 'related to',
  duplicate_of: 'duplicate of'
}

function detailOf(phrases: Phrase[]): string {
  return phrases.filter((phrase): phrase is string => phrase !== null).join(SEPARATOR)
}

function changed(before: unknown, after: unknown, phrase: string): Phrase {
  return canonicalJson(before) === canonicalJson(after) ? null : phrase
}

function arrow(label: string, before: string, after: string): Phrase {
  return before === after ? null : `${label} ${before} → ${after}`
}

function lines(count: number): string {
  return `${count} line${count === 1 ? '' : 's'}`
}

/** What makes a criterion differ from its earlier self: its text and the ticket it covers. */
function criterionFingerprint(item: TicketCriterion): string {
  return canonicalJson([item.text, item.covers ?? null])
}

/** Criteria whose text or covered ticket changed or that were added, plus criteria that were removed. */
function changedCriteria(before: TicketCriterion[], after: TicketCriterion[]): number {
  const previous = new Map(before.map((item) => [item.id, criterionFingerprint(item)]))
  const kept = new Set(after.map((item) => item.id))
  const touched = after.filter((item) => previous.get(item.id) !== criterionFingerprint(item)).length
  return touched + before.filter((item) => !kept.has(item.id)).length
}

function criteriaPhrase(label: string, before: TicketCriterion[], after: TicketCriterion[]): Phrase {
  if (canonicalJson(before) === canonicalJson(after)) {
    return null
  }
  const count = changedCriteria(before, after)
  return count === 0 ? `${label} reordered` : `${label} edited (${lines(count)})`
}

interface Collection<T> {
  before: T[]
  after: T[]
  keyOf: (item: T) => string
  added: (item: T) => PlanChange
  removed: (item: T) => PlanChange
  edited: (before: T, after: T) => PlanChange | null
}

/** Items of `after` (added/edited) in their order, then items only in `before` (removed). */
function diffCollection<T>(spec: Collection<T>): PlanChange[] {
  const previous = new Map(spec.before.map((item) => [spec.keyOf(item), item]))
  const kept = new Set(spec.after.map((item) => spec.keyOf(item)))
  const changes: PlanChange[] = []
  for (const item of spec.after) {
    const old = previous.get(spec.keyOf(item))
    const change = old === undefined ? spec.added(item) : spec.edited(old, item)
    if (change) {
      changes.push(change)
    }
  }
  for (const item of spec.before.filter((entry) => !kept.has(spec.keyOf(entry)))) {
    changes.push(spec.removed(item))
  }
  return changes
}

function editedOrNull(detail: string, make: (detail: string) => PlanChange): PlanChange | null {
  return detail === '' ? null : make(detail)
}

function epicPhrases(before: EpicContent, after: EpicContent): Phrase[] {
  return [
    before.title === after.title ? null : `title changed from "${before.title}"`,
    changed(before.intent, after.intent, 'intent edited'),
    criteriaPhrase('success criteria', before.successCriteria, after.successCriteria),
    arrow('owner role', before.ownerRole ?? 'none', after.ownerRole ?? 'none')
  ]
}

function epicChanges(base: PlanBundle | null, next: PlanBundle): PlanChange[] {
  const change = (kind: ChangeKind, detail: string): PlanChange => ({
    kind,
    target: 'epic',
    id: 'epic',
    label: next.epic.title,
    detail
  })
  if (base === null) {
    return [change('added', 'Epic created')]
  }
  const edit = editedOrNull(detailOf(epicPhrases(base.epic, next.epic)), (detail) => change('edited', detail))
  return edit ? [edit] : []
}

function sprintName(sprint: SprintDef | undefined): string {
  return sprint ? `Sprint ${sprint.ordinal}` : 'no sprint'
}

function capText(cap: number | null): string {
  return cap === null ? 'plan default' : String(cap)
}

/** True when tickets present in both versions of a sprint appear in a different relative order. */
function ticketOrderChanged(before: string[], after: string[]): boolean {
  const common = new Set(before.filter((id) => after.includes(id)))
  const afterOrder = after.filter((id) => common.has(id))
  return before.filter((id) => common.has(id)).some((id, position) => id !== afterOrder[position])
}

function sprintPhrases(before: SprintDef, after: SprintDef): Phrase[] {
  return [
    before.ordinal === after.ordinal ? null : `renumbered from Sprint ${before.ordinal}`,
    changed(before.goal, after.goal, 'goal changed'),
    criteriaPhrase('entry criteria', before.entryCriteria, after.entryCriteria),
    criteriaPhrase('exit criteria', before.exitCriteria, after.exitCriteria),
    arrow('concurrency cap', capText(before.concurrencyCap), capText(after.concurrencyCap)),
    arrow('checkpoint mode', before.checkpoint.mode, after.checkpoint.mode),
    ticketOrderChanged(before.ticketIds, after.ticketIds) ? 'ticket order changed' : null
  ]
}

function sprintChanges(base: PlanBundle | null, next: PlanBundle): PlanChange[] {
  const change = (kind: ChangeKind, sprint: SprintDef, detail: string): PlanChange => ({
    kind,
    target: 'sprint',
    id: sprint.id,
    label: sprintName(sprint),
    detail
  })
  return diffCollection<SprintDef>({
    before: base ? sortedSprints(base) : [],
    after: sortedSprints(next),
    keyOf: (sprint) => sprint.id,
    added: (sprint) => change('added', sprint, `${sprintName(sprint)} added`),
    removed: (sprint) => change('removed', sprint, `${sprintName(sprint)} removed`),
    edited: (before, after) =>
      editedOrNull(detailOf(sprintPhrases(before, after)), (detail) => change('edited', after, detail))
  })
}

function ticketName(ticket: TicketContent): string {
  return `${ticket.key} ${ticket.title}`
}

function optionalPhrase(before: TicketContent, after: TicketContent): Phrase {
  if (before.optional === after.optional) {
    return null
  }
  return after.optional ? 'now optional' : 'now required'
}

function effortText(ticket: TicketContent): string {
  return ticket.capability.reasoning.effort ?? 'unset'
}

/** A profile compared without its reasoning effort, which the diff reports on its own. */
function ignoringEffort(capability: CapabilityProfile): CapabilityProfile {
  return { ...capability, reasoning: { ...capability.reasoning, effort: undefined } }
}

function ticketPhrases(before: TicketContent, after: TicketContent): Phrase[] {
  return [
    arrow('key', before.key, after.key),
    before.title === after.title ? null : `title changed from "${before.title}"`,
    arrow('kind', before.kind ?? 'work', after.kind ?? 'work'),
    changed(before.body, after.body, 'body edited'),
    criteriaPhrase('acceptance criteria', before.acceptanceCriteria, after.acceptanceCriteria),
    changed(before.tags, after.tags, 'tags changed'),
    arrow('priority', before.priority, after.priority),
    arrow('size', before.size ?? 'unset', after.size ?? 'unset'),
    arrow('reasoning effort', effortText(before), effortText(after)),
    changed(ignoringEffort(before.capability), ignoringEffort(after.capability), 'capability profile changed'),
    optionalPhrase(before, after),
    changed(before.references, after.references, 'references changed'),
    changed(before.expectedArtifacts, after.expectedArtifacts, 'expected artifacts changed')
  ]
}

function movePhrase(before: SprintDef | undefined, after: SprintDef | undefined): Phrase {
  return before?.id === after?.id ? null : `moved from ${sprintName(before)} to ${sprintName(after)}`
}

interface Sides {
  base: PlanBundle | null
  next: PlanBundle
  /** Index of the base; falls back to `next` when there is no base (nothing is removed then). */
  before: BundleIndex
  after: BundleIndex
}

function ticketChanges(sides: Sides): PlanChange[] {
  const change = (kind: ChangeKind, ticket: TicketContent, detail: string): PlanChange => ({
    kind,
    target: 'ticket',
    id: ticket.id,
    label: ticketName(ticket),
    detail
  })
  return diffCollection<TicketContent>({
    before: sides.base?.tickets ?? [],
    after: sides.next.tickets,
    keyOf: (ticket) => ticket.id,
    added: (ticket) =>
      change('added', ticket, `${ticketName(ticket)} added to ${sprintName(sides.after.sprintOf.get(ticket.id))}`),
    removed: (ticket) =>
      change('removed', ticket, `${ticketName(ticket)} removed from ${sprintName(sides.before.sprintOf.get(ticket.id))}`),
    edited: (before, after) => {
      const move = movePhrase(sides.before.sprintOf.get(before.id), sides.after.sprintOf.get(after.id))
      const detail = detailOf([...ticketPhrases(before, after), move])
      return editedOrNull(detail, (text) => change('edited', after, text))
    }
  })
}

function edgeKey(edge: DependencyEdge): string {
  return `${edge.from}->${edge.to}`
}

function edgeChanges(sides: Sides): PlanChange[] {
  const change = (kind: ChangeKind, edge: DependencyEdge, index: BundleIndex, verb: string): PlanChange => {
    const to = ticketLabel(index, edge.to)
    const from = ticketLabel(index, edge.from)
    return { kind, target: 'edge', id: edgeKey(edge), label: `${to} requires ${from}`, detail: `${to} ${verb} ${from}` }
  }
  return diffCollection<DependencyEdge>({
    before: sides.base?.edges ?? [],
    after: sides.next.edges,
    keyOf: edgeKey,
    added: (edge) => change('added', edge, sides.after, 'now requires'),
    removed: (edge) => change('removed', edge, sides.before, 'no longer requires'),
    edited: () => null
  })
}

function relationKey(relation: Relation): string {
  return `${relation.kind}:${relation.from}->${relation.to}`
}

function relationChanges(sides: Sides): PlanChange[] {
  const change = (kind: ChangeKind, relation: Relation, index: BundleIndex, verb: string): PlanChange => {
    const text = `${RELATION_TEXT[relation.kind]} ${ticketLabel(index, relation.to)}`
    const from = ticketLabel(index, relation.from)
    return { kind, target: 'relation', id: relationKey(relation), label: `${from} ${text}`, detail: `${from} ${verb} ${text}` }
  }
  return diffCollection<Relation>({
    before: sides.base?.relations ?? [],
    after: sides.next.relations,
    keyOf: relationKey,
    added: (relation) => change('added', relation, sides.after, 'marked'),
    removed: (relation) => change('removed', relation, sides.before, 'no longer marked'),
    edited: () => null
  })
}

function policyFields(policies: PlanPolicies): [string, string][] {
  return [
    ['max concurrency', policies.maxConcurrency === null ? 'unlimited' : String(policies.maxConcurrency)],
    ['retry limit', String(policies.retryLimit)],
    ['on ticket failure', policies.onTicketFailure],
    ['lease', `${policies.leaseSeconds}s`]
  ]
}

function policyChanges(base: PlanBundle | null, next: PlanBundle): PlanChange[] {
  const change = (kind: ChangeKind, detail: string): PlanChange => ({
    kind,
    target: 'policies',
    id: 'policies',
    label: 'Policies',
    detail
  })
  const after = policyFields(next.policies)
  if (base === null) {
    return [change('added', after.map(([label, value]) => `${label} ${value}`).join(SEPARATOR))]
  }
  const phrases = policyFields(base.policies).map(([label, value], position) => arrow(label, value, after[position][1]))
  const edit = editedOrNull(detailOf(phrases), (detail) => change('edited', detail))
  return edit ? [edit] : []
}

function rationaleKind(before: string, after: string): ChangeKind {
  if (before === '') {
    return 'added'
  }
  return after === '' ? 'removed' : 'edited'
}

function rationaleChanges(base: PlanBundle | null, next: PlanBundle): PlanChange[] {
  const before = base?.rationale ?? ''
  if (before === next.rationale) {
    return []
  }
  const kind = rationaleKind(before, next.rationale)
  return [{ kind, target: 'rationale', id: 'rationale', label: 'Planning rationale', detail: `Planning rationale ${kind}` }]
}

/**
 * Human-readable differences between a base saved bundle and a draft. With no base, everything
 * is `added`. Order: epic, sprints by ordinal, tickets in bundle order, edges, relations,
 * policies, rationale; within a group, added/edited items in `next` order, then removed items.
 */
export function computeChanges(base: PlanBundle | null, next: PlanBundle): PlanChange[] {
  const after = indexBundle(next)
  const sides: Sides = { base, next, before: base ? indexBundle(base) : after, after }
  return [
    ...epicChanges(base, next),
    ...sprintChanges(base, next),
    ...ticketChanges(sides),
    ...edgeChanges(sides),
    ...relationChanges(sides),
    ...policyChanges(base, next),
    ...rationaleChanges(base, next)
  ]
}
