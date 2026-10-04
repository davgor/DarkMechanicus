/**
 * Pure plan-graph model: derives node positions and labels from a plan bundle (layout is never
 * stored), overlaying run execution state in the Saved view or draft change state in the Draft
 * view. Sprints stack top to bottom; inside a sprint, rows are the dependency rows of
 * `core/plan/graph` (a row wider than six columns wraps onto more than one visual row) and columns
 * follow the barycenter of each ticket's prerequisites to reduce crossings. A sprint's acceptance
 * node is no dependency row: it closes the band in a row of its own, joined to the band by one
 * bracket in the gutter left of the cards instead of an edge per ticket. In the Saved view of a
 * run, each dependency row carries its latest row check right of its cards.
 */
import type { ChangeKind, CriterionResult, PlanView, RowView, RunView, TicketExecutionView } from '../../../shared/domain/views'
import type { DependencyEdge, PlanBundle, ReasoningEffort, SprintDef, TicketContent, TicketSize } from '../../../shared/domain/bundle'
import { isActiveRunState, type WorkStatus } from '../../../shared/domain/status'
import { implicitPrerequisitesOf, isAcceptanceTicket } from '../../../core/plan/acceptance'
import { groupIntoRows } from '../../../core/plan/graph'
import { sprintLabelSize, type SprintLabelSize } from './sprintLabel'
import { DASHED_EXECUTION, EXECUTION_LABELS, EXECUTION_TONES, STATUS_LABELS, STATUS_TONES, type Tone } from './ticketStates'

const CARD_WIDTH = 210
const CARD_HEIGHT = 72
const COLUMN_PITCH = 250
const COLUMN_GAP = 40
const ROW_PITCH = 112
const ROW_GAP = 40
const FIRST_COLUMN_X = 185
const LABEL_X = 24
const LABEL_WIDTH = 140
const EPIC_TOP = 24
const EPIC_WIDTH = 440
const EPIC_HEIGHT = 64
const FIRST_BAND_TOP = 128
const BAND_GAP = 52
/** The sprint label starts this far below the top of its band. */
const LABEL_OFFSET_Y = 4
/** Breathing room kept between the bottom of a sprint label and the checkpoint pill under it. */
const LABEL_CLEARANCE = 4
/**
 * The join from a band to its acceptance node lives in the gutter between the sprint label
 * (LABEL_X + LABEL_WIDTH = 164) and the first column, so it never touches the label.
 */
const JOIN_WIDTH = 14
/** A row check chip: `.pg-rowcheck` fills the node; it sits this far right of its sprint's widest row. */
const ROW_CHECK_WIDTH = 104
const ROW_CHECK_HEIGHT = 34
const ROW_CHECK_GAP = 16
const DIVIDER_X = 16
const DIVIDER_HEIGHT = 28
const RIGHT_MARGIN = 24
/** Empty lane right of the cards where the legend floats (dividers run underneath it). */
const LEGEND_LANE = 240
const MAX_COLUMNS = 6
const MIN_COLUMNS = 3

