/**
 * Pure form state for the Draft-view ticket editor. Edits stay local until Apply, which turns the
 * differences against the latest draft into one `updatePlanDraft` request: an `update_ticket`
 * patch with only the changed fields, then dependency removals, the sprint move, and additions.
 */
import type { CriterionInput, DraftOp, TicketInput } from '../../../shared/domain/api'
import {
  MODALITIES,
  TOOL_CAPABILITIES,
  type CapabilityProfile,
  type Criterion,
  type Modality,
  type PlanBundle,
  type ReasoningLevel,
  type TicketContent,
  type TicketPriority,
  type ToolCapability,
  type WorkType
} from '../../../shared/domain/bundle'

export interface CriterionField {
  /** Stable React key: the criterion id, or `new-n` for unsaved rows. */
  key: string
  id: string | null
  text: string
}

export interface TicketForm {
  title: string
  body: string
  criteria: CriterionField[]
  nextKey: number
  tags: string
  priority: TicketPriority
  optional: boolean
  sprintId: string
  prerequisites: string[]
  workType: WorkType
  reasoningLevel: ReasoningLevel
  rationale: string
  tools: ToolCapability[]
  modalities: Modality[]
  skills: string
  tokens: string
}

export interface Option {
  id: string
  label: string
}

function findTicket(bundle: PlanBundle, ticketId: string): TicketContent | null {
  return bundle.tickets.find((item) => item.id === ticketId) ?? null
}

function sprintOf(bundle: PlanBundle, ticketId: string): string {
  return bundle.sprints.find((sprint) => sprint.ticketIds.includes(ticketId))?.id ?? ''
}

function prerequisitesOf(bundle: PlanBundle, ticketId: string): string[] {
  return bundle.edges.filter((item) => item.to === ticketId).map((item) => item.from)
}

export function formFromBundle(bundle: PlanBundle, ticketId: string): TicketForm | null {
  const ticket = findTicket(bundle, ticketId)
  if (!ticket) {
    return null
  }
  const capability = ticket.capability
  const tokens = capability.context.estimatedInputTokens
  return {
    title: ticket.title,
    body: ticket.body,
    criteria: ticket.acceptanceCriteria.map((criterion) => ({ key: criterion.id, id: criterion.id, text: criterion.text })),
    nextKey: 1,
    tags: ticket.tags.join(', '),
    priority: ticket.priority,
    optional: ticket.optional,
    sprintId: sprintOf(bundle, ticketId),
    prerequisites: prerequisitesOf(bundle, ticketId),
    workType: capability.workType,
    reasoningLevel: capability.reasoning.level,
    rationale: capability.reasoning.rationale,
    tools: [...capability.tools],
    modalities: [...capability.modalities],
    skills: capability.skills.join(', '),
    tokens: tokens === null ? '' : String(tokens)
  }
}

/** Comma-separated input to a clean list (trimmed, no blanks, no case-insensitive duplicates). */
export function splitList(text: string): string[] {
  const seen = new Set<string>()
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => {
      const folded = item.toLowerCase()
      const keep = item !== '' && !seen.has(folded)
      seen.add(folded)
      return keep
    })
}

export function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}

export function addCriterion(form: TicketForm): TicketForm {
  const row: CriterionField = { key: `new-${form.nextKey}`, id: null, text: '' }
  return { ...form, criteria: [...form.criteria, row], nextKey: form.nextKey + 1 }
}

export function editCriterion(form: TicketForm, index: number, text: string): TicketForm {
  return { ...form, criteria: form.criteria.map((row, position) => (position === index ? { ...row, text } : row)) }
}

export function removeCriterion(form: TicketForm, index: number): TicketForm {
  return { ...form, criteria: form.criteria.filter((_, position) => position !== index) }
}

