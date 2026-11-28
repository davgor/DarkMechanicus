import type { PlanBundle } from '../../shared/domain/bundle'
import type { DeliveryPolicy, StoredDeliveryPolicy } from '../../shared/domain/deliveryPolicy'
import { defaultPrompts, effectivePrompts } from '../../shared/domain/standardsPrompts'
import type { Ctx } from '../context'
import { toJson } from '../db/database'
import { enqueueOutbox } from './outbox'
import { type AppliedStandard, encodeStandards, workStandards } from './workStandards'

type Kind = AppliedStandard['kind']
type Item = Pick<AppliedStandard, 'kind' | 'id'>

export function promptFor(policy: DeliveryPolicy, kind: Kind): string {
  return effectivePrompts(policy)[kind === 'kanban' ? 'ticket' : kind]
}

export function workflowFor(policy: DeliveryPolicy, kind: Kind): 'default' | 'custom' {
  return promptFor(policy, kind) === defaultPrompts[kind === 'kanban' ? 'ticket' : kind] ? 'default' : 'custom'
}

function creationRule(config: StoredDeliveryPolicy, item: Item): AppliedStandard {
  return {
    ...item, source: 'creation', revision: config.revision, disposition: 'compliant',
    reason: 'Created under the approved project standards.',
    workflow: workflowFor(config.policy, item.kind), prompt: promptFor(config.policy, item.kind)
  }
}

/** Read the item-specific decision, including its exact prompt when the project later saves another revision. */
export function itemWorkflow(ctx: Ctx, ownerId: string, kind: Kind, id: string): AppliedStandard | undefined {
  return workStandards(ctx.db, kind === 'kanban' ? 'kanban' : 'epic', ownerId)
    .find(rule => rule.kind === kind && rule.id === id)
}

/** The decision a new claim carries. A pin made at creation moves to the current saved revision, so a claim made after
 * a standards save carries that revision and its acceptance checks follow it; an open claim's packet keeps the revision it
 * was issued with. An explicitly standardized decision and an item without a pin are left unchanged. */
export function claimWorkflow(ctx: Ctx, ownerId: string, kind: Kind, id: string): AppliedStandard | undefined {
  const kanban = kind === 'kanban'
  const rules = workStandards(ctx.db, kanban ? 'kanban' : 'epic', ownerId)
  const index = rules.findIndex(rule => rule.kind === kind && rule.id === id)
  const pinned = rules[index]
  const config = ctx.deliveryStandards?.()
  if (pinned?.source !== 'creation' || !config?.policy.prompts || pinned.revision >= config.revision) return pinned
  rules[index] = creationRule(config, { kind, id })
  ctx.db.run(`UPDATE ${kanban ? 'kanban_cards' : 'epics'} SET standards_json = ? WHERE id = ?`, toJson(encodeStandards(rules)), ownerId)
  if (!kanban) enqueueSavedEpicState(ctx, ownerId)
  return rules[index]
}

/** A saved epic's portable record carries its pins, so a changed pin rewrites it. */
function enqueueSavedEpicState(ctx: Ctx, epicId: string): void {
  if (ctx.db.get('SELECT id FROM epics WHERE id = ? AND current_revision_id IS NOT NULL', epicId)) enqueueOutbox(ctx, { kind: 'epic_state', epicId })
}

export function pinCardWorkflow(ctx: Ctx, id: string): void {
  const config = ctx.deliveryStandards?.()
  if (!config?.policy.prompts) return
  ctx.db.run('UPDATE kanban_cards SET standards_json = ? WHERE id = ?', toJson(encodeStandards([creationRule(config, { kind: 'kanban', id })])), id)
}

/** The epic's `standards_json` once a save of `bundle` pins its new items, or undefined when it pins none. Reads only. */
export function plannedWorkflowStandards(ctx: Ctx, epicId: string, bundle: PlanBundle, base?: PlanBundle | null): string | undefined {
  const config = ctx.deliveryStandards?.()
  if (!config?.policy.prompts) return undefined
  const previous = workStandards(ctx.db, 'epic', epicId)
  const existing = new Set(previous.map(rule => rule.kind + '/' + rule.id))
  if (base) {
    existing.add('epic/' + epicId)
    for (const sprint of base.sprints) existing.add('sprint/' + sprint.id)
    for (const ticket of base.tickets) existing.add('ticket/' + ticket.id)
  }
  const items: Item[] = [
    { kind: 'epic', id: epicId }, ...bundle.sprints.map(s => ({ kind: 'sprint' as const, id: s.id })),
    ...bundle.tickets.filter(t => t.kind !== 'acceptance').map(t => ({ kind: 'ticket' as const, id: t.id }))
  ]
  const added = items.filter(item => !existing.has(item.kind + '/' + item.id)).map(item => creationRule(config, item))
  return added.length ? toJson(encodeStandards([...previous, ...added])) : undefined
}

/** Persist new items along with their revision. Established items retain their delivery contract until explicitly standardized. */
export function pinPlanWorkflows(ctx: Ctx, epicId: string, bundle: PlanBundle, base?: PlanBundle | null): void {
  const standards = plannedWorkflowStandards(ctx, epicId, bundle, base)
  if (standards !== undefined) ctx.db.run('UPDATE epics SET standards_json = ? WHERE id = ?', standards, epicId)
}
