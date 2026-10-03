/**
 * Pure form state for the Draft-view ticket editor. Edits stay local until Apply, which turns the
 * differences against the latest draft into one `updatePlanDraft` request: an `update_ticket`
 * patch with only the changed fields, then dependency removals, the sprint move, and additions.
 * Starting from a named profile only refills the capability fields; it is applied like any edit.
 * Apply writes only the capability groups the person changed since the form was loaded, so it
 * never reverts requirements someone else (an agent) changed in the draft meanwhile.
 */
import type { CriterionInput, DraftOp, TicketInput } from '../../../shared/domain/api'
import {
  MODALITIES,
  TOOL_CAPABILITIES,
  type CapabilityPatch,
  type CapabilityProfile,
  type Criterion,
  type Modality,
  type PlanBundle,
  type ReasoningEffort,
  type ReasoningLevel,
  type TicketContent,
  type TicketPriority,
  type TicketSize,
  type ToolCapability,
  type WorkType
} from '../../../shared/domain/bundle'
import type { ProfileView } from '../../../shared/domain/views'

/** The values of the quality and cost preferences, each of which the editor can also clear. */
export const QUALITIES = ['standard', 'high'] as const
export const COSTS = ['low', 'normal'] as const
type Quality = (typeof QUALITIES)[number]
type Cost = (typeof COSTS)[number]
type Preferences = CapabilityProfile['preferences']
type Reasoning = CapabilityProfile['reasoning']

interface CriterionField {
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
  size: TicketSize | ''
  /** The ticket's size when the form was loaded: a size still equal to it is not the person's edit. */
  loadedSize: TicketSize | ''
  workType: WorkType
  reasoningLevel: ReasoningLevel
  reasoningEffort: ReasoningEffort | ''
  /** The quality preference ('' = none); shown so one inherited from a profile is visible and can be cleared. */
  quality: Quality | ''
  /** The cost preference ('' = none). */
  cost: Cost | ''
  rationale: string
  tools: ToolCapability[]
  modalities: Modality[]
  skills: string
  tokens: string
  /** The named profile the capability fields were last filled from ('' when none). */
  profile: string
  /**
   * Where the requirement groups this editor does not show (required artifacts, constraints,
   * preferences) come from: the ticket's own, or those of the last applied profile.
   */
  baseCapability: CapabilityProfile
  /** The ticket's requirements when the form was loaded: a group still equal to them is not the person's edit. */
  loadedCapability: CapabilityProfile
}

type CapabilityFields = Pick<
  TicketForm,
  | 'workType'
  | 'reasoningLevel'
  | 'reasoningEffort'
  | 'quality'
  | 'cost'
  | 'rationale'
  | 'tools'
  | 'modalities'
  | 'skills'
  | 'tokens'
  | 'baseCapability'
>

interface Option {
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

function capabilityFields(capability: CapabilityProfile): CapabilityFields {
  const tokens = capability.context.estimatedInputTokens
  const effort = capability.reasoning.effort ?? ''
  return {
    workType: capability.workType,
    reasoningLevel: capability.reasoning.level,
    reasoningEffort: effort,
    quality: capability.preferences.quality ?? '',
    cost: capability.preferences.cost ?? '',
    rationale: capability.reasoning.rationale,
    tools: [...capability.tools],
    modalities: [...capability.modalities],
    skills: capability.skills.join(', '),
    tokens: tokens === null ? '' : String(tokens),
    baseCapability: capability
  }
}

export function formFromBundle(bundle: PlanBundle, ticketId: string): TicketForm | null {
  const ticket = findTicket(bundle, ticketId)
  if (!ticket) {
    return null
  }
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
    size: ticket.size ?? '',
    loadedSize: ticket.size ?? '',
    profile: '',
    ...capabilityFields(ticket.capability),
    loadedCapability: ticket.capability
  }
}

/** Refills the capability fields from a named profile; the draft changes only on Apply. */
export function applyProfile(form: TicketForm, profile: ProfileView): TicketForm {
  return { ...form, ...capabilityFields(profile.capability), profile: profile.name }
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

/** The complete capability requirements the form describes, normalized the way Apply sends them. */
export function formCapability(form: TicketForm): CapabilityProfile {
  const base = form.baseCapability
  const reasoning: Reasoning = { level: form.reasoningLevel, rationale: form.rationale.trim() }
  if (form.reasoningEffort !== '') {
    reasoning.effort = form.reasoningEffort
  }
  const preferences: Preferences = {
    ...base.preferences,
    quality: form.quality === '' ? null : form.quality,
    cost: form.cost === '' ? null : form.cost
  }
  return {
    workType: form.workType,
    reasoning,
    skills: splitList(form.skills),
    modalities: MODALITIES.filter((item) => form.modalities.includes(item)),
    tools: TOOL_CAPABILITIES.filter((tool) => form.tools.includes(tool)),
    context: { estimatedInputTokens: parseTokens(form.tokens), requiredArtifacts: base.context.requiredArtifacts },
    constraints: base.constraints,
    preferences
  }
}

interface ProfileSaveInput {
  name: string
  description: string
  capability: CapabilityProfile
  expectedRevision?: number
}

/**
 * The saveProfile request that stores the form's requirements under a name: a new profile, or a
 * replacement of `existing` at its revision that keeps its description unless a new one is typed.
 */
export function profileSaveInput(
  form: TicketForm,
  entry: { name: string; description: string },
  existing: ProfileView | undefined
): ProfileSaveInput {
  const request = { name: entry.name.trim(), description: entry.description.trim(), capability: formCapability(form) }
  if (existing === undefined) {
    return request
  }
  const description = request.description === '' ? existing.description : request.description
  return { ...request, description, expectedRevision: existing.revision }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Deep equality of JSON-shaped values; object key order does not matter, array order does. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]))
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => sameValue(a[key], b[key]))
  }
  return a === b
}