export interface GraphInput {
  plan: PlanView
  mode: 'saved' | 'draft'
  /** Execution overlay; only used in the Saved view. */
  run: RunView | null
  /** Lifecycle statuses, used in the Saved view when there is no run. */
  statuses: ReadonlyMap<string, WorkStatus | null>
  /** Epic success-criterion results (recorded outcome or final report). */
  outcome: CriterionResult[] | null
  /** The last rejected dependency edit, annotated on both tickets. */
  rejected: { from: string; to: string } | null
  /** Revision number the draft becomes when saved. */
  draftNumber: number
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

type DividerTone = 'passed' | 'locked' | 'awaiting' | 'neutral'

export interface EpicNodeModel extends Box {
  kind: 'epic'
  id: string
  eyebrow: string
  title: string
}

export interface SprintNodeModel extends Box {
  kind: 'sprint'
  id: string
  sprintId: string
  heading: string
  goal: string
  detail: string
  active: boolean
  /** Lines the goal is clamped to (the rest is cut with an ellipsis); the layout reserves exactly these. */
  goalLines: number
  /** Height the layout reserved for the label, heading to detail (and the + Ticket / + Acceptance buttons while editing). */
  labelHeight: number
  /** The sprint lists an acceptance node; without one the draft view offers + Acceptance. */
  hasAcceptance: boolean
}

export interface DividerNodeModel extends Box {
  kind: 'divider'
  id: string
  label: string
  tone: DividerTone
}

export interface TicketNodeModel extends Box {
  kind: 'ticket'
  id: string
  sprintId: string
  ticketKey: string
  title: string
  label: string
  tone: Tone
  dashed: boolean
  /** A rejected dependency edit's annotation (never the size, which has its own field). */
  note: string | null
  /** The ticket's size for the card badge; null when the ticket has none. */
  size: TicketSize | null
  /** The ticket's own reasoning effort, for the card badge beside the size; null when the ticket sets none. */
  effort: ReasoningEffort | null
  /** A sprint's acceptance node, drawn apart from work tickets. */
  acceptance: boolean
  /** Semantic work state for the mascot, independent of badge tone and selection. */
  inProgress: boolean
}

/** The one bracket from a sprint's work rows to its acceptance node (instead of an edge per ticket). */
export interface JoinNodeModel extends Box {
  kind: 'join'
  id: string
  sprintId: string
  /** Solid when every ticket the node requires is accepted (or there is no execution overlay), dashed while waiting. */
  met: boolean
  /** Accessible name: what the node requires. */
  label: string
}

export type RowCheckState = 'passed' | 'failed' | 'none'

/** A dependency row's latest check (Saved view of a run), at the row. */
export interface RowCheckNodeModel extends Box {
  kind: 'rowcheck'
  id: string
  sprintId: string
  /** The row's number within its sprint, counted from 1. */
  row: number
  state: RowCheckState
  label: string
  /** The words that go with the color: PASSED, FAILED (any entry failed or was skipped) or NO CHECK. */
  status: string
  tone: Tone
  /** The tooltip: the check's number, commit and the entries that did not pass. */
  detail: string
}

export type GraphNode =
  | EpicNodeModel
  | SprintNodeModel
  | DividerNodeModel
  | TicketNodeModel
  | JoinNodeModel
  | RowCheckNodeModel

interface GraphEdge {
  id: string
  from: string
  to: string
  /** Solid when the prerequisite is accepted (or there is no execution overlay). */
  met: boolean
}

/** Vertical drop zone of a sprint, bounded by the checkpoint dividers around it. */
interface SprintBand {
  sprintId: string
  top: number
  bottom: number
}

export interface GraphModel {
  nodes: GraphNode[]
  edges: GraphEdge[]
  bands: SprintBand[]
}

export interface TicketBadge {
  label: string
  tone: Tone
  dashed: boolean
}

interface Context {
  input: GraphInput
  bundle: PlanBundle
  /** The run, only in the Saved view. */
  run: RunView | null
  execution: ReadonlyMap<string, TicketExecutionView> | null
  changes: ReadonlyMap<string, ChangeKind>
  tickets: ReadonlyMap<string, TicketContent>
}

interface Placement {
  column: number
  row: number
}

interface SprintPlan {
  sprint: SprintDef
  /** Visual rows, the acceptance node's included. */
  rows: number
  /** Visual rows before the acceptance node's row. */
  workRows: number
  placements: Map<string, Placement>
  /** The acceptance nodes placed, in sprint order (a valid plan has one). */
  acceptance: string[]
  /** Each dependency row (counted from 1) and the visual row it starts on. */
  depRows: { row: number; visual: number }[]
}

interface Frame {
  plan: SprintPlan
  label: SprintLabelSize
  top: number
  bottom: number
}

interface LayoutContext {
  edges: DependencyEdge[]
  prerequisites: Map<string, string[]>
  columnOf: Map<string, number>
  /** Ids of the acceptance nodes of the plan; they close their sprint instead of joining a dependency row. */
  acceptance: ReadonlySet<string>
}

function createContext(input: GraphInput): Context {
  const run = input.mode === 'saved' ? input.run : null
  const ticketChanges = input.plan.changes.filter((change) => change.target === 'ticket')
  return {
    input,
    bundle: input.plan.bundle,
    run,
    execution: run ? new Map(run.tickets.map((item) => [item.ticketId, item])) : null,
    changes: new Map(ticketChanges.map((change) => [change.id, change.kind])),
    tickets: new Map(input.plan.bundle.tickets.map((item) => [item.id, item]))
  }
}

// ---------------------------------------------------------------------------------------------
// Ticket badges

function draftBadge(context: Context, ticketId: string): TicketBadge {
  const change = context.changes.get(ticketId)
  if (change === 'added') {
    return { label: `NEW IN REV ${context.input.draftNumber}`, tone: 'new', dashed: true }
  }
  return change === 'edited'
    ? { label: 'EDITED', tone: 'edited', dashed: false }
    : { label: 'DRAFT', tone: 'neutral', dashed: false }
}

function savedBadge(context: Context, ticketId: string): TicketBadge {
  if (context.execution === null) {
    const status = context.input.statuses.get(ticketId) ?? 'backlog'
    return { label: STATUS_LABELS[status], tone: STATUS_TONES[status], dashed: false }
  }
  const view = context.execution.get(ticketId)
  if (!view) {
    return { label: 'NOT IN RUN', tone: 'neutral', dashed: true }
  }
  const attempt = view.state === 'running' && view.attemptCount > 1 ? ` · ATTEMPT ${view.attemptCount}` : ''
  return {
    label: `${EXECUTION_LABELS[view.state]}${attempt}`,
    tone: EXECUTION_TONES[view.state],
    dashed: DASHED_EXECUTION[view.state]
  }
}

function isRejected(context: Context, ticketId: string): boolean {
  const rejected = context.input.rejected
  return rejected !== null && (rejected.from === ticketId || rejected.to === ticketId)
}

function resolveBadge(context: Context, ticketId: string): TicketBadge {
  const base = context.input.mode === 'draft' ? draftBadge(context, ticketId) : savedBadge(context, ticketId)
  return isRejected(context, ticketId) ? { ...base, tone: 'rejected' } : base
}

/** Badge lookup shared by the graph cards and the list view. */
export function badgeResolver(input: GraphInput): (ticketId: string) => TicketBadge {
  const context = createContext(input)
  return (ticketId) => resolveBadge(context, ticketId)
}

function keyOf(context: Context, ticketId: string): string {
  return context.tickets.get(ticketId)?.key ?? ticketId
}

function noteFor(context: Context, ticketId: string): string | null {
  const rejected = context.input.rejected
  if (rejected === null) {
    return null
  }
  if (rejected.to === ticketId) {
    return `Rejected: would require ${keyOf(context, rejected.from)}`
  }
  return rejected.from === ticketId ? `Rejected as prerequisite of ${keyOf(context, rejected.to)}` : null
}

// ---------------------------------------------------------------------------------------------
// Layout

function sortedSprints(bundle: PlanBundle): SprintDef[] {
  return [...bundle.sprints].sort((a, b) => a.ordinal - b.ordinal)
}

function prerequisiteMap(edges: DependencyEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const item of edges) {
    map.set(item.to, [...(map.get(item.to) ?? []), item.from])
  }
  return map
}

