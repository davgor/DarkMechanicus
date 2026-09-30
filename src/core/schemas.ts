import { z } from 'zod'
import {
  CHECKPOINT_MODES,
  MODALITIES,
  PLAN_FORMAT_VERSION,
  REASONING_LEVELS,
  REFERENCE_KINDS,
  RELATION_KINDS,
  TICKET_FAILURE_POLICIES,
  TICKET_PRIORITIES,
  TOOL_CAPABILITIES,
  WORK_TYPES
} from '../shared/domain/bundle'
import { WORK_STATUSES } from '../shared/domain/status'
import { DomainError } from './errors'
import { STABLE_ID_PATTERN } from './ids'
import { CRITERION_ID_PATTERN } from './plan/normalize'

/** Size limits applied to every untrusted input: tool calls, IPC payloads, and imported records. */
export const LIMITS = {
  title: 300,
  shortText: 2_000,
  markdown: 100_000,
  label: 200,
  criteria: 100,
  tags: 50,
  tag: 64,
  references: 100,
  tickets: 1_000,
  sprints: 100,
  edges: 10_000,
  relations: 5_000,
  opsPerRequest: 500,
  listItems: 500,
  models: 200,
  /** Characters in one comment's Markdown body. */
  comment: 20_000,
  /** Comments one epic may hold (the importer reads at most this many per epic). */
  commentsPerEpic: 10_000
} as const

export const stableId = z.string().regex(STABLE_ID_PATTERN, 'Expected a stable id such as tk_…')
/** A stable id, a ticket key, or a client-local ref declared in the same request. */
export const entityRef = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/)
export const idempotencyKey = z.string().min(1).max(200).optional()

/** A comment's Markdown: not blank, at most `LIMITS.comment` characters, whitespace kept as written. */
export const commentBody = z
  .string()
  .max(LIMITS.comment, `A comment is at most ${LIMITS.comment} characters.`)
  .refine((body) => body.trim() !== '', 'A comment needs some text.')

const title = z.string().max(LIMITS.title)
const markdown = z.string().max(LIMITS.markdown)
const shortText = z.string().max(LIMITS.shortText)
const textList = z.array(shortText).max(LIMITS.listItems)

export const criterion = z.strictObject({
  id: z.string().regex(CRITERION_ID_PATTERN),
  text: shortText
})

export const criterionInput = z.union([
  shortText,
  z.strictObject({ id: z.string().regex(CRITERION_ID_PATTERN).optional(), text: shortText })
])
const criterionInputs = z.array(criterionInput).max(LIMITS.criteria)

const tags = z.array(z.string().max(LIMITS.tag)).max(LIMITS.tags)

export const capabilityProfile = z.strictObject({
  workType: z.enum(WORK_TYPES),
  reasoning: z.strictObject({ level: z.enum(REASONING_LEVELS), rationale: shortText }),
  skills: tags,
  modalities: z.array(z.enum(MODALITIES)).max(MODALITIES.length),
  tools: z.array(z.enum(TOOL_CAPABILITIES)).max(TOOL_CAPABILITIES.length),
  context: z.strictObject({
    estimatedInputTokens: z.number().int().min(0).max(100_000_000).nullable(),
    requiredArtifacts: z.array(z.string().max(LIMITS.label)).max(LIMITS.references)
  }),
  constraints: z.strictObject({
    environments: z.array(z.string().max(LIMITS.label)).max(LIMITS.tags),
    dataLocation: z.string().max(LIMITS.label).nullable(),
    maxDurationMinutes: z.number().int().min(1).max(100_000).nullable(),
    maxCostUsd: z.number().min(0).max(1_000_000).nullable()
  }),
  preferences: z.strictObject({
    quality: z.enum(['standard', 'high']).nullable(),
    latency: z.enum(['low', 'normal']).nullable(),
    cost: z.enum(['low', 'normal']).nullable(),
    autonomy: z.enum(['supervised', 'autonomous']).nullable(),
    modelOverride: z.string().max(LIMITS.label).nullable()
  })
})

export const capabilityPatch = z.strictObject({
  workType: capabilityProfile.shape.workType.optional(),
  reasoning: capabilityProfile.shape.reasoning.partial().optional(),
  skills: tags.optional(),
  modalities: capabilityProfile.shape.modalities.optional(),
  tools: capabilityProfile.shape.tools.optional(),
  context: capabilityProfile.shape.context.partial().optional(),
  constraints: capabilityProfile.shape.constraints.partial().optional(),
  preferences: capabilityProfile.shape.preferences.partial().optional()
})

export const ticketReference = z.strictObject({
  kind: z.enum(REFERENCE_KINDS),
  label: z.string().max(LIMITS.label),
  location: z.string().max(LIMITS.shortText),
  hash: z.string().max(200).nullable(),
  remoteOnly: z.boolean()
})

