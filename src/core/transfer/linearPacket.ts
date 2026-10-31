/**
 * Builds the Linear transfer packet of one saved plan revision: the epic as a project, each sprint as a
 * milestone, each ticket as an issue in execution order, and the dependencies as relations. Pure: the
 * caller loads the epic, the saved bundle and the ticket statuses, and an agent writes the packet to Linear.
 */
import type { Criterion, PlanBundle, SprintDef, TicketContent, TicketPriority } from '../../shared/domain/bundle'
import type { WorkStatus } from '../../shared/domain/status'
import {
  LINEAR_TRANSFER_FORMAT,
  LINEAR_TRANSFER_VERSION,
  type LinearIssueItem,
  type LinearMilestoneItem,
  type LinearPriority,
  type LinearProjectItem,
  type LinearRelationItem,
  type LinearTransferPacket
} from '../../shared/domain/transfer'
import { contentHash } from '../canonical'
import { acceptanceNodesOf, implicitPrerequisitesOf, isAcceptanceTicket } from '../plan/acceptance'
import { planRows, prerequisitesOf, sortedSprints } from '../plan/graph'

export interface LinearPacketInput {
  epic: { id: string }
  /** The saved bundle of the revision being transferred. */
  bundle: PlanBundle
  revisionId: string
  revisionNumber: number
  /** DM status by ticket id; a ticket with no entry counts as not completed. */
  ticketStatuses: Readonly<Record<string, WorkStatus>>
}

/** Linear's limit on a project summary. */
export const LINEAR_SUMMARY_MAX = 255

const LINEAR_PRIORITY: Record<TicketPriority, LinearPriority> = {
  critical: 1,
  high: 2,
  normal: 3,
  low: 4
}

function markerOf(epicId: string, ref: string): string {
  return `dm:${epicId}/${ref}`
}

/** Joins the non-blank blocks, each without trailing whitespace, with a blank line between them. */
function paragraphs(blocks: string[]): string {
  return blocks
    .map((block) => block.trimEnd())
    .filter((block) => block.trim() !== '')
    .join('\n\n')
}

function criteriaList(heading: string, criteria: Criterion[]): string {
  if (criteria.length === 0) {
    return ''
  }
  return [heading, ...criteria.map((item) => `- ${item.id} ${item.text}`)].join('\n')
}

function buildProject(input: LinearPacketInput): LinearProjectItem {
  const { bundle, epic, revisionNumber } = input
  const marker = markerOf(epic.id, 'project')
  const lead = `From Dark Mechanicus: epic ${epic.id}, revision ${revisionNumber}`
  // The marker must survive whole; only the lead is cut if the summary would exceed Linear's limit.
  const room = Math.max(0, LINEAR_SUMMARY_MAX - marker.length - 1)
  return {
    ref: 'project',
    marker,
    name: bundle.epic.title,
    summary: `${lead.slice(0, room)}\n${marker}`,
    content: paragraphs([bundle.epic.intent, criteriaList('Success criteria', bundle.epic.successCriteria), marker])
  }
}

function buildMilestone(epicId: string, sprint: SprintDef, position: number): LinearMilestoneItem {
  const marker = markerOf(epicId, sprint.id)
  const goal = (sprint.goal.split('\n').find((line) => line.trim() !== '') ?? '').trim()
  return {
    ref: sprint.id,
    marker,
    position,
    name: goal === '' ? `Sprint ${sprint.ordinal}` : `Sprint ${sprint.ordinal}: ${goal}`,
    description: paragraphs([sprint.goal, criteriaList('Exit criteria', sprint.exitCriteria), marker])
  }
}

/** Each ticket with the sprint it is transferred under, in execution order; a ticket appears once. */
function executionOrder(bundle: PlanBundle): { ticket: TicketContent; sprintId: string }[] {
  const byId = new Map(bundle.tickets.map((ticket) => [ticket.id, ticket]))
  const rows = planRows(bundle)
  const seen = new Set<string>()
  return sortedSprints(bundle).flatMap((sprint) => {
    const work = rows.filter((row) => row.sprintId === sprint.id).flatMap((row) => row.ticketIds)
    const nodes = acceptanceNodesOf(bundle, sprint.id).map((ticket) => ticket.id)
    return [...work, ...nodes].flatMap((id) => {
      const ticket = byId.get(id)
      if (!ticket || seen.has(id)) {
        return []
      }
      seen.add(id)
      return [{ ticket, sprintId: sprint.id }]
    })
  })
}