function barycenter(id: string, layout: LayoutContext): number | null {
  const columns = (layout.prerequisites.get(id) ?? [])
    .map((prerequisite) => layout.columnOf.get(prerequisite))
    .filter((column): column is number => column !== undefined)
  return columns.length === 0 ? null : columns.reduce((sum, column) => sum + column, 0) / columns.length
}

function orderByBarycenter(ids: string[], layout: LayoutContext): string[] {
  return ids
    .map((id, index) => ({ id, key: barycenter(id, layout) ?? index }))
    .sort((a, b) => a.key - b.key)
    .map((item) => item.id)
}

function chunks(items: string[], size: number): string[][] {
  const out: string[][] = []
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size))
  }
  return out
}

/** Keeps order, prefers the column under the prerequisites, and never overflows the row. */
function assignColumns(chunk: string[], layout: LayoutContext): Map<string, number> {
  const preferred = chunk.map((id) => barycenter(id, layout))
  const columns = new Map<string, number>()
  let previous = -1
  chunk.forEach((id, index) => {
    const remaining = chunk.length - index - 1
    const wanted = Math.floor(preferred[index] ?? 0)
    const column = Math.min(Math.max(previous + 1, wanted), MAX_COLUMNS - 1 - remaining)
    columns.set(id, column)
    previous = column
  })
  return columns
}

