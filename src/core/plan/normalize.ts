import {
  type CapabilityPatch,
  type CapabilityProfile,
  type Criterion,
  DEFAULT_POLICIES,
  defaultCapabilityProfile,
  PLAN_FORMAT_VERSION,
  type EpicContent,
  type PlanBundle,
  type SprintDef,
  type TicketContent,
  type TicketSize
} from '../../shared/domain/bundle'
import type { CriterionInput, SprintInput, TicketInput } from '../../shared/domain/api'

export const CRITERION_ID_PATTERN = /^[a-z][0-9]{1,4}$/

function criterionNumber(id: string): number {
  return Number.parseInt(id.slice(1), 10)
}

/**
 * Normalizes criterion inputs, keeping ids that callers supplied or that match an existing
 * criterion's text, and assigning `<prefix><n>` ids to new ones.
 */
export function normalizeCriteria(
  inputs: (CriterionInput | string)[],
  existing: Criterion[],
  prefix: string
): Criterion[] {
  const used = new Set<string>()
  let next = 1 + Math.max(0, ...existing.map((item) => criterionNumber(item.id)).filter(Number.isFinite))
  const out: Criterion[] = []
  for (const input of inputs) {
    const text = (typeof input === 'string' ? input : input.text).trim()
    const requested = typeof input === 'string' ? undefined : input.id
    const byText = existing.find((item) => item.text === text && !used.has(item.id))
    let id = requested && CRITERION_ID_PATTERN.test(requested) && !used.has(requested) ? requested : byText?.id
    if (id === undefined) {
      while (used.has(`${prefix}${next}`)) {
        next += 1
      }
      id = `${prefix}${next}`
      next += 1
    }
    used.add(id)
    out.push({ id, text })
  }
  return out
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const tag = raw.trim()
    const folded = tag.toLowerCase()
    if (tag !== '' && !seen.has(folded)) {
      seen.add(folded)
      out.push(tag)
    }
  }
  return out
}

type Reasoning = CapabilityProfile['reasoning']

/**
 * Merges a reasoning patch over a base. A null `effort` removes the key: a stored profile never
 * holds null, because saved plans hash their exact shape.
 */
function mergeReasoning(base: Reasoning, patch: CapabilityPatch['reasoning']): Reasoning {
  const { effort: patched, ...fields } = patch ?? {}
  const merged: Reasoning = { ...base, ...fields }
  const effort = patched === undefined ? base.effort : patched
  if (effort === null || effort === undefined) {
    delete merged.effort
  } else {
    merged.effort = effort
  }
  return merged
}

/** Shallow-merges a partial capability profile over a base, one level deep for nested groups. */
export function mergeCapability(
  base: CapabilityProfile,
  patch: CapabilityPatch | undefined
): CapabilityProfile {
  if (!patch) {
    return base
  }
  return {
    workType: patch.workType ?? base.workType,
    reasoning: mergeReasoning(base.reasoning, patch.reasoning),
    skills: patch.skills ? normalizeTags(patch.skills) : base.skills,
    modalities: patch.modalities ?? base.modalities,
    tools: patch.tools ?? base.tools,
    context: { ...base.context, ...patch.context },
    constraints: { ...base.constraints, ...patch.constraints },
    preferences: { ...base.preferences, ...patch.preferences }
  }
}

export function buildTicket(input: TicketInput, identity: { id: string; key: string }): TicketContent {
  return {
    id: identity.id,
    key: identity.key,
    title: input.title.trim(),
    body: input.body ?? '',
    acceptanceCriteria: normalizeCriteria(input.acceptanceCriteria ?? [], [], 'c'),
    tags: normalizeTags(input.tags ?? []),
    priority: input.priority ?? 'normal',
    ...(input.size === undefined || input.size === null ? {} : { size: input.size }),
    capability: mergeCapability(defaultCapabilityProfile(), input.capability),
    references: input.references ?? [],
    expectedArtifacts: input.expectedArtifacts ?? [],
    optional: input.optional ?? false
  }
}

/** Sets the size of a copy of the ticket: null removes the key (never stored as null), undefined keeps it. */
function resized(ticket: TicketContent, size: TicketSize | null | undefined): TicketContent {
  const next = { ...ticket }
  if (size === null) {
    delete next.size
  } else if (size !== undefined) {
    next.size = size
  }
  return next
}

/** Applies a patch to a ticket; a null `size` or `capability.reasoning.effort` removes that key. */
export function patchTicket(ticket: TicketContent, patch: Partial<TicketInput>): TicketContent {
  const patched: TicketContent = {
    ...ticket,
    title: patch.title === undefined ? ticket.title : patch.title.trim(),
    body: patch.body ?? ticket.body,
    acceptanceCriteria:
      patch.acceptanceCriteria === undefined
        ? ticket.acceptanceCriteria
        : normalizeCriteria(patch.acceptanceCriteria, ticket.acceptanceCriteria, 'c'),
    tags: patch.tags === undefined ? ticket.tags : normalizeTags(patch.tags),
    priority: patch.priority ?? ticket.priority,
    capability: mergeCapability(ticket.capability, patch.capability),
    references: patch.references ?? ticket.references,
    expectedArtifacts: patch.expectedArtifacts ?? ticket.expectedArtifacts,
    optional: patch.optional ?? ticket.optional
  }
  return resized(patched, patch.size)
}

export function buildSprint(input: SprintInput, identity: { id: string; ordinal: number }): SprintDef {
  return {
    id: identity.id,
    ordinal: identity.ordinal,
    goal: input.goal.trim(),
    ticketIds: [],
    entryCriteria: normalizeCriteria(input.entryCriteria ?? [], [], 'n'),
    exitCriteria: normalizeCriteria(input.exitCriteria ?? [], [], 'x'),
    concurrencyCap: input.concurrencyCap ?? null,
    checkpoint: input.checkpoint ?? { mode: 'human' }
  }
}

export function patchSprint(sprint: SprintDef, patch: Partial<SprintInput>): SprintDef {
  return {
    ...sprint,
    goal: patch.goal === undefined ? sprint.goal : patch.goal.trim(),
    entryCriteria:
      patch.entryCriteria === undefined
        ? sprint.entryCriteria
        : normalizeCriteria(patch.entryCriteria, sprint.entryCriteria, 'n'),
    exitCriteria:
      patch.exitCriteria === undefined
        ? sprint.exitCriteria
        : normalizeCriteria(patch.exitCriteria, sprint.exitCriteria, 'x'),
    concurrencyCap: patch.concurrencyCap === undefined ? sprint.concurrencyCap : patch.concurrencyCap,
    checkpoint: patch.checkpoint ?? sprint.checkpoint
  }
}

export function createInitialBundle(epic: EpicContent, firstSprintId: string): PlanBundle {
  return {
    formatVersion: PLAN_FORMAT_VERSION,
    epic,
    tickets: [],
    sprints: [buildSprint({ goal: '' }, { id: firstSprintId, ordinal: 1 })],
    edges: [],
    relations: [],
    policies: { ...DEFAULT_POLICIES },
    rationale: ''
  }
}

export function cloneBundle(bundle: PlanBundle): PlanBundle {
  return structuredClone(bundle)
}

/** Highest numeric suffix among `PREFIX-n` ticket keys. */
export function maxKeyNumber(keys: Iterable<string>): number {
  let max = 0
  for (const key of keys) {
    const match = /-(\d+)$/.exec(key)
    if (match) {
      max = Math.max(max, Number.parseInt(match[1] ?? '0', 10))
    }
  }
  return max
}