function checklist(ticket: TicketContent, byId: Map<string, TicketContent>): string {
  if (ticket.acceptanceCriteria.length === 0) {
    return ''
  }
  const items = ticket.acceptanceCriteria.map((item) => {
    const covered = isAcceptanceTicket(ticket) && item.covers ? byId.get(item.covers)?.key : undefined
    return `- [ ] ${item.id}${covered ? ` (${covered})` : ''} ${item.text}`
  })
  return ['Acceptance criteria', ...items].join('\n')
}

function referenceList(ticket: TicketContent, duplicates: string[]): string {
  const lines = [
    ...ticket.references.map(
      (item) => `- ${item.label} (${item.kind}): ${item.location}${item.hash ? ` · ${item.hash}` : ''}`
    ),
    ...duplicates.map((target) => `- Duplicate of ${target}`)
  ]
  return lines.length === 0 ? '' : ['References', ...lines].join('\n')
}

/** The plan relations of one kind that leave `ticketId`, as target ids, skipping unknown and self targets. */
function relationTargets(bundle: PlanBundle, ticketId: string, kind: 'related_to' | 'duplicate_of', known: Set<string>): string[] {
  const targets = bundle.relations
    .filter((item) => item.kind === kind && item.from === ticketId && item.to !== ticketId && known.has(item.to))
    .map((item) => item.to)
  return [...new Set(targets)]
}

/** One issue per ticket, in execution order, each blocked by its edges and its implicit prerequisites. */
function buildIssues(input: LinearPacketInput): LinearIssueItem[] {
  const { bundle, epic, revisionNumber, ticketStatuses } = input
  const ordered = executionOrder(bundle)
  const position = new Map(ordered.map((entry, index) => [entry.ticket.id, index + 1]))
  const byId = new Map(ordered.map((entry) => [entry.ticket.id, entry.ticket]))
  const known = new Set(position.keys())
  return ordered.map(({ ticket, sprintId }, index) => {
    const marker = markerOf(epic.id, ticket.id)
    const blockers = [...prerequisitesOf(bundle, ticket.id), ...implicitPrerequisitesOf(bundle, ticket.id)]
    const duplicates = relationTargets(bundle, ticket.id, 'duplicate_of', known).map(
      (id) => `${byId.get(id)?.key ?? id} (${byId.get(id)?.title ?? id})`
    )
    return {
      ref: ticket.id,
      key: ticket.key,
      marker,
      position: index + 1,
      milestoneRef: sprintId,
      title: ticket.title,
      description: paragraphs([
        ticket.body,
        ticket.optional ? 'Optional: this ticket does not gate its sprint or the epic.' : '',
        checklist(ticket, byId),
        referenceList(ticket, duplicates),
        `DM key ${ticket.key} · epic ${epic.id} · revision ${revisionNumber}`,
        marker
      ]),
      priority: LINEAR_PRIORITY[ticket.priority],
      labels: [...ticket.tags],
      state: ticketStatuses[ticket.id] === 'completed' ? 'completed' : 'default',
      blockedBy: [...new Set(blockers)]
        .filter((id) => id !== ticket.id && known.has(id))
        .sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0))
    }
  })
}

/** Each issue's blocks relations, then the related links it starts, deduplicated, in issue order. */
function buildRelations(bundle: PlanBundle, issues: LinearIssueItem[]): LinearRelationItem[] {
  const known = new Set(issues.map((issue) => issue.ref))
  const relations: LinearRelationItem[] = []
  const relatedPairs = new Set<string>()
  for (const issue of issues) {
    for (const blocker of issue.blockedBy) {
      relations.push({ ref: `rel:${blocker}:${issue.ref}`, kind: 'blocks', blockerRef: blocker, blockedRef: issue.ref })
    }
    for (const target of relationTargets(bundle, issue.ref, 'related_to', known)) {
      // Linear's related link is symmetric, so A related to B and B related to A are one relation.
      const pair = [issue.ref, target].sort().join(':')
      if (!relatedPairs.has(pair)) {
        relatedPairs.add(pair)
        relations.push({ ref: `see:${issue.ref}:${target}`, kind: 'related', fromRef: issue.ref, toRef: target })
      }
    }
  }
  return relations
}

export function buildLinearPacket(input: LinearPacketInput): LinearTransferPacket {
  const issues = buildIssues(input)
  const body: Omit<LinearTransferPacket, 'packetHash'> = {
    format: LINEAR_TRANSFER_FORMAT,
    version: LINEAR_TRANSFER_VERSION,
    epicId: input.epic.id,
    revisionId: input.revisionId,
    project: buildProject(input),
    milestones: sortedSprints(input.bundle).map((sprint, index) => buildMilestone(input.epic.id, sprint, index + 1)),
    issues,
    relations: buildRelations(input.bundle, issues)
  }
  return { ...body, packetHash: contentHash(body) }
}