/** Places one dependency row from `row` on (wrapping after six columns); returns the next free visual row. */
function placeLevel(level: string[], row: number, placements: Map<string, Placement>, layout: LayoutContext): number {
  let next = row
  for (const chunk of chunks(orderByBarycenter(level, layout), MAX_COLUMNS)) {
    const assigned = assignColumns(chunk, layout)
    const current = next
    assigned.forEach((column, id) => {
      placements.set(id, { column, row: current })
      layout.columnOf.set(id, column)
    })
    next += 1
  }
  return next
}

function placeSprint(sprint: SprintDef, ids: string[], layout: LayoutContext): SprintPlan {
  const placements = new Map<string, Placement>()
  const acceptance = ids.filter((id) => layout.acceptance.has(id))
  const depRows: SprintPlan['depRows'] = []
  let row = 0
  groupIntoRows(
    ids.filter((id) => !layout.acceptance.has(id)),
    layout.edges
  ).forEach((level, index) => {
    depRows.push({ row: index + 1, visual: row })
    row = placeLevel(level, row, placements, layout)
  })
  const workRows = row
  for (const chunk of chunks(acceptance, MAX_COLUMNS)) {
    chunk.forEach((id, column) => {
      placements.set(id, { column, row })
      layout.columnOf.set(id, column)
    })
    row += 1
  }
  return { sprint, rows: Math.max(1, row), workRows, placements, acceptance, depRows }
}

function layoutSprints(bundle: PlanBundle): SprintPlan[] {
  const known = new Set(bundle.tickets.map((item) => item.id))
  const seen = new Set<string>()
  const layout: LayoutContext = {
    edges: bundle.edges,
    prerequisites: prerequisiteMap(bundle.edges),
    columnOf: new Map(),
    acceptance: new Set(bundle.tickets.filter(isAcceptanceTicket).map((item) => item.id))
  }
  return sortedSprints(bundle).map((sprint) => {
    const ids = sprint.ticketIds.filter((id) => known.has(id) && !seen.has(id))
    ids.forEach((id) => seen.add(id))
    return placeSprint(sprint, ids, layout)
  })
}

/** How far a label may hang below its band's cards before it would touch the checkpoint pill. */
const LABEL_HANG = BAND_GAP - DIVIDER_HEIGHT / 2 - LABEL_CLEARANCE

/** Bands are as tall as their card rows, or taller when the sprint label needs the room. */
function bandHeight(plan: SprintPlan, label: SprintLabelSize): number {
  return Math.max(plan.rows * ROW_PITCH - ROW_GAP, LABEL_OFFSET_Y + label.height - LABEL_HANG)
}

function toFrames(plans: SprintPlan[], context: Context): Frame[] {
  let top = FIRST_BAND_TOP
  return plans.map((plan) => {
    const label = labelSize(plan, context)
    const bottom = top + bandHeight(plan, label)
    const frame = { plan, label, top, bottom }
    top = bottom + BAND_GAP + BAND_GAP
    return frame
  })
}

function contentWidth(plans: SprintPlan[]): number {
  const widest = Math.max(0, ...plans.flatMap((plan) => [...plan.placements.values()].map((item) => item.column + 1)))
  return Math.max(MIN_COLUMNS, widest) * COLUMN_PITCH - COLUMN_GAP
}

// ---------------------------------------------------------------------------------------------
// Labels

function plural(count: number, word: string): string {
  return count === 1 ? `1 ${word}` : `${count} ${word}S`
}

function countTickets(count: number): string {
  return count === 1 ? '1 ticket' : `${count} tickets`
}

function acceptedIn(sprint: SprintDef, context: Context): number {
  return sprint.ticketIds.filter((id) => context.execution?.get(id)?.state === 'accepted').length
}

function activeOrdinal(context: Context): number | null {
  return context.run?.activeSprintOrdinal ?? null
}

function runSprintDetail(sprint: SprintDef, run: RunView, context: Context): string {
  const active = run.activeSprintOrdinal ?? 0
  const accepted = `${acceptedIn(sprint, context)} of ${sprint.ticketIds.length} accepted`
  if (run.state === 'completed' || sprint.ordinal < active) {
    return accepted
  }
  if (sprint.ordinal > active) {
    return `Waiting on checkpoint ${sprint.ordinal - 1}`
  }
  return run.state === 'awaiting_checkpoint' ? 'Awaiting checkpoint' : `Active · ${accepted}`
}

