/**
 * The Found-a-cult form as plain data: its defaults, what choosing an archetype does to it, and the checks that turn it
 * into a cult definition. Pure, so the dialog only renders it and the bounds are tested without a DOM.
 */
import {
  ARCHETYPE_INFO,
  CUSTOM_WORKER_TYPE,
  validateRoster,
  type CultArchetype,
  type RosterSlot,
  type WorkerType
} from '../../../shared/cults/archetypes'
import type { CultDefinitionInput } from '../../../shared/cults/cultApi'
import type { CultView } from '../../../shared/cults/cult'
import { formatDuration, parseDuration, parseTimeLimit } from '../../../shared/cults/duration'
import {
  DEFAULT_ACOLYTE_GRACE_MS,
  DEFAULT_CAP,
  DEFAULT_MAGOS_WINDOW_MS,
  backstopMs,
  capIssue,
  shutdownTimingIssue
} from '../../../shared/cults/runState'

/** The default time limit a new cult offers. */
const DEFAULT_TIME_LIMIT = '30m'
/** A Plan Forge needs its six specialists at once. */
const PLAN_FORGE_MIN_CAP = 6

export interface FoundCultDraft {
  archetype: CultArchetype
  name: string
  charter: string
  /** A tracked folder, or null for a project-less cult (its own sanctum). */
  folderPath: string | null
  /** A Plan Forge's target epic in its folder. */
  targetEpicId: string | null
  magosName: string
  magosModelId: string | null
  /** As typed: a duration such as `30m`, `90hr` or `1d 6h`. */
  timeLimit: string
  unlimited: boolean
  cap: string
  acolyteGrace: string
  magosWindow: string
  slots: RosterSlot[]
}

type DraftField = 'name' | 'charter' | 'folder' | 'target' | 'magosName' | 'timeLimit' | 'cap' | 'acolyteGrace' | 'magosWindow'

export interface DraftCheck {
  /** The definition to save, or null while any field is refused. */
  input: CultDefinitionInput | null
  errors: Partial<Record<DraftField, string>>
  /** Why the roster is refused, one line per issue. */
  rosterIssues: string[]
  /** The derived kill backstop after shutdown starts, while both timings are valid. */
  backstopMs: number | null
}

const copySlots = (slots: readonly RosterSlot[]): RosterSlot[] => slots.map((slot) => ({ ...slot }))

/** A fresh form: General, 30m, cap 6 and the default timings. */
export function newDraft(magosName: string, folderPath: string | null): FoundCultDraft {
  return {
    archetype: 'general',
    name: '',
    charter: '',
    folderPath,
    targetEpicId: null,
    magosName,
    magosModelId: null,
    timeLimit: DEFAULT_TIME_LIMIT,
    unlimited: false,
    cap: String(DEFAULT_CAP),
    acolyteGrace: formatDuration(DEFAULT_ACOLYTE_GRACE_MS),
    magosWindow: formatDuration(DEFAULT_MAGOS_WINDOW_MS),
    slots: []
  }
}

/** The form for editing a saved cult. */
export function draftOf(cult: CultView): FoundCultDraft {
  return {
    archetype: cult.archetype,
    name: cult.name,
    charter: cult.charter,
    folderPath: cult.folderPath,
    targetEpicId: cult.targetEpicId,
    magosName: cult.magosName,
    magosModelId: cult.magosModelId,
    timeLimit: cult.defaultTimeLimitMs === null ? DEFAULT_TIME_LIMIT : formatDuration(cult.defaultTimeLimitMs),
    unlimited: cult.defaultTimeLimitMs === null,
    cap: String(cult.defaultCap),
    acolyteGrace: formatDuration(cult.acolyteGraceMs),
    magosWindow: formatDuration(cult.magosWindowMs),
    slots: copySlots(cult.slots)
  }
}

/** Switching archetype loads its preset roster; a Plan Forge raises the cap to six. */
export function chooseArchetype(draft: FoundCultDraft, archetype: CultArchetype): FoundCultDraft {
  const cap = Number(draft.cap)
  const raise = archetype === 'plan_forge' && (!Number.isInteger(cap) || cap < PLAN_FORGE_MIN_CAP)
  return {
    ...draft,
    archetype,
    targetEpicId: archetype === 'plan_forge' ? draft.targetEpicId : null,
    slots: copySlots(ARCHETYPE_INFO[archetype].preset),
    cap: raise ? String(PLAN_FORGE_MIN_CAP) : draft.cap
  }
}

/** Whether the person may edit slot text (Delivery, Audit, Research, Custom) and reshape the roster (Custom). */
export function rosterEditing(archetype: CultArchetype): { text: boolean; shape: boolean } {
  const kind = ARCHETYPE_INFO[archetype].presetKind
  return { text: kind === 'editable_defaults' || kind === 'supplied', shape: kind === 'supplied' }
}

/** A blank Custom slot with an id not yet in the roster. */
export function blankSlot(slots: readonly RosterSlot[], workerType: WorkerType = CUSTOM_WORKER_TYPE): RosterSlot {
  const taken = new Set(slots.map((slot) => slot.id))
  let n = slots.length + 1
  while (taken.has(`slot_${n}`)) n += 1
  return { id: `slot_${n}`, workerType, label: '', mission: '', required: true }
}

