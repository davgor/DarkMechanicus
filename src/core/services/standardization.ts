import type { StoredDeliveryPolicy } from '../../shared/domain/deliveryPolicy'
import { promptFor, workflowFor } from './workflowPolicy'
import type { PlanBundle } from '../../shared/domain/bundle'
import type {
  StandardizationItem, StandardizationPatch, StandardizeProjectWorkInput, StandardizeProjectWorkResult
} from '../../shared/domain/standardization'
import { requireCapability } from '../authz'
import type { WorkspaceCore } from '../commands/types'
import { contentHash, prettyJson } from '../canonical'
import { buildEpicStateRecord, buildKanbanCardRecord, MAX_RECORD_BYTES } from '../repo/portable'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { policyForStore } from '../repo/deliveryPolicy'
import { readProject } from '../repo/initialize'
import { notifyStandardsChange } from './standardsNotifications'
import { appendEvent } from './events'
import { enqueueOutbox } from './outbox'
import { recordCardEvent } from './kanban/cards'
import { appliedStandard, encodeStandards, readStandards, workStandards, type AppliedStandard } from './workStandards'

type Inventory = Map<string, StandardizationItem>
type Target = Pick<StandardizationItem, 'kind' | 'id' | 'epicId'>
function key(t: Target): string {
  return JSON.stringify([t.kind, t.epicId ?? '', t.id])
}

interface EpicSource {
  id: string
  title: string
  status: string
  standards_json: string | null
  current_revision_id: string | null
  active_sprint_id: string | null
  run_id: string | null
}

function item(current: Omit<StandardizationItem, 'disposition'>, rule?: AppliedStandard): StandardizationItem {
  return { ...current, disposition: rule?.disposition ?? 'pending', ...(rule && { reason: rule.reason }) }
}

function epicItems(ctx: Ctx, epic: EpicSource, revision: number, result: Inventory): void {
  const completed = epic.status === 'completed'
  const rules = new Map(readStandards(epic.standards_json).filter(r => r.revision === revision && !r.source).map(r => [r.kind + '/' + r.id, r]))
  function add(kind: StandardizationItem['kind'], id: string, title: string, state: { active: boolean; done: boolean }) {
    const { active, done } = state
    const row = item({ kind, id, epicId: epic.id, title, active: active && !done, completed: done }, rules.get(kind + '/' + id))
    result.set(key(row), row)
  }
  add('epic', epic.id, epic.title, { active: epic.status === 'in_progress' || !!epic.run_id, done: completed })
  // The current plan, a pending draft and a live run may all contain distinct items.
  const sources = ctx.db.all<{ bundle_json: string }>(
    `SELECT bundle_json FROM plan_revisions WHERE id = (SELECT revision_id FROM runs WHERE id = ?)
     UNION ALL SELECT bundle_json FROM drafts WHERE epic_id = ?
     UNION ALL SELECT bundle_json FROM plan_revisions WHERE id = ?`, epic.run_id, epic.id, epic.current_revision_id)
  const tickets = new Map(ctx.db.all<{ticket_id: string; status: string}>(
    'SELECT ticket_id, status FROM ticket_status WHERE epic_id = ?', epic.id).map(r => [r.ticket_id, r.status]))
  const attempts = new Map(ctx.db.all<{ticket_id: string; state: string}>(
    'SELECT ticket_id, state FROM attempts WHERE run_id = ? AND superseded_at IS NULL ORDER BY number', epic.run_id).map(r => [r.ticket_id, r.state]))
  const closedSprints = new Set(ctx.db.all<{ sprint_id: string }>(
    'SELECT sprint_id FROM checkpoints WHERE run_id = (SELECT id FROM runs WHERE epic_id = ? ORDER BY number DESC LIMIT 1)', epic.id).map(r => r.sprint_id))
  for (const source of sources) {
    const bundle: PlanBundle = JSON.parse(source.bundle_json)
    for (const s of bundle.sprints) add('sprint', s.id, s.goal, { active: s.id === epic.active_sprint_id, done: completed || closedSprints.has(s.id) })
    for (const t of bundle.tickets) {
      const attempt = attempts.get(t.id)
      const active = tickets.get(t.id) === 'in_progress' || ['claimed', 'running', 'submitted'].includes(attempt ?? '')
      add('ticket', t.id, t.title, { active, done: completed || tickets.get(t.id) === 'completed' || attempt === 'accepted' })
    }
  }
}