function sprintDetail(sprint: SprintDef, context: Context): string {
  const total = countTickets(sprint.ticketIds.length)
  if (context.input.mode === 'draft') {
    const added = sprint.ticketIds.filter((id) => context.changes.get(id) === 'added').length
    return added > 0 ? `${total} · ${added} new` : total
  }
  return context.run === null || activeOrdinal(context) === null ? total : runSprintDetail(sprint, context.run, context)
}

function sprintGoal(sprint: SprintDef): string {
  return sprint.goal.trim() === '' ? 'No goal yet' : sprint.goal
}

/** The draft canvas also shows + Ticket, and + Acceptance while the sprint has no node, under the label, so it reserves room for them. */
function labelSize(plan: SprintPlan, context: Context): SprintLabelSize {
  const buttons = context.input.mode === 'draft' ? (plan.acceptance.length > 0 ? 1 : 2) : 0
  return sprintLabelSize(sprintGoal(plan.sprint), sprintDetail(plan.sprint, context), buttons)
}

const POLICY_LABELS = { human: 'HUMAN APPROVAL', auto: 'AUTO CONTINUE' } as const

function checkpointLabel(sprint: SprintDef, context: Context): { label: string; tone: DividerTone } {
  const base = `CHECKPOINT ${sprint.ordinal}`
  const run = context.run
  const active = activeOrdinal(context)
  if (run === null || active === null) {
    return { label: `${base} · ${POLICY_LABELS[sprint.checkpoint.mode]}`, tone: 'neutral' }
  }
  if (run.state === 'completed' || sprint.ordinal < active) {
    return { label: `${base} · PASSED`, tone: 'passed' }
  }
  if (sprint.ordinal > active) {
    return { label: `${base} · LOCKED`, tone: 'neutral' }
  }
  if (run.state === 'awaiting_checkpoint') {
    return { label: `${base} · AWAITING APPROVAL`, tone: 'awaiting' }
  }
  return { label: `${base} · LOCKED · ${acceptedIn(sprint, context)} OF ${sprint.ticketIds.length} ACCEPTED`, tone: 'locked' }
}

function checksLabel(context: Context): { label: string; tone: DividerTone } {
  const criteria = context.bundle.epic.successCriteria
  if (context.input.mode === 'draft') {
    const word = criteria.length === 1 ? 'CRITERION' : 'CRITERIA'
    return { label: `EPIC CHECKS · ${criteria.length} ${word}`, tone: 'neutral' }
  }
  const metIds = new Set((context.input.outcome ?? []).filter((result) => result.met).map((result) => result.criterionId))
  const met = criteria.filter((criterion) => metIds.has(criterion.id)).length
  const complete = criteria.length > 0 && met === criteria.length
  return { label: `EPIC CHECKS · ${met} OF ${criteria.length} MET`, tone: complete ? 'passed' : 'neutral' }
}

// ---------------------------------------------------------------------------------------------
// Nodes and edges

function ticketNode(context: Context, id: string, frame: Frame): TicketNodeModel | null {
  const content = context.tickets.get(id)
  const placement = frame.plan.placements.get(id)
  if (!content || !placement) {
    return null
  }
  const badge = resolveBadge(context, id)
  return {
    kind: 'ticket',
    id,
    sprintId: frame.plan.sprint.id,
    ticketKey: content.key,
    title: content.title,
    label: `${content.key} · ${badge.label}`,
    tone: badge.tone,
    dashed: badge.dashed,
    note: noteFor(context, id),
    size: content.size ?? null,
    effort: content.capability.reasoning.effort ?? null,
    acceptance: isAcceptanceTicket(content),
    inProgress: context.input.mode === 'saved' &&
      (context.execution === null
        ? context.input.statuses.get(id) === 'in_progress'
        : context.execution.get(id)?.state === 'running'),
    x: FIRST_COLUMN_X + placement.column * COLUMN_PITCH,
    y: frame.top + placement.row * ROW_PITCH,
    width: CARD_WIDTH,
    height: CARD_HEIGHT
  }
}

function sprintNode(context: Context, frame: Frame): SprintNodeModel {
  const sprint = frame.plan.sprint
  const run = context.run
  return {
    kind: 'sprint',
    id: `sprint:${sprint.id}`,
    sprintId: sprint.id,
    heading: `SPRINT ${sprint.ordinal}`,
    goal: sprintGoal(sprint),
    detail: sprintDetail(sprint, context),
    active: run !== null && isActiveRunState(run.state) && activeOrdinal(context) === sprint.ordinal,
    goalLines: frame.label.goalLines,
    labelHeight: frame.label.height,
    hasAcceptance: frame.plan.acceptance.length > 0,
    x: LABEL_X,
    y: frame.top + LABEL_OFFSET_Y,
    width: LABEL_WIDTH,
    height: Math.max(frame.bottom - frame.top, frame.label.height)
  }
}