export function moveCriterion(form: TicketForm, index: number, delta: -1 | 1): TicketForm {
  const target = index + delta
  const moving = form.criteria[index]
  const other = form.criteria[target]
  if (!moving || !other) {
    return form
  }
  const criteria = [...form.criteria]
  criteria[index] = other
  criteria[target] = moving
  return { ...form, criteria }
}

function parseTokens(text: string): number | null {
  const trimmed = text.trim()
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null
}

export function formErrors(form: TicketForm): string | null {
  if (form.title.trim() === '') {
    return 'Title is required.'
  }
  const tokens = form.tokens.trim()
  return tokens === '' || /^\d+$/.test(tokens) ? null : 'Estimated tokens must be a whole number.'
}

function sameList<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameSet<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value))
}

function criteriaInput(form: TicketForm): CriterionInput[] {
  return form.criteria
    .filter((row) => row.text.trim() !== '')
    .map((row) => (row.id === null ? { text: row.text.trim() } : { id: row.id, text: row.text.trim() }))
}

function sameCriteria(inputs: CriterionInput[], existing: Criterion[]): boolean {
  return sameList(
    inputs.map((item) => `${item.id ?? ''}\u0000${item.text}`),
    existing.map((item) => `${item.id}\u0000${item.text}`)
  )
}

function capabilityPatch(form: TicketForm, profile: CapabilityProfile): Partial<CapabilityProfile> {
  const patch: Partial<CapabilityProfile> = {}
  const reasoning = { level: form.reasoningLevel, rationale: form.rationale.trim() }
  const tools = TOOL_CAPABILITIES.filter((tool) => form.tools.includes(tool))
  const modalities = MODALITIES.filter((item) => form.modalities.includes(item))
  const skills = splitList(form.skills)
  const tokens = parseTokens(form.tokens)
  if (form.workType !== profile.workType) {
    patch.workType = form.workType
  }
  if (reasoning.level !== profile.reasoning.level || reasoning.rationale !== profile.reasoning.rationale) {
    patch.reasoning = reasoning
  }
  if (!sameSet(tools, profile.tools)) {
    patch.tools = tools
  }
  if (!sameSet(modalities, profile.modalities)) {
    patch.modalities = modalities
  }
  if (!sameList(skills, profile.skills)) {
    patch.skills = skills
  }
  if (tokens !== profile.context.estimatedInputTokens) {
    patch.context = { ...profile.context, estimatedInputTokens: tokens }
  }
  return patch
}

function contentPatch(form: TicketForm, ticket: TicketContent): Partial<TicketInput> {
  const patch: Partial<TicketInput> = {}
  const title = form.title.trim()
  const criteria = criteriaInput(form)
  const tags = splitList(form.tags)
  if (title !== ticket.title) {
    patch.title = title
  }
  if (form.body !== ticket.body) {
    patch.body = form.body
  }
  if (!sameCriteria(criteria, ticket.acceptanceCriteria)) {
    patch.acceptanceCriteria = criteria
  }
  if (!sameList(tags, ticket.tags)) {
    patch.tags = tags
  }
  return patch
}

function ticketPatch(form: TicketForm, ticket: TicketContent): Partial<TicketInput> {
  const patch = contentPatch(form, ticket)
  const capability = capabilityPatch(form, ticket.capability)
  if (form.priority !== ticket.priority) {
    patch.priority = form.priority
  }
  if (form.optional !== ticket.optional) {
    patch.optional = form.optional
  }
  if (Object.keys(capability).length > 0) {
    patch.capability = capability
  }
  return patch
}