function inventory(ctx: Ctx, revision: number): Inventory {
  const all: Inventory = new Map()
  const epics = ctx.db.all<EpicSource>(`SELECT e.id, e.title, e.status, e.standards_json, e.current_revision_id,
    r.id AS run_id, r.active_sprint_id FROM epics e LEFT JOIN runs r ON r.epic_id = e.id
    AND r.state IN ('queued','running','awaiting_checkpoint','paused') ORDER BY e.id`)
  for (const e of epics) epicItems(ctx, e, revision, all)
  const cards = ctx.db.all<{id:string; title:string; lane:string; standards_json:string | null}>('SELECT id,title,lane,standards_json FROM kanban_cards ORDER BY id')
  for (const card of cards) {
    const rule = readStandards(card.standards_json).find(r => r.kind === 'kanban' && r.id === card.id && r.revision === revision && !r.source)
    const row = item({ kind: 'kanban', id: card.id, title: card.title,
      active: card.lane === 'in_progress' || card.lane === 'ready_for_review', completed: card.lane === 'done' }, rule)
    all.set(key(row), row)
  }
  const notices = ctx.db.all<{kind: StandardizationItem['kind']; id: string; epic_id: string | null; routes: string}>(
    `SELECT epic_id, json_extract(payload_json,'$.item.kind') AS kind, json_extract(payload_json,'$.item.id') AS id,
       json_extract(payload_json,'$.notifications') AS routes FROM events
     WHERE kind = 'delivery.requirements_reviewed' AND json_extract(payload_json,'$.item.revision') = ?
       AND json_type(payload_json,'$.notifications') = 'object' ORDER BY seq`, revision)
  for (const notice of notices) {
    const target = all.get(key({kind: notice.kind, id: notice.id, epicId: notice.epic_id ?? undefined}))
    if (target) target.notifications = JSON.parse(notice.routes)
  }
  return all
}

function validatePatch(patch: StandardizationPatch, target: StandardizationItem): void {
  const changed = [patch.requirements, patch.tests, patch.acceptanceCriteria, patch.testCases, patch.deploymentVerification].some(Boolean)
  if (changed !== (patch.disposition === 'updated')) fail('invalid_input', 'Provide requirement changes only for an updated item.')
  if (target.completed && changed) fail('invalid_state', 'Preserve completed evidence. Record the evidence reviewed or flag the missing proof for follow-up.')
  if (patch.testCases && target.kind !== 'ticket' && target.kind !== 'kanban') fail('invalid_input', 'Test cases require a ticket or Kanban card.')
  if (patch.deploymentVerification && target.kind !== 'sprint') fail('invalid_input', 'Deployment verification requires a sprint.')
}

function newRule(patch: StandardizationPatch, stored: StoredDeliveryPolicy, previous?: AppliedStandard): AppliedStandard {
  const { epicId: _epicId, ...update } = patch
  return appliedStandard.parse({ ...previous, ...update, revision: stored.revision, source: undefined,
    prompt: promptFor(stored.policy, patch.kind), workflow: workflowFor(stored.policy, patch.kind) })
}

function apply(ctx: Ctx, row: StandardizationItem, patch: StandardizationPatch, stored: StoredDeliveryPolicy): void {
  const {revision} = stored
  const kanban = row.kind === 'kanban'
  const owner = kanban ? row.id : row.epicId!
  const rules = workStandards(ctx.db, kanban ? 'kanban' : 'epic', owner)
  const index = rules.findIndex(r => r.kind === row.kind && r.id === row.id)
  const previous = rules[index]
  const rule = newRule(patch, stored, previous)
  if (previous?.revision === revision && !previous.source) {
    if (contentHash(previous) !== contentHash(rule)) fail('conflict', 'This item already has a different decision at this standards revision.')
    return
  }
  validatePatch(patch, row)
  if (index < 0) rules.push(rule)
  else rules[index] = rule
  persist(ctx, {owner, kanban, rules})
  recordReview(ctx, { row, rule, revision, patch, kanban, owner })
}