function dividerNode(id: string, lineY: number, width: number, text: { label: string; tone: DividerTone }): DividerNodeModel {
  return { kind: 'divider', id, label: text.label, tone: text.tone, x: DIVIDER_X, y: lineY - DIVIDER_HEIGHT / 2, width, height: DIVIDER_HEIGHT }
}

/** Waiting until every ticket the acceptance node requires is accepted; always met without an execution overlay. */
function joinMet(context: Context, nodeId: string): boolean {
  const execution = context.execution
  return execution === null || implicitPrerequisitesOf(context.bundle, nodeId).every((id) => execution.get(id)?.state === 'accepted')
}

/** One bracket from the first work row down to the acceptance node; none when the sprint has no work above it. */
function joinNode(context: Context, frame: Frame): JoinNodeModel[] {
  const plan = frame.plan
  const [first] = plan.acceptance
  if (first === undefined || plan.workRows === 0) {
    return []
  }
  return [
    {
      kind: 'join',
      id: `join:${plan.sprint.id}`,
      sprintId: plan.sprint.id,
      met: joinMet(context, first),
      label: `${keyOf(context, first)} requires every required ticket of Sprint ${plan.sprint.ordinal}`,
      x: FIRST_COLUMN_X - JOIN_WIDTH,
      y: frame.top + CARD_HEIGHT / 2,
      width: JOIN_WIDTH,
      height: plan.workRows * ROW_PITCH
    }
  ]
}

const CHECK_STATUS_LABELS: Record<RowCheckState, string> = { passed: 'PASSED', failed: 'FAILED', none: 'NO CHECK' }
const CHECK_TONES: Record<RowCheckState, Tone> = { passed: 'accepted', failed: 'failed', none: 'neutral' }

function rowCheckState(view: RowView): RowCheckState {
  const check = view.latestCheck
  if (check === null) {
    return 'none'
  }
  return check.passed ? 'passed' : 'failed'
}

function rowCheckDetail(view: RowView): string {
  const check = view.latestCheck
  const row = `Row ${view.row}`
  if (check === null) {
    return `${row} has no check yet`
  }
  const commit = check.commit.slice(0, 7)
  if (check.passed) {
    return `${row} check ${check.number} passed at ${commit}`
  }
  const unmet = check.checks.filter((item) => item.status !== 'passed').map((item) => `${item.name} (${item.status})`)
  return `${row} check ${check.number} at ${commit} did not pass${unmet.length === 0 ? '' : `: ${unmet.join(', ')}`}`
}

function rowCheckNode(view: RowView, x: number, y: number): RowCheckNodeModel {
  const state = rowCheckState(view)
  return {
    kind: 'rowcheck',
    id: `rowcheck:${view.sprintId}:${view.row}`,
    sprintId: view.sprintId,
    row: view.row,
    state,
    label: `ROW ${view.row}`,
    status: CHECK_STATUS_LABELS[state],
    tone: CHECK_TONES[state],
    detail: rowCheckDetail(view),
    x,
    y,
    width: ROW_CHECK_WIDTH,
    height: ROW_CHECK_HEIGHT
  }
}

/** The chips of a sprint share one column, right of the widest of its work rows (the acceptance node is no row). */
function rowCheckX(frame: Frame): number {
  const widest = Math.max(
    0,
    ...[...frame.plan.placements].filter(([id]) => !frame.plan.acceptance.includes(id)).map(([, placement]) => placement.column + 1)
  )
  return FIRST_COLUMN_X + widest * COLUMN_PITCH - COLUMN_GAP + ROW_CHECK_GAP
}

/** A chip for each dependency row the run knows, at the first visual row of that row; none outside the Saved view of a run. */
function rowCheckNodes(context: Context, frame: Frame): RowCheckNodeModel[] {
  const run = context.run
  if (run === null) {
    return []
  }
  const x = rowCheckX(frame)
  return frame.plan.depRows.flatMap(({ row, visual }) => {
    const view = run.rows.find((item) => item.sprintId === frame.plan.sprint.id && item.row === row)
    return view === undefined ? [] : [rowCheckNode(view, x, frame.top + visual * ROW_PITCH + (CARD_HEIGHT - ROW_CHECK_HEIGHT) / 2)]
  })
}

