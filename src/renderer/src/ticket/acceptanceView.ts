/**
 * Pure view model for the panel of a sprint acceptance node: its criteria grouped by the ticket each one
 * covers, and the project's Definition of Done with what the node's latest evidence says about each check.
 */
import { workTicketsOf } from '../../../core/plan/acceptance'
import { unmetChecks } from '../../../core/definitionOfDone'
import type { PlanBundle, TicketContent } from '../../../shared/domain/bundle'
import type { AttemptView, DefinitionOfDoneCheck, RepositoryView } from '../../../shared/domain/views'
import { criteriaChecklist, evidenceView, type CriterionItem } from './ticketView'

/** The criteria that cover one ticket; `ticketId` is null for the criteria that cover none (the sprint as a whole). */
export interface CoverageGroup {
  ticketId: string | null
  key: string
  title: string
  /** A required ticket of the sprint that no criterion covers yet. */
  uncovered: boolean
  items: CriterionItem[]
}

interface CoverageView {
  heading: string
  groups: CoverageGroup[]
}

const WHOLE_SPRINT = 'The sprint as a whole'

/** The tickets a criterion list names, in first-appearance order. */
function coveredIds(ticket: TicketContent): string[] {
  const ids = ticket.acceptanceCriteria.flatMap((criterion) => (criterion.covers === undefined ? [] : [criterion.covers]))
  return [...new Set(ids)]
}

/** The sprint's own tickets first (in sprint order; an optional one only when covered), then covered tickets elsewhere. */
function groupOrder(ticket: TicketContent, bundle: PlanBundle): string[] {
  const covered = coveredIds(ticket)
  const sprint = bundle.sprints.find((item) => item.ticketIds.includes(ticket.id))
  const own = sprint === undefined ? [] : workTicketsOf(bundle, sprint.id).filter((item) => !item.optional || covered.includes(item.id))
  const ownIds = own.map((item) => item.id)
  return [...ownIds, ...covered.filter((id) => !ownIds.includes(id))]
}

/**
 * The node's criteria grouped by the ticket each covers: a group for every required work ticket of its sprint (so a
 * ticket nothing covers shows as such), one for every other ticket a criterion names, and last the criteria that
 * cover no ticket. Each criterion carries what the latest evidence says about it.
 */
export function coverageView(ticket: TicketContent, attempts: AttemptView[], bundle: PlanBundle): CoverageView {
  const checklist = criteriaChecklist(ticket, attempts)
  const covers = new Map(ticket.acceptanceCriteria.map((criterion) => [criterion.id, criterion.covers]))
  const tickets = new Map(bundle.tickets.map((item) => [item.id, item]))
  const groups: CoverageGroup[] = groupOrder(ticket, bundle).map((id) => {
    const items = checklist.items.filter((item) => covers.get(item.id) === id)
    const target = tickets.get(id)
    return { ticketId: id, key: target?.key ?? id, title: target?.title ?? '', uncovered: items.length === 0, items }
  })
  const general = checklist.items.filter((item) => covers.get(item.id) === undefined)
  if (general.length > 0) {
    groups.push({ ticketId: null, key: '', title: WHOLE_SPRINT, uncovered: false, items: general })
  }
  return { heading: checklist.heading, groups }
}

/** `null`: the node has no evidence yet, so none of the checks has a status. */
type DefinitionStatus = 'passed' | 'failed' | 'skipped' | 'not reported' | null

export interface DefinitionOfDoneRow extends DefinitionOfDoneCheck {
  status: DefinitionStatus
}

/** Each check of the Definition of Done with how the node's latest evidence reports it (names match like the server's). */
export function definitionOfDoneRows(
  definition: DefinitionOfDoneCheck[],
  ticket: TicketContent,
  attempts: AttemptView[]
): DefinitionOfDoneRow[] {
  const evidence = evidenceView(ticket, attempts)
  if (evidence === null) {
    return definition.map((check) => ({ ...check, status: null }))
  }
  const unmet = new Map(unmetChecks(definition, evidence.checks).map((item) => [item.name, item.reason]))
  return definition.map((check) => ({ ...check, status: unmet.get(check.name) ?? 'passed' }))
}

/** One touched repository's Definition of Done on an acceptance node in a folder of repositories; `rows` empty when it has none. */
export interface RepositoryDefinitionGroup {
  repo: string
  rows: DefinitionOfDoneRow[]
}

/** The repositories the node's sprint's work tickets target, in name order (a folder of repositories only). */
function sprintRepositories(ticket: TicketContent, bundle: PlanBundle): string[] {
  const sprint = bundle.sprints.find((item) => item.ticketIds.includes(ticket.id))
  const repos = sprint === undefined ? [] : workTicketsOf(bundle, sprint.id).flatMap((item) => (item.repo === undefined ? [] : [item.repo]))
  return [...new Set(repos)].sort()
}

/**
 * In a folder of repositories: each repository the node's sprint touches, with its own Definition of Done and how the
 * node's latest evidence reports each check, matched by `<repo>: <check>` like the server. Row names stay the bare check names.
 */
export function repositoryDefinitionGroups(
  repositories: readonly RepositoryView[],
  ticket: TicketContent,
  attempts: AttemptView[],
  bundle: PlanBundle
): RepositoryDefinitionGroup[] {
  const lists = new Map(repositories.map((repository) => [repository.name, repository.definitionOfDone ?? []]))
  return sprintRepositories(ticket, bundle).map((repo) => {
    const checks = lists.get(repo) ?? []
    const named = definitionOfDoneRows(
      checks.map((check) => ({ ...check, name: `${repo}: ${check.name}` })),
      ticket,
      attempts
    )
    return { repo, rows: named.map((row, index) => ({ ...row, name: checks[index].name })) }
  })
}