/** Operations that turn the latest draft into the form's state (empty when nothing changed). */
export function formToOps(form: TicketForm, bundle: PlanBundle, ticketId: string): DraftOp[] {
  const ticket = findTicket(bundle, ticketId)
  if (!ticket) {
    return []
  }
  const patch = ticketPatch(form, ticket)
  const current = prerequisitesOf(bundle, ticketId)
  const sprintId = sprintOf(bundle, ticketId)
  const update: DraftOp[] = Object.keys(patch).length > 0 ? [{ op: 'update_ticket', ticket: ticketId, patch }] : []
  const removals = current
    .filter((id) => !form.prerequisites.includes(id))
    .map((from): DraftOp => ({ op: 'remove_dependency', from, to: ticketId }))
  const move: DraftOp[] =
    form.sprintId !== '' && form.sprintId !== sprintId ? [{ op: 'move_ticket', ticket: ticketId, toSprint: form.sprintId }] : []
  const additions = form.prerequisites
    .filter((id) => !current.includes(id))
    .map((from): DraftOp => ({ op: 'add_dependency', from, to: ticketId }))
  return [...update, ...removals, ...move, ...additions]
}

export function sprintOptions(bundle: PlanBundle): Option[] {
  return [...bundle.sprints]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((sprint) => ({
      id: sprint.id,
      label: sprint.goal.trim() === '' ? `Sprint ${sprint.ordinal}` : `Sprint ${sprint.ordinal} · ${sprint.goal}`
    }))
}

/** Tickets that may become prerequisites: same or earlier sprint than the form's sprint, not yet chosen. */
export function prerequisiteOptions(bundle: PlanBundle, ticketId: string, form: TicketForm): Option[] {
  const limit = bundle.sprints.find((sprint) => sprint.id === form.sprintId)?.ordinal
  if (limit === undefined) {
    return []
  }
  const tickets = new Map(bundle.tickets.map((item) => [item.id, item]))
  return [...bundle.sprints]
    .filter((sprint) => sprint.ordinal <= limit)
    .sort((a, b) => a.ordinal - b.ordinal)
    .flatMap((sprint) => sprint.ticketIds)
    .filter((id) => id !== ticketId && !form.prerequisites.includes(id))
    .flatMap((id) => {
      const item = tickets.get(id)
      return item ? [{ id, label: `${item.key} ${item.title}` }] : []
    })
}

// ---------------------------------------------------------------------------------------------
// Editor state: local edits survive reloads and conflicts until applied or reverted.

export const CONFLICT_MESSAGE = 'The draft changed while you were editing — review and apply again.'

export interface EditorMessage {
  tone: 'error' | 'info'
  text: string
}

export interface EditorState {
  form: TicketForm | null
  /** The person edited the form since it was last loaded from the draft. */
  touched: boolean
  /** An Apply succeeded; the next draft reload replaces the form. */
  awaitingSync: boolean
  message: EditorMessage | null
}

export type ApplyOutcome = { ok: true } | { ok: false; code: string | null; message: string }

export function initialEditor(bundle: PlanBundle, ticketId: string): EditorState {
  return { form: formFromBundle(bundle, ticketId), touched: false, awaitingSync: false, message: null }
}

/** A new draft arrived: keep unsaved edits, otherwise show the latest ticket. */
export function syncEditor(state: EditorState, bundle: PlanBundle, ticketId: string): EditorState {
  if (state.touched && !state.awaitingSync) {
    return state
  }
  return { ...state, form: formFromBundle(bundle, ticketId), touched: false, awaitingSync: false }
}

export function editForm(state: EditorState, form: TicketForm): EditorState {
  return { ...state, form, touched: true, awaitingSync: false }
}

export function applyOutcome(state: EditorState, outcome: ApplyOutcome): EditorState {
  if (outcome.ok) {
    return { ...state, awaitingSync: true, message: { tone: 'info', text: 'Applied to the draft.' } }
  }
  const text = outcome.code === 'conflict' ? CONFLICT_MESSAGE : outcome.message
  return { ...state, message: { tone: 'error', text } }
}

export function rejectForm(state: EditorState, text: string): EditorState {
  return { ...state, message: { tone: 'error', text } }
}

/** Maps a `<select>` value back to one of its typed options (the fallback when unknown). */
export function pick<T extends string>(options: readonly T[], value: string, fallback: T): T {
  return options.find((option) => option === value) ?? fallback
}
