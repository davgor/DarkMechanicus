/**
 * Pure plan-graph model: derives node positions and labels from a plan bundle (layout is never
 * stored), overlaying run execution state in the Saved view or draft change state in the Draft
 * view. Sprints stack top to bottom; inside a sprint, rows follow same-sprint dependency depth
 * and columns follow the barycenter of each ticket's prerequisites to reduce crossings.
 */
import type { ChangeKind, CriterionResult, PlanView, RunView, TicketExecutionView } from '../../../shared/domain/views'
import type { DependencyEdge, PlanBundle, SprintDef, TicketContent } from '../../../shared/domain/bundle'
import { isActiveRunState, type WorkStatus } from '../../../shared/domain/status'
import { DASHED_EXECUTION, EXECUTION_LABELS, EXECUTION_TONES, STATUS_LABELS, STATUS_TONES, type Tone } from './ticketStates'

export const CARD_WIDTH = 210
export const CARD_HEIGHT = 72
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
const DIVIDER_X = 16
const DIVIDER_HEIGHT = 28
const RIGHT_MARGIN = 24
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

export type DividerTone = 'passed' | 'locked' | 'neutral'

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
  note: string | null
}

export type GraphNode = EpicNodeModel | SprintNodeModel | DividerNodeModel | TicketNodeModel

export interface GraphEdge {
  id: string
  from: string
  to: string
  /** Solid when the prerequisite is accepted (or there is no execution overlay). */
  met: boolean
}

/** Vertical drop zone of a sprint, bounded by the checkpoint dividers around it. */
export interface SprintBand {
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
  rows: number
  placements: Map<string, Placement>
}

interface Frame {
  plan: SprintPlan
  top: number
  bottom: number
}

interface LayoutContext {
  edges: DependencyEdge[]
  prerequisites: Map<string, string[]>
  columnOf: Map<string, number>
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

/** Longest-path depth over same-sprint prerequisites; cycle members go after the acyclic rows. */
function sprintDepths(ids: string[], edges: DependencyEdge[]): Map<string, number> {
  const members = new Set(ids)
  const inner = edges.filter((item) => item.from !== item.to && members.has(item.from) && members.has(item.to))
  const pending = new Map(ids.map((id) => [id, 0]))
  inner.forEach((item) => pending.set(item.to, (pending.get(item.to) ?? 0) + 1))
  const depth = new Map<string, number>()
  const queue = ids.filter((id) => pending.get(id) === 0)
  queue.forEach((id) => depth.set(id, 0))
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index] ?? ''
    for (const item of inner.filter((candidate) => candidate.from === id)) {
      depth.set(item.to, Math.max(depth.get(item.to) ?? 0, (depth.get(id) ?? 0) + 1))
      const left = (pending.get(item.to) ?? 0) - 1
      pending.set(item.to, left)
      if (left === 0) {
        queue.push(item.to)
      }
    }
  }
  const after = Math.max(-1, ...depth.values()) + 1
  ids.filter((id) => !depth.has(id)).forEach((id) => depth.set(id, after))
  return depth
}

function groupByDepth(ids: string[], depth: Map<string, number>): string[][] {
  const levels = new Map<number, string[]>()
  for (const id of ids) {
    const level = depth.get(id) ?? 0
    levels.set(level, [...(levels.get(level) ?? []), id])
  }
  return [...levels.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1])
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

function placeSprint(sprint: SprintDef, ids: string[], layout: LayoutContext): SprintPlan {
  const placements = new Map<string, Placement>()
  let row = 0
  for (const level of groupByDepth(ids, sprintDepths(ids, layout.edges))) {
    for (const chunk of chunks(orderByBarycenter(level, layout), MAX_COLUMNS)) {
      const assigned = assignColumns(chunk, layout)
      const currentRow = row
      assigned.forEach((column, id) => {
        placements.set(id, { column, row: currentRow })
        layout.columnOf.set(id, column)
      })
      row += 1
    }
  }
  return { sprint, rows: Math.max(1, row), placements }
}

function layoutSprints(bundle: PlanBundle): SprintPlan[] {
  const known = new Set(bundle.tickets.map((item) => item.id))
  const seen = new Set<string>()
  const layout: LayoutContext = { edges: bundle.edges, prerequisites: prerequisiteMap(bundle.edges), columnOf: new Map() }
  return sortedSprints(bundle).map((sprint) => {
    const ids = sprint.ticketIds.filter((id) => known.has(id) && !seen.has(id))
    ids.forEach((id) => seen.add(id))
    return placeSprint(sprint, ids, layout)
  })
}

function toFrames(plans: SprintPlan[]): Frame[] {
  let top = FIRST_BAND_TOP
  return plans.map((plan) => {
    const bottom = top + plan.rows * ROW_PITCH - ROW_GAP
    const frame = { plan, top, bottom }
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
  const detail =
    run.state === 'awaiting_checkpoint'
      ? 'AWAITING APPROVAL'
      : `LOCKED · ${acceptedIn(sprint, context)} OF ${sprint.ticketIds.length} ACCEPTED`
  return { label: `${base} · ${detail}`, tone: 'locked' }
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
    goal: sprint.goal.trim() === '' ? 'No goal yet' : sprint.goal,
    detail: sprintDetail(sprint, context),
    active: run !== null && isActiveRunState(run.state) && activeOrdinal(context) === sprint.ordinal,
    x: LABEL_X,
    y: frame.top + 4,
    width: LABEL_WIDTH,
    height: frame.bottom - frame.top
  }
}

function dividerNode(id: string, lineY: number, width: number, text: { label: string; tone: DividerTone }): DividerNodeModel {
  return { kind: 'divider', id, label: text.label, tone: text.tone, x: DIVIDER_X, y: lineY - DIVIDER_HEIGHT / 2, width, height: DIVIDER_HEIGHT }
}

function frameNodes(context: Context, frame: Frame, dividerWidth: number, last: boolean): GraphNode[] {
  const tickets = [...frame.plan.placements.keys()]
    .map((id) => ticketNode(context, id, frame))
    .filter((item): item is TicketNodeModel => item !== null)
  const sprint = frame.plan.sprint
  const divider = last
    ? []
    : [dividerNode(`checkpoint:${sprint.ordinal}`, frame.bottom + BAND_GAP, dividerWidth, checkpointLabel(sprint, context))]
  return [sprintNode(context, frame), ...divider, ...tickets]
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
  const frames = toFrames(plans)
  const width = contentWidth(plans)
  const dividerWidth = FIRST_COLUMN_X + width + RIGHT_MARGIN - DIVIDER_X
  const lastBottom = frames[frames.length - 1]?.bottom ?? FIRST_BAND_TOP
  const nodes: GraphNode[] = [
    epicNode(context, width),
    ...frames.flatMap((frame, index) => frameNodes(context, frame, dividerWidth, index === frames.length - 1)),
    dividerNode('checks', lastBottom + BAND_GAP, dividerWidth, checksLabel(context))
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