const CAPABILITY_GROUPS = ['workType', 'reasoning', 'skills', 'modalities', 'tools', 'context', 'constraints', 'preferences'] as const

type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number]

/** Tool and modality selections are sets; every other group compares by value. */
function sameGroup(group: CapabilityGroup, next: CapabilityProfile, current: CapabilityProfile): boolean {
  if (group === 'tools' || group === 'modalities') {
    return sameSet<string>(next[group], current[group])
  }
  return sameValue(next[group], current[group])
}

function setGroup<K extends CapabilityGroup>(patch: Partial<CapabilityProfile>, group: K, value: CapabilityProfile[K]): void {
  patch[group] = value
}

type CapabilityContext = CapabilityProfile['context']

/** `context` mixes a visible field (the token estimate) with a hidden one, so it is merged per field. */
function appliedContext(mine: CapabilityContext, loaded: CapabilityContext, latest: CapabilityContext): CapabilityContext {
  const tokensEdited = mine.estimatedInputTokens !== loaded.estimatedInputTokens
  const artifactsEdited = !sameValue(mine.requiredArtifacts, loaded.requiredArtifacts)
  return {
    estimatedInputTokens: tokensEdited ? mine.estimatedInputTokens : latest.estimatedInputTokens,
    requiredArtifacts: artifactsEdited ? mine.requiredArtifacts : latest.requiredArtifacts
  }
}

/** Reads each field from the person's value when they changed it since loading, otherwise from the latest. */
function fieldPicker<T extends object>(mine: T, loaded: T, latest: T): <K extends keyof T>(key: K) => T[K] {
  return (key) => (sameValue(mine[key], loaded[key]) ? latest[key] : mine[key])
}

/** `reasoning` and `preferences` mix visible fields with ones the editor never shows, so each field is merged on its own. */
function appliedReasoning(mine: Reasoning, loaded: Reasoning, latest: Reasoning): Reasoning {
  const choose = fieldPicker(mine, loaded, latest)
  const applied: Reasoning = { level: choose('level'), rationale: choose('rationale') }
  const effort = choose('effort')
  if (effort !== undefined) {
    applied.effort = effort
  }
  return applied
}

function appliedPreferences(mine: Preferences, loaded: Preferences, latest: Preferences): Preferences {
  const choose = fieldPicker(mine, loaded, latest)
  return {
    quality: choose('quality'),
    latency: choose('latency'),
    cost: choose('cost'),
    autonomy: choose('autonomy'),
    modelOverride: choose('modelOverride')
  }
}

/**
 * The requirements Apply writes: each group the person changed since the form was loaded (through
 * a field or a profile) from the form, every other group from the latest ticket.
 */
function appliedCapability(form: TicketForm, latest: CapabilityProfile): CapabilityProfile {
  const mine = formCapability(form)
  const loaded = form.loadedCapability
  const applied = { ...mine }
  for (const group of CAPABILITY_GROUPS) {
    if (sameGroup(group, mine, loaded)) {
      setGroup(applied, group, latest[group])
    }
  }
  return {
    ...applied,
    reasoning: appliedReasoning(mine.reasoning, loaded.reasoning, latest.reasoning),
    preferences: appliedPreferences(mine.preferences, loaded.preferences, latest.preferences),
    context: appliedContext(mine.context, loaded.context, latest.context)
  }
}

/** A cleared effort goes out as `null`: leaving the key out of a patch would keep the ticket's effort. */
function clearsEffort(next: CapabilityProfile, current: CapabilityProfile): boolean {
  return next.reasoning.effort === undefined && current.reasoning.effort !== undefined
}

function capabilityPatch(form: TicketForm, current: CapabilityProfile): CapabilityPatch {
  const next = appliedCapability(form, current)
  const patch: Partial<CapabilityProfile> = {}
  for (const group of CAPABILITY_GROUPS) {
    if (!sameGroup(group, next, current)) {
      setGroup(patch, group, next[group])
    }
  }
  const { reasoning, ...others } = patch
  if (reasoning === undefined) {
    return others
  }
  return { ...others, reasoning: clearsEffort(next, current) ? { ...reasoning, effort: null } : reasoning }
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

/**
 * The size to write: `undefined` leaves it be (the person did not touch it, or it already is what they
 * chose), `null` clears a size the ticket has (an `undefined` entry would be dropped from the patch).
 */
function sizeChange(form: TicketForm, ticket: TicketContent): TicketSize | null | undefined {
  const next = form.size === '' ? null : form.size
  return form.size === form.loadedSize || next === (ticket.size ?? null) ? undefined : next
}

function ticketPatch(form: TicketForm, ticket: TicketContent): Partial<TicketInput> {
  const patch = contentPatch(form, ticket)
  const capability = capabilityPatch(form, ticket.capability)
  const size = sizeChange(form, ticket)
  if (size !== undefined) {
    patch.size = size
  }
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

interface EditorMessage {
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

type ApplyOutcome = { ok: true } | { ok: false; code: string | null; message: string }

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