export const ticketInput = z.strictObject({
  title: title.min(1),
  body: markdown.optional(),
  acceptanceCriteria: criterionInputs.optional(),
  tags: tags.optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  capability: capabilityPatch.optional(),
  references: z.array(ticketReference).max(LIMITS.references).optional(),
  expectedArtifacts: z.array(z.string().max(LIMITS.label)).max(LIMITS.references).optional(),
  optional: z.boolean().optional()
})

const concurrencyCap = z.number().int().min(1).max(1_000).nullable()

export const sprintInput = z.strictObject({
  goal: shortText,
  entryCriteria: criterionInputs.optional(),
  exitCriteria: criterionInputs.optional(),
  concurrencyCap: concurrencyCap.optional(),
  checkpoint: z.strictObject({ mode: z.enum(CHECKPOINT_MODES) }).optional()
})

export const policiesPatch = z.strictObject({
  maxConcurrency: concurrencyCap.optional(),
  retryLimit: z.number().int().min(1).max(100).optional(),
  onTicketFailure: z.enum(TICKET_FAILURE_POLICIES).optional(),
  leaseSeconds: z.number().int().min(30).max(86_400).optional()
})

const clientRef = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/).optional()
const position = z.number().int().min(0).max(LIMITS.tickets).optional()

export const draftOp = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('set_epic'),
    title: title.min(1).optional(),
    intent: markdown.optional(),
    successCriteria: criterionInputs.optional(),
    ownerRole: z.string().max(LIMITS.label).nullable().optional()
  }),
  z.strictObject({ op: z.literal('add_sprint'), ref: clientRef, sprint: sprintInput, position }),
  z.strictObject({ op: z.literal('update_sprint'), sprint: entityRef, patch: sprintInput.partial() }),
  z.strictObject({ op: z.literal('remove_sprint'), sprint: entityRef }),
  z.strictObject({ op: z.literal('add_ticket'), ref: clientRef, sprint: entityRef, ticket: ticketInput }),
  z.strictObject({ op: z.literal('update_ticket'), ticket: entityRef, patch: ticketInput.partial() }),
  z.strictObject({ op: z.literal('remove_ticket'), ticket: entityRef }),
  z.strictObject({ op: z.literal('move_ticket'), ticket: entityRef, toSprint: entityRef, position }),
  z.strictObject({ op: z.literal('add_dependency'), from: entityRef, to: entityRef }),
  z.strictObject({ op: z.literal('remove_dependency'), from: entityRef, to: entityRef }),
  z.strictObject({ op: z.literal('add_relation'), kind: z.enum(RELATION_KINDS), from: entityRef, to: entityRef }),
  z.strictObject({ op: z.literal('remove_relation'), kind: z.enum(RELATION_KINDS), from: entityRef, to: entityRef }),
  z.strictObject({ op: z.literal('set_policies'), patch: policiesPatch }),
  z.strictObject({ op: z.literal('set_rationale'), rationale: markdown })
])

export const draftOps = z.array(draftOp).min(1).max(LIMITS.opsPerRequest)

export const ticketKey = z.string().min(1).max(40).regex(/^[A-Za-z0-9]{1,12}-\d{1,9}$/)

export const ticketContent = z.strictObject({
  id: stableId,
  key: ticketKey,
  title: title.min(1),
  body: markdown,
  acceptanceCriteria: z.array(criterion).max(LIMITS.criteria),
  tags,
  priority: z.enum(TICKET_PRIORITIES),
  capability: capabilityProfile,
  references: z.array(ticketReference).max(LIMITS.references),
  expectedArtifacts: z.array(z.string().max(LIMITS.label)).max(LIMITS.references),
  optional: z.boolean()
})

export const sprintDef = z.strictObject({
  id: stableId,
  ordinal: z.number().int().min(1).max(LIMITS.sprints),
  goal: shortText,
  ticketIds: z.array(stableId).max(LIMITS.tickets),
  entryCriteria: z.array(criterion).max(LIMITS.criteria),
  exitCriteria: z.array(criterion).max(LIMITS.criteria),
  concurrencyCap,
  checkpoint: z.strictObject({ mode: z.enum(CHECKPOINT_MODES) })
})

const edge = z.strictObject({ from: stableId, to: stableId })

