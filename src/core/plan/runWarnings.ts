/**
 * Warnings a draft earns while a run is executing the plan, measured against the revision the run is pinned to.
 * A run never goes back: it does not redo a sprint it has passed, and it never runs a sprint inserted before the
 * one it is on. Editing a passed sprint, or inserting a sprint before the active one, therefore changes a plan
 * the run can't carry out. These are warnings, never errors: the person may still mean it. Pure.
 */
import type { PlanBundle, SprintDef, TicketContent } from '../../shared/domain/bundle'
import type { ValidationIssue } from '../../shared/domain/views'
import { contentHash } from '../canonical'
import { acceptanceTitle, isAcceptanceTicket } from './acceptance'
import { sortedSprints } from './graph'

/** What a draft is compared against: the run's pinned plan and where the run is in it. */
interface RunPosition {
  /** The run's number in its epic, for messages. */
  number: number
  activeSprintId: string
  /** The plan revision the run executes. */
  bundle: PlanBundle
}

/** One way a draft differs from the run's plan inside a passed sprint. */
interface Difference {
  text: string
  ticketId?: string
}

function keyOf(draft: PlanBundle, run: PlanBundle, ticketId: string): string {
  const find = (bundle: PlanBundle): string | undefined => bundle.tickets.find((ticket) => ticket.id === ticketId)?.key
  return find(draft) ?? find(run) ?? ticketId
}

function ordinalListing(bundle: PlanBundle, ticketId: string): number {
  return bundle.sprints.find((sprint) => sprint.ticketIds.includes(ticketId))?.ordinal ?? 0
}

/**
 * A ticket's content as the comparison sees it. An acceptance node keeps the title its sprint's number gives it
 * (renumbering a sprint retitles it), so that title is left out: only a title the planner wrote counts.
 */
function fingerprint(bundle: PlanBundle, ticket: TicketContent): string {
  const automatic = isAcceptanceTicket(ticket) && ticket.title === acceptanceTitle(ordinalListing(bundle, ticket.id))
  return contentHash(automatic ? { ...ticket, title: '' } : ticket)
}

function settingsOf(sprint: SprintDef): string {
  const { goal, entryCriteria, exitCriteria, concurrencyCap, checkpoint } = sprint
  return contentHash({ goal, entryCriteria, exitCriteria, concurrencyCap, checkpoint })
}

function prerequisitesOf(bundle: PlanBundle, ticketId: string): string[] {
  return bundle.edges.filter((edge) => edge.to === ticketId).map((edge) => edge.from).sort()
}

function membershipDifferences(draft: PlanBundle, run: PlanBundle, sprint: { run: SprintDef; draft: SprintDef }): Difference[] {
  const key = (ticketId: string): string => keyOf(draft, run, ticketId)
  const inDraft = new Set(draft.tickets.map((ticket) => ticket.id))
  const gone = sprint.run.ticketIds.filter((id) => !sprint.draft.ticketIds.includes(id))
  const added = sprint.draft.ticketIds.filter((id) => !sprint.run.ticketIds.includes(id))
  return [
    ...gone.map((id) => ({ text: `${key(id)} ${inDraft.has(id) ? 'moved out' : 'removed'}`, ticketId: id })),
    ...added.map((id) => ({ text: `${key(id)} added`, ticketId: id }))
  ]
}

function ticketDifferences(draft: PlanBundle, run: PlanBundle, sprint: { run: SprintDef; draft: SprintDef }): Difference[] {
  const kept = sprint.run.ticketIds.filter((id) => sprint.draft.ticketIds.includes(id))
  return kept.flatMap((id): Difference[] => {
    const before = run.tickets.find((ticket) => ticket.id === id)
    const after = draft.tickets.find((ticket) => ticket.id === id)
    const found: Difference[] = []
    if (before !== undefined && after !== undefined && fingerprint(run, before) !== fingerprint(draft, after)) {
      found.push({ text: `${after.key} edited`, ticketId: id })
    }
    if (prerequisitesOf(run, id).join() !== prerequisitesOf(draft, id).join()) {
      found.push({ text: `${keyOf(draft, run, id)} prerequisites changed`, ticketId: id })
    }
    return found
  })
}

function differences(draft: PlanBundle, run: PlanBundle, sprint: { run: SprintDef; draft: SprintDef }): Difference[] {
  const settings: Difference[] = settingsOf(sprint.run) === settingsOf(sprint.draft) ? [] : [{ text: 'sprint settings changed' }]
  return [...membershipDifferences(draft, run, sprint), ...ticketDifferences(draft, run, sprint), ...settings]
}

function passedSprintWarning(draft: PlanBundle, position: RunPosition, sprint: SprintDef): ValidationIssue | null {
  const name = `Sprint ${sprint.ordinal}`
  const tail = `A run does not redo a sprint it has passed (run #${position.number} is past ${name}), and adopting a revision refuses a changed accepted ticket there unless it is carried forward.`
  const counterpart = draft.sprints.find((item) => item.id === sprint.id)
  if (counterpart === undefined) {
    return { code: 'edits_passed_sprint', message: `${name} was removed from the plan. ${tail}`, sprintIds: [sprint.id] }
  }
  const found = differences(draft, position.bundle, { run: sprint, draft: counterpart })
  if (found.length === 0) {
    return null
  }
  const ticketIds = [...new Set(found.flatMap((item) => (item.ticketId === undefined ? [] : [item.ticketId])))]
  return {
    code: 'edits_passed_sprint',
    message: `${name} is changed: ${found.map((item) => item.text).join(', ')}. ${tail}`,
    sprintIds: [sprint.id],
    ...(ticketIds.length === 0 ? {} : { ticketIds })
  }
}

/** A sprint the run's plan did not have, positioned at or before the active sprint: the run never gets to it. */
function insertedWarnings(draft: PlanBundle, position: RunPosition, active: SprintDef): ValidationIssue[] {
  const known = new Set(position.bundle.sprints.map((sprint) => sprint.id))
  const activeOrdinal = draft.sprints.find((sprint) => sprint.id === active.id)?.ordinal ?? active.ordinal
  return sortedSprints(draft)
    .filter((sprint) => !known.has(sprint.id) && sprint.ordinal <= activeOrdinal)
    .map((sprint) => ({
      code: 'sprint_before_active',
      message: `Sprint ${sprint.ordinal} is new and comes before Sprint ${activeOrdinal}, which run #${position.number} is on, so the run will never reach it. Put new work in a sprint after the active one.`,
      sprintIds: [sprint.id]
    }))
}

/**
 * The run-aware warnings for a draft (or a saved revision newer than the run's): one for each passed sprint the
 * draft changes, in sprint order, then one for each sprint inserted before the active one. A draft that leaves the
 * passed sprints alone and adds only after the active sprint has none.
 */
export function runAwareWarnings(draft: PlanBundle, position: RunPosition): ValidationIssue[] {
  const active = position.bundle.sprints.find((sprint) => sprint.id === position.activeSprintId)
  if (active === undefined) {
    return []
  }
  const passed = sortedSprints(position.bundle).filter((sprint) => sprint.ordinal < active.ordinal)
  return [...passed.flatMap((sprint) => passedSprintWarning(draft, position, sprint) ?? []), ...insertedWarnings(draft, position, active)]
}
