/** Pure view model for the list view: tickets grouped by sprint. */
import type { TicketContent, TicketPriority } from '../../../shared/domain/bundle'
import { WORK_STATUS_LABELS } from '../../../shared/domain/status'
import { badgeResolver, type GraphInput, type TicketBadge } from '../graph/graphModel'

export interface ListRow {
  id: string
  key: string
  title: string
  /** Lifecycle status ("—" for tickets that exist only in the draft). */
  status: string
  badge: TicketBadge
  priority: string
  tags: string[]
  optional: boolean
}

export interface ListSection {
  sprintId: string
  heading: string
  goal: string
  rows: ListRow[]
}

const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  critical: 'Critical'
}

export function listSections(input: GraphInput): ListSection[] {
  const badge = badgeResolver(input)
  const tickets = new Map(input.plan.bundle.tickets.map((item) => [item.id, item]))
  const rowOf = (item: TicketContent): ListRow => {
    const status = input.statuses.get(item.id)
    return {
      id: item.id,
      key: item.key,
      title: item.title,
      status: status ? WORK_STATUS_LABELS[status] : '—',
      badge: badge(item.id),
      priority: PRIORITY_LABELS[item.priority],
      tags: item.tags,
      optional: item.optional
    }
  }
  return [...input.plan.bundle.sprints]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((sprint) => ({
      sprintId: sprint.id,
      heading: `SPRINT ${sprint.ordinal}`,
      goal: sprint.goal.trim() === '' ? 'No goal yet' : sprint.goal,
      rows: sprint.ticketIds.flatMap((id) => {
        const item = tickets.get(id)
        return item ? [rowOf(item)] : []
      })
    }))
}