/** Full plan bundle as stored in drafts, snapshots, and Git-tracked records. */
export const planBundle = z.strictObject({
  formatVersion: z.literal(PLAN_FORMAT_VERSION),
  epic: z.strictObject({
    title: title.min(1),
    intent: markdown,
    successCriteria: z.array(criterion).max(LIMITS.criteria),
    ownerRole: z.string().max(LIMITS.label).nullable()
  }),
  tickets: z.array(ticketContent).max(LIMITS.tickets),
  sprints: z.array(sprintDef).min(1).max(LIMITS.sprints),
  edges: z.array(edge).max(LIMITS.edges),
  relations: z
    .array(z.strictObject({ kind: z.enum(RELATION_KINDS), from: stableId, to: stableId }))
    .max(LIMITS.relations),
  policies: z.strictObject({
    maxConcurrency: concurrencyCap,
    retryLimit: z.number().int().min(1).max(100),
    onTicketFailure: z.enum(TICKET_FAILURE_POLICIES),
    leaseSeconds: z.number().int().min(30).max(86_400)
  }),
  rationale: markdown
})

export const epicBranch = z.strictObject({
  repository: z.string().max(LIMITS.shortText).nullable(),
  // A subset of git check-ref-format: no whitespace or ~^:?*[\, no leading dash, "..", "@{",
  // trailing "/", "." or ".lock".
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*(?:\/|\.|\.lock)$)[^\s~^:?*[\\]+$/, 'Not a valid branch name'),
  startCommit: z.string().regex(/^[0-9a-f]{7,64}$/).nullable()
})

export const workStatus = z.enum(WORK_STATUSES)

export const criterionResult = z.strictObject({
  criterionId: z.string().regex(CRITERION_ID_PATTERN),
  met: z.boolean(),
  note: shortText.default('')
})

export const checkResult = z.strictObject({
  name: z.string().max(LIMITS.label),
  status: z.enum(['passed', 'failed', 'skipped']),
  detail: shortText.default('')
})

export const artifactRef = z.strictObject({
  label: z.string().max(LIMITS.label),
  location: z.string().max(LIMITS.shortText),
  hash: z.string().max(200).nullable().default(null),
  remoteOnly: z.boolean().default(false)
})

export const attemptOutputsInput = z.strictObject({
  summary: markdown,
  artifacts: z.array(artifactRef).max(LIMITS.references).optional(),
  commits: z.array(z.string().max(200)).max(LIMITS.listItems).optional(),
  changedFiles: z.array(z.string().max(LIMITS.shortText)).max(5_000).optional(),
  branch: z.string().max(255).nullable().optional()
})

export const attemptEvidenceInput = z.strictObject({
  checks: z.array(checkResult).max(LIMITS.listItems).optional(),
  criteria: z.array(criterionResult).max(LIMITS.criteria).optional(),
  notes: markdown.optional()
})

export const sprintReportInput = z.strictObject({
  summary: markdown,
  accepted: textList.optional(),
  failed: textList.optional(),
  blocked: textList.optional(),
  changes: z
    .strictObject({ files: z.array(z.string().max(LIMITS.shortText)).max(5_000), commits: textList })
    .optional(),
  checks: z.array(checkResult).max(LIMITS.listItems).optional(),
  risks: textList.optional(),
  followUps: z
    .array(z.strictObject({ title: title.min(1), body: markdown.default('') }))
    .max(LIMITS.listItems)
    .optional(),
  exitCriteria: z.array(criterionResult).max(LIMITS.criteria).optional(),
  epicOutcome: z
    .strictObject({ summary: markdown, successCriteria: z.array(criterionResult).max(LIMITS.criteria) })
    .nullable()
    .optional()
})

export const hostCatalog = z.strictObject({
  hostId: z.string().min(1).max(LIMITS.label),
  hostType: z.string().min(1).max(LIMITS.label),
  catalogRevision: z.string().min(1).max(LIMITS.label),
  tools: z.array(z.string().max(LIMITS.tag)).max(LIMITS.tags),
  canSelectWorkerModel: z.boolean(),
  models: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(LIMITS.label),
        label: z.string().max(LIMITS.label).default(''),
        reasoningLevels: z.array(z.enum(REASONING_LEVELS)).max(REASONING_LEVELS.length),
        modalities: z.array(z.enum(MODALITIES)).max(MODALITIES.length),
        contextWindowTokens: z.number().int().min(1).nullable().default(null),
        skills: tags.default([]),
        costTier: z.enum(['low', 'normal', 'high']).nullable().default(null),
        latencyTier: z.enum(['low', 'normal', 'high']).nullable().default(null)
      })
    )
    .max(LIMITS.models)
})

/** Parses untrusted input or throws a structured `invalid_input` error naming the first problem. */
export function parseInput<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value)
  if (result.success) {
    return result.data
  }
  const issue = result.error.issues[0]
  const path = issue && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : ''
  throw new DomainError('invalid_input', `Invalid ${what}${path}: ${issue?.message ?? 'malformed input'}`)
}