/** Moves the slot at `index` by `step` (−1 up, +1 down); out-of-range moves change nothing. */
export function moveSlot(slots: readonly RosterSlot[], index: number, step: -1 | 1): RosterSlot[] {
  const target = index + step
  if (target < 0 || target >= slots.length) return [...slots]
  const next = [...slots]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

type TimingResult = { ms: number | null; error?: string }

function timing(text: string): TimingResult {
  const parsed = parseDuration(text)
  if (!parsed.ok) return { ms: null, error: parsed.error }
  const issue = shutdownTimingIssue(parsed.ms)
  return issue === null ? { ms: parsed.ms } : { ms: null, error: issue }
}

function timeLimitOf(draft: FoundCultDraft): TimingResult {
  if (draft.unlimited) return { ms: null }
  const parsed = parseTimeLimit(draft.timeLimit)
  if (!parsed.ok) return { ms: null, error: parsed.error }
  return parsed.ms === null ? { ms: null, error: 'Tick Unlimited for a run with no time limit.' } : { ms: parsed.ms }
}

function capOf(draft: FoundCultDraft): { cap: number; error?: string } {
  const cap = /^\s*\d+\s*$/.test(draft.cap) ? Number(draft.cap) : Number.NaN
  const issue = capIssue(cap)
  if (issue !== null) return { cap, error: issue }
  if (draft.archetype === 'plan_forge' && cap < PLAN_FORGE_MIN_CAP)
    return { cap, error: `A Plan Forge needs a cap of at least ${PLAN_FORGE_MIN_CAP}.` }
  return { cap }
}

function placeErrors(draft: FoundCultDraft): Partial<Record<DraftField, string>> {
  const errors: Partial<Record<DraftField, string>> = {}
  if (!draft.name.trim()) errors.name = 'Name the cult.'
  if (!draft.charter.trim()) errors.charter = 'Write the charter the Magos works to.'
  if (!draft.magosName.trim()) errors.magosName = 'Name the Magos.'
  if (draft.archetype === 'plan_forge' && draft.folderPath === null) errors.folder = 'A Plan Forge works in a tracked folder.'
  if (draft.archetype === 'plan_forge' && draft.targetEpicId === null) errors.target = 'Choose the plan this Plan Forge works on.'
  return errors
}

interface Parsed {
  limit: TimingResult
  cap: { cap: number; error?: string }
  grace: TimingResult
  window: TimingResult
}

function parseAll(draft: FoundCultDraft): Parsed {
  return { limit: timeLimitOf(draft), cap: capOf(draft), grace: timing(draft.acolyteGrace), window: timing(draft.magosWindow) }
}

function fieldErrors(draft: FoundCultDraft, parsed: Parsed): Partial<Record<DraftField, string>> {
  const errors = placeErrors(draft)
  if (parsed.limit.error) errors.timeLimit = parsed.limit.error
  if (parsed.cap.error) errors.cap = parsed.cap.error
  if (parsed.grace.error) errors.acolyteGrace = parsed.grace.error
  if (parsed.window.error) errors.magosWindow = parsed.window.error
  return errors
}

function definitionOf(draft: FoundCultDraft, parsed: Parsed): CultDefinitionInput {
  const place =
    draft.folderPath === null
      ? { scope: 'sanctum' as const, folderPath: null }
      : { scope: 'folder' as const, folderPath: draft.folderPath }
  const sendsSlots = rosterEditing(draft.archetype).text
  return {
    ...place,
    name: draft.name.trim(),
    charter: draft.charter.trim(),
    archetype: draft.archetype,
    targetEpicId: draft.archetype === 'plan_forge' ? draft.targetEpicId : null,
    magosName: draft.magosName.trim(),
    magosModelId: draft.magosModelId,
    defaultTimeLimitMs: parsed.limit.ms,
    defaultCap: parsed.cap.cap,
    acolyteGraceMs: parsed.grace.ms ?? undefined,
    magosWindowMs: parsed.window.ms ?? undefined,
    ...(sendsSlots ? { slots: draft.slots.map((slot) => ({ ...slot, label: slot.label.trim(), mission: slot.mission.trim() })) } : {})
  }
}

/** Checks every field against its bounds; the definition is present only when nothing is refused. */
export function checkDraft(draft: FoundCultDraft): DraftCheck {
  const parsed = parseAll(draft)
  const errors = fieldErrors(draft, parsed)
  const cap = Number.isInteger(parsed.cap.cap) ? parsed.cap.cap : 0
  const roster = validateRoster({ archetype: draft.archetype, slots: draft.slots, cap })
  const rosterIssues = roster.filter((issue) => issue.code !== 'cap_below_required' || !errors.cap).map((issue) => issue.message)
  const backstop = parsed.grace.ms !== null && parsed.window.ms !== null ? backstopMs(parsed.grace.ms, parsed.window.ms) : null
  const valid = Object.keys(errors).length === 0 && rosterIssues.length === 0
  return { input: valid ? definitionOf(draft, parsed) : null, errors, rosterIssues, backstopMs: backstop }
}