function persist(ctx: Ctx, update: { owner: string; kanban: boolean; rules: AppliedStandard[] }): void {
  const {owner, kanban, rules} = update
  const sql = kanban
    ? 'UPDATE kanban_cards SET standards_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ?'
    : 'UPDATE epics SET standards_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ?'
  ctx.db.run(sql, JSON.stringify(encodeStandards(rules)), ctx.clock.nowIso(), owner)
  if (kanban) {
    const card = ctx.db.get<{key:string; revision:number}>('SELECT key, revision FROM kanban_cards WHERE id = ?', owner)!
    recordCardEvent(ctx, { id: owner, key: card.key }, { kind: 'updated', payload: { revision: card.revision, fields: [] } })
  } else if (ctx.db.get('SELECT id FROM epics WHERE id = ? AND current_revision_id IS NOT NULL', owner)) {
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: owner })
  }
}

function recordReview(ctx: Ctx, update: {row: StandardizationItem; rule: AppliedStandard; revision: number; patch: StandardizationPatch; kanban: boolean; owner: string}): void {
  const {row, rule, kanban, owner} = update
  const run = !kanban && ctx.db.get<{id:string}>("SELECT id FROM runs WHERE epic_id = ? AND state IN ('queued','running','awaiting_checkpoint','paused')", owner)
  if (row.active) row.notifications = notifyStandardsChange(ctx, row, rule, run ? run.id : null)
  appendEvent(ctx, { kind: 'delivery.requirements_reviewed', epicId: row.epicId, runId: run ? run.id : undefined,
    ticketId: row.kind === 'ticket' ? row.id : undefined, payload: { item: rule, active: row.active, notifications: row.notifications } })
}

function verifyPortableSize(ctx: Ctx, items: StandardizationPatch[]): void {
  const owners = new Map(items.map(p => [p.epicId ?? p.id, p.kind === 'kanban']))
  for (const [owner, kanban] of owners) {
    const record = kanban ? buildKanbanCardRecord(ctx.db, owner, { generation: 1 })
      : buildEpicStateRecord(ctx.db, owner, { generation: 1, updatedAt: ctx.clock.nowIso() })
    if (Buffer.byteLength(prettyJson(record), 'utf8') > MAX_RECORD_BYTES) {
      fail('capacity_exceeded', 'Revised requirements exceed the portable work record limit. Shorten the requirements and apply again.')
    }
  }
}

export function standardizeProjectWork(core: WorkspaceCore, input: StandardizeProjectWorkInput): StandardizeProjectWorkResult {
  const ctx = core.ctx()
  requireCapability(ctx.session, 'project.definition_of_done')
  if (input.items?.length) {
    requireCapability(ctx.session, 'plan.save')
    ctx.assertBranch()
  }
  return ctx.db.tx(() => {
    const project = readProject(core.layout, core.fs) ?? fail('not_initialized', 'Initialize the project first.')
    const policy = policyForStore(core.layout, ctx.db, project, core.fs)
    if (!policy || input.expectedRevision !== policy.revision) fail('conflict', 'Reload the saved delivery standards before standardizing work.')
    const rows = inventory(ctx, policy.revision)
    for (const patch of input.items ?? []) {
      const row = rows.get(key(patch)) ?? fail('not_found', 'Work item is outside the selected project or epic.')
      if (row.active && !input.includeInProgress) fail('invalid_state', 'An explicit in-progress override is required for active work.')
      apply(ctx, row, patch, policy)
      row.disposition = patch.disposition
      row.reason = patch.reason
    }
    verifyPortableSize(ctx, input.items ?? [])
    return { revision: policy.revision, items: [...rows.values()] }
  })
}