function frameNodes(context: Context, frame: Frame, dividerWidth: number, last: boolean): GraphNode[] {
  const tickets = [...frame.plan.placements.keys()]
    .map((id) => ticketNode(context, id, frame))
    .filter((item): item is TicketNodeModel => item !== null)
  const sprint = frame.plan.sprint
  const divider = last
    ? []
    : [dividerNode(`checkpoint:${sprint.ordinal}`, frame.bottom + BAND_GAP, dividerWidth, checkpointLabel(sprint, context))]
  return [sprintNode(context, frame), ...divider, ...joinNode(context, frame), ...tickets]
}

function epicNode(context: Context, width: number): EpicNodeModel {
  const bundle = context.bundle
  return {
    kind: 'epic',
    id: 'epic',
    eyebrow: `EPIC · ${plural(bundle.tickets.length, 'TICKET')} · ${plural(bundle.sprints.length, 'SPRINT')}`,
    title: bundle.epic.title,
    x: FIRST_COLUMN_X + width / 2 - EPIC_WIDTH / 2,
    y: EPIC_TOP,
    width: EPIC_WIDTH,
    height: EPIC_HEIGHT
  }
}

function buildEdges(context: Context, placed: Set<string>): GraphEdge[] {
  const seen = new Set<string>()
  const edges: GraphEdge[] = []
  for (const item of context.bundle.edges) {
    const id = `${item.from}->${item.to}`
    const usable = placed.has(item.from) && placed.has(item.to) && item.from !== item.to && !seen.has(id)
    if (usable) {
      seen.add(id)
      const met = context.execution === null || context.execution.get(item.from)?.state === 'accepted'
      edges.push({ id, from: item.from, to: item.to, met })
    }
  }
  return edges
}

function bandsOf(frames: Frame[]): SprintBand[] {
  return frames.map((frame, index) => ({
    sprintId: frame.plan.sprint.id,
    top: index === 0 ? -Infinity : (frames[index - 1]?.bottom ?? 0) + BAND_GAP,
    bottom: index === frames.length - 1 ? Infinity : frame.bottom + BAND_GAP
  }))
}

export function buildGraphModel(input: GraphInput): GraphModel {
  const context = createContext(input)
  const plans = layoutSprints(context.bundle)
  const frames = toFrames(plans, context)
  const width = contentWidth(plans)
  const chips = frames.flatMap((frame) => rowCheckNodes(context, frame))
  // A chip right of a full-width row reaches past the canvas margin, so the lane left of the legend grows by that much.
  const chipReach = Math.max(0, ...chips.map((chip) => chip.x + chip.width - (FIRST_COLUMN_X + width + RIGHT_MARGIN)))
  const dividerWidth = FIRST_COLUMN_X + width + RIGHT_MARGIN + chipReach + LEGEND_LANE - DIVIDER_X
  const lastBottom = frames[frames.length - 1]?.bottom ?? FIRST_BAND_TOP
  const nodes: GraphNode[] = [
    epicNode(context, width),
    ...frames.flatMap((frame, index) => frameNodes(context, frame, dividerWidth, index === frames.length - 1)),
    dividerNode('checks', lastBottom + BAND_GAP, dividerWidth, checksLabel(context)),
    ...chips
  ]
  const placed = new Set(plans.flatMap((plan) => [...plan.placements.keys()]))
  return { nodes, edges: buildEdges(context, placed), bands: bandsOf(frames) }
}

export function sprintAtY(bands: SprintBand[], y: number): string | null {
  return bands.find((band) => band.top <= y && y < band.bottom)?.sprintId ?? null
}

/** The sprint a dragged ticket card was dropped into, or null when it stays in its own sprint. */
export function dropTarget(model: GraphModel, ticketId: string, top: number): string | null {
  const card = model.nodes.find((item): item is TicketNodeModel => item.kind === 'ticket' && item.id === ticketId)
  if (!card) {
    return null
  }
  const target = sprintAtY(model.bands, top + CARD_HEIGHT / 2)
  return target === card.sprintId ? null : target
}
