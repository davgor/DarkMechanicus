/**
 * Learning records: the prevention rules a person publishes by approving a sprint's generated learning card.
 *
 * An agent proposes a `LearningDraft`; it carries the rule, the check that proves it is followed, where it applies
 * (roles, workflow events, repository path globs) and the immutable source evidence it was derived from, by id and
 * content hash. Publication binds the draft to the card attempt a person approved (`LearningSource`) and gives it an
 * id: a `LearningRecord`. Its definition never changes afterwards; only its lifecycle does (active → retired, possibly
 * by a replacement). Every object is strict: a field the contract does not name (an `authority`, a priority, an
 * always-apply flag) is refused rather than carried, so evidence and proposals never grant authority.
 *
 * Free of Node-only imports: the desktop shares it.
 */
import { z } from 'zod'

/** Limits a draft and a record are held to; the whole definition is bounded too, not only each field. */
export const LEARNING_LIMITS = {
  titleChars: 120,
  ruleChars: 2000,
  checkChars: 1000,
  pathChars: 256,
  paths: 32,
  evidence: 50,
  sourceIdChars: 200,
  retiredReasonChars: 500,
  /** Characters of the definition (draft fields) serialized as JSON. */
  definitionChars: 16_384
} as const

/** Session roles a learning can address. Desktop, planner and reader sessions never receive one. */
const LEARNING_ROLES = ['orchestrator', 'worker'] as const

/** Workflow events a learning can attach to: exactly the knowledge vocabulary of `src/core/knowledge/events.ts`. */
export const LEARNING_EVENTS = [
  'run.started',
  'ticket.claimed',
  'acceptance.claimed',
  'attempt.accepted',
  'attempt.rejected',
  'attempt.failed',
  'row_check.failed',
  'sprint.reported',
  'checkpoint.approved',
  'kanban.claimed',
  'run.recovery'
] as const

/** The kinds of sprint evidence a learning card collects; a learning cites the items it rests on by kind and id. */
const LEARNING_SOURCE_KINDS = [
  'rejected_attempt',
  'failed_attempt',
  'reconciled_attempt',
  'failed_row_check',
  'failed_acceptance_check',
  'retro_went_poorly',
  'retro_action'
] as const

export const LEARNING_STATES = ['active', 'retired'] as const
type LearningState = (typeof LEARNING_STATES)[number]

/**
 * States of the recoverable integration that publishes an approved card's records: prepared results, target updates
 * in progress, every update landed, records published; or stopped on a conflict or abort with nothing published.
 */
export const LEARNING_INTEGRATION_STATES = ['prepared', 'integrating', 'integrated', 'published', 'conflicted', 'aborted'] as const
type LearningIntegrationState = (typeof LEARNING_INTEGRATION_STATES)[number]

/** Integrations in these states still own their card: at most one of them exists per card. */
export const LEARNING_INTEGRATION_OPEN_STATES: readonly LearningIntegrationState[] = ['prepared', 'integrating', 'integrated']

const STABLE_ID_BODY = '[0-9a-hjkmnp-tv-z]{26}'
const idOf = (prefix: string): z.ZodString => z.string().regex(new RegExp(`^${prefix}_${STABLE_ID_BODY}$`), `Not a ${prefix}_ id`)

const learningId = idOf('lr')
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'Not a sha256 content hash')
const timestamp = z.iso.datetime()

/** One line, no control characters, no surrounding whitespace. */
const LINE = /^[^\s\p{Cc}](?:[^\p{Cc}]*[^\s\p{Cc}])?$/u
/** Several lines: control characters other than newline and tab are refused. */
const MULTILINE = /^[^\s\p{Cc}](?:[^\p{Cc}]|[\n\t])*$/u

const line = (max: number) => z.string().max(max).regex(LINE, 'Must be one non-empty line without control characters')
const paragraph = (max: number) =>
  z.string().max(max).regex(MULTILINE, 'Must be non-empty text without control characters').refine((text) => text.trim() === text, 'Must not start or end with whitespace')

/**
 * A repository-relative POSIX path or glob: no absolute, home or drive-qualified path, no backslash or colon, no
 * empty, `.` or `..` segment, and no control character. Glob characters (`*`, `?`, `[]`, `{}`) are allowed.
 */
export function isSafeLearningPath(path: string): boolean {
  if (path.length === 0 || path.length > LEARNING_LIMITS.pathChars) return false
  if (/[\p{Cc}\\:]/u.test(path) || path.startsWith('~')) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

const uniqueList = <T extends z.ZodType>(item: T, min: number, max: number) =>
  z.array(item).min(min).max(max).refine((items) => new Set(items).size === items.length, 'Must not repeat an entry')

const applicabilitySchema = z.strictObject({
  roles: uniqueList(z.enum(LEARNING_ROLES), 1, LEARNING_ROLES.length),
  /** Empty: the learning applies whatever the event. */
  events: uniqueList(z.enum(LEARNING_EVENTS), 0, LEARNING_EVENTS.length),
  /** Empty: the learning applies whatever the paths. */
  paths: uniqueList(z.string().refine(isSafeLearningPath, 'Must be a safe repository-relative path'), 0, LEARNING_LIMITS.paths)
})

/** One immutable sprint evidence item a learning rests on: its kind, its stable id and the hash of its content. */
const evidenceRefSchema = z.strictObject({
  kind: z.enum(LEARNING_SOURCE_KINDS),
  sourceId: z.string().max(LEARNING_LIMITS.sourceIdChars).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'Not a source evidence id'),
  contentHash: sha256
})

const draftShape = {
  title: line(LEARNING_LIMITS.titleChars),
  /** The prevention rule, as an instruction to the addressed roles. */
  rule: paragraph(LEARNING_LIMITS.ruleChars),
  /** How a reviewer or a test proves the rule was followed. */
  check: paragraph(LEARNING_LIMITS.checkChars),
  applicability: applicabilitySchema,
  evidence: z
    .array(evidenceRefSchema)
    .min(1, 'A learning must cite the evidence it comes from')
    .max(LEARNING_LIMITS.evidence)
    .refine((refs) => new Set(refs.map((ref) => `${ref.kind}\u0000${ref.sourceId}`)).size === refs.length, 'Must not cite an evidence item twice'),
  /** The active learning this one replaces once published; null for a new one. */
  replaces: learningId.nullable()
}

function withinDefinitionLimit(definition: Record<string, unknown>): boolean {
  const fields = Object.fromEntries(Object.keys(draftShape).map((key) => [key, definition[key]]))
  return JSON.stringify(fields).length <= LEARNING_LIMITS.definitionChars
}

/** What a learning-card worker proposes. Publication, not the worker, supplies the id, source and lifecycle. */
export const learningDraftSchema = z
  .strictObject(draftShape)
  .refine(withinDefinitionLimit, { message: `The learning exceeds ${LEARNING_LIMITS.definitionChars} characters` })
export type LearningDraft = z.infer<typeof learningDraftSchema>

/** The approved card attempt a learning was published from, and the run and sprint whose evidence it cites. */
const learningSourceSchema = z.strictObject({
  runId: idOf('rn'),
  sprintId: idOf('sp'),
  cardId: idOf('kc'),
  attemptId: idOf('ka')
})

const recordShape = {
  formatVersion: z.literal(1),
  id: learningId,
  ...draftShape,
  source: learningSourceSchema,
  state: z.enum(LEARNING_STATES),
  /** The learning that replaced this one; only a retired learning has one. */
  replacedBy: learningId.nullable(),
  createdAt: timestamp,
  retiredAt: timestamp.nullable(),
  retiredReason: line(LEARNING_LIMITS.retiredReasonChars).nullable()
}

interface LifecycleFields {
  id: string
  state: LearningState
  replaces: string | null
  replacedBy: string | null
  retiredAt: string | null
  retiredReason: string | null
}

const hasRetirement = (record: LifecycleFields): boolean =>
  record.retiredAt !== null || record.retiredReason !== null || record.replacedBy !== null

/** The lifecycle and link rules one record must keep on its own; set-wide rules are `learningLinkProblems`. */
function lifecycleIssues(record: LifecycleFields): string[] {
  const rules: [broken: boolean, message: string][] = [
    [record.replaces === record.id || record.replacedBy === record.id, 'A learning cannot replace itself'],
    [record.replaces !== null && record.replaces === record.replacedBy, 'A learning cannot replace the learning that replaced it'],
    [record.state === 'active' && hasRetirement(record), 'An active learning has no retirement or replacement'],
    [record.state === 'retired' && record.retiredAt === null, 'A retired learning records when it was retired']
  ]
  return rules.filter(([broken]) => broken).map(([, message]) => message)
}

/** A published learning. Its definition and source never change; `state`, `replacedBy` and retirement do. */
export const learningRecordSchema = z
  .strictObject(recordShape)
  .refine(withinDefinitionLimit, { message: `The learning exceeds ${LEARNING_LIMITS.definitionChars} characters` })
  .superRefine((record, ctx) => {
    for (const message of lifecycleIssues(record)) ctx.addIssue({ code: 'custom', message })
  })
export type LearningRecord = z.infer<typeof learningRecordSchema>

type LinkProblemKind = 'duplicate_id' | 'missing_target' | 'not_reciprocal' | 'replaced_twice' | 'cycle'

/** A set-wide replacement link problem, naming the record it was found on. */
interface LearningLinkProblem {
  id: string
  problem: LinkProblemKind
}

type LinkFields = Pick<LearningRecord, 'id' | 'state' | 'replaces' | 'replacedBy'>

function forwardLinkProblem(record: LinkFields, byId: ReadonlyMap<string, LinkFields>): LinkProblemKind | null {
  if (record.replaces === null) return null
  const target = byId.get(record.replaces)
  if (!target) return 'missing_target'
  return target.replacedBy === record.id && target.state === 'retired' ? null : 'not_reciprocal'
}

function backLinkProblem(record: LinkFields, byId: ReadonlyMap<string, LinkFields>): LinkProblemKind | null {
  if (record.replacedBy === null) return null
  const successor = byId.get(record.replacedBy)
  if (!successor) return 'missing_target'
  return successor.replaces === record.id ? null : 'not_reciprocal'
}

function inCycle(record: LinkFields, byId: ReadonlyMap<string, LinkFields>): boolean {
  const seen = new Set<string>([record.id])
  let next = record.replaces
  while (next !== null) {
    if (seen.has(next)) return next === record.id
    seen.add(next)
    next = byId.get(next)?.replaces ?? null
  }
  return false
}

/** How many records of the set name each id as the learning they replace. */
function replacementCounts(records: readonly LinkFields[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const { replaces } of records) {
    if (replaces !== null) counts.set(replaces, (counts.get(replaces) ?? 0) + 1)
  }
  return counts
}

/**
 * The replacement link problems of a complete set of learnings, in record order: duplicate ids, links to a learning
 * not in the set, one-sided links (A replaces B but B is not retired by A, or the reverse), a learning replaced twice,
 * and replacement cycles. An empty list means the set's links are consistent.
 */
export function learningLinkProblems(records: readonly LinkFields[]): LearningLinkProblem[] {
  const byId = new Map(records.map((record) => [record.id, record]))
  const replaced = replacementCounts(records)
  const seen = new Set<string>()
  return records.flatMap((record) => {
    const duplicate = seen.has(record.id)
    seen.add(record.id)
    const found: (LinkProblemKind | null)[] = [
      duplicate ? 'duplicate_id' : null,
      forwardLinkProblem(record, byId),
      backLinkProblem(record, byId),
      (replaced.get(record.id) ?? 0) > 1 ? 'replaced_twice' : null,
      inCycle(record, byId) ? 'cycle' : null
    ]
    return found.filter((problem) => problem !== null).map((problem) => ({ id: record.id, problem }))
  })
}

// ─── Sprint learning evidence snapshot ─────────────────────────────────────────────────────────────────────────────
//
// The immutable facts a sprint's learning card is generated from, collected by `src/core/services/learningEvidence.ts`
// from the run's pinned revision, its attempts and row checks, and the sprint's latest report revision. Every item is a
// stored fact quoted verbatim (`statements`), never a reporter's paraphrase; classification happens later, on the card.

export type LearningSourceKind = (typeof LEARNING_SOURCE_KINDS)[number]

/** One stored text the item rests on, quoted verbatim, with the field it was read from (such as `decision.reasons`). */
const evidenceStatementSchema = z.strictObject({
  field: z.string().min(1),
  text: z.string().min(1)
})

/** Where an item came from. Fields that do not apply to its kind are null. */
const evidenceProvenanceSchema = z.strictObject({
  runId: idOf('rn'),
  sprintId: idOf('sp'),
  /** The run's pinned plan revision the collector read. */
  revisionId: idOf('rv'),
  ticketId: idOf('tk').nullable(),
  /** The ticket's display key in the pinned revision. */
  ticketKey: z.string().min(1).nullable(),
  attemptId: idOf('at').nullable(),
  attemptNumber: z.number().int().min(1).nullable(),
  rowCheckId: idOf('rk').nullable(),
  row: z.number().int().min(1).nullable(),
  /** The row check's number in the run (the highest number of a row is its latest check). */
  checkNumber: z.number().int().min(1).nullable(),
  reportId: idOf('rp').nullable(),
  reportRevision: z.number().int().min(1).nullable()
})

const evidenceItemSchema = z.strictObject({
  kind: z.enum(LEARNING_SOURCE_KINDS),
  /** Stable within the run: the source record's id, plus the field and index of the entry for list entries. */
  sourceId: evidenceRefSchema.shape.sourceId,
  /** Hash of the whole item except this field: what a learning cites as `evidence[].contentHash`. */
  contentHash: sha256,
  /** Hash of the kind and the normalized statements only, so the same lesson seen twice can be deduplicated. */
  fingerprint: sha256,
  occurredAt: timestamp,
  /**
   * Whether the fact still stands: false for an attempt superseded by a plan adoption, for a row check a later check
   * of the same row replaced, and for an acceptance node's checks from an attempt other than its latest one.
   */
  standing: z.boolean(),
  provenance: evidenceProvenanceSchema,
  /** Repositories of a folder of repositories the item concerns, sorted; empty when unknown or single-repository. */
  repositories: z.array(z.string().min(1)),
  /** Repository-relative paths the item concerns (an attempt's changed files), sorted; empty when unknown. */
  paths: z.array(z.string().refine(isSafeLearningPath, 'Must be a safe repository-relative path')),
  /** May be empty: the fact itself (an attempt was rejected) stands even when nothing was written about it. */
  statements: z.array(evidenceStatementSchema)
})
export type LearningEvidenceItem = z.infer<typeof evidenceItemSchema>

/**
 * The evidence of one sprint of one run. Items are ordered by kind (`LEARNING_SOURCE_KINDS` order), then
 * `occurredAt`, then `sourceId`, so collecting unchanged state twice gives the same bytes. A sprint without negative
 * evidence has no items and is still a valid snapshot.
 */
export const learningEvidenceSnapshotSchema = z.strictObject({
  formatVersion: z.literal(1),
  runId: idOf('rn'),
  sprintId: idOf('sp'),
  sprintOrdinal: z.number().int().min(1),
  revisionId: idOf('rv'),
  /** The sprint's latest report revision the items were read from; null when none was submitted. */
  report: z
    .strictObject({ id: idOf('rp'), reportRevision: z.number().int().min(1), contentHash: sha256, createdAt: timestamp })
    .nullable(),
  items: z.array(evidenceItemSchema),
  /** Hash of the whole snapshot except this field. */
  contentHash: sha256
})
export type LearningEvidenceSnapshot = z.infer<typeof learningEvidenceSnapshotSchema>

/** Every evidence kind, in the order a snapshot lists them. */
export const LEARNING_EVIDENCE_KINDS: readonly LearningSourceKind[] = LEARNING_SOURCE_KINDS

// ─── End of sprint learning evidence snapshot ──────────────────────────────────────────────────────────────────────

// Human management of published learnings: reads for every role; retirement and replacement for the person alone.

/** Why a person retires or replaces a learning: one line, kept as its retirement reason and in its history. */
export const learningReasonSchema = line(LEARNING_LIMITS.retiredReasonChars)

/**
 * The new content of a replacement. The successor keeps its predecessor's evidence and source, so a replacement
 * changes what the rule says and where it applies, never what it was derived from.
 */
export const learningReplacementContentSchema = z.strictObject({
  title: draftShape.title,
  rule: draftShape.rule,
  check: draftShape.check,
  applicability: applicabilitySchema
})
export type LearningReplacementContent = z.infer<typeof learningReplacementContentSchema>

/**
 * DM-943: one integration operation of a sprint learning card as people read it. Built from the portable manifest; the
 * machine-local native plan and each repository's identity token are never part of it.
 */
export interface LearningIntegrationSummaryView {
  operationId: string
  state: LearningIntegrationState
  /** Why a `conflicted` or `aborted` integration stopped; null otherwise. */
  failure: { code: string; message: string } | null
  targets: {
    /** The child repository of a folder of repositories; null for the project's own repository. */
    repository: string | null
    /** The target branch the guardrails land on. */
    branch: string
    /** The completed increment commit the isolated learnings branch was rooted at. */
    baseCommit: string
    /** The target head the integration moves from, while this machine still holds the plan; otherwise null. */
    oldHead: string | null
    /** The target head after the guardrails landed; null until this repository is integrated. */
    newHead: string | null
    state: LearningIntegrationTargetState
  }[]
}

/**
 * A stored learning with the revision a retirement or replacement must name, and its definition's content hash.
 * `integration` (DM-943) is the published integration of the source card, so a successor keeps its predecessor's
 * provenance; absent when the source card has no published integration on this clone.
 */
export type LearningView = LearningRecord & { revision: number; definitionHash: string; integration?: LearningIntegrationSummaryView }

/** What a learning card's agent staged for one attempt: the drafts, the hash a reviewer approves, the cited evidence. */
export interface StagedLearningDraftsView {
  cardId: string
  attemptId: string
  runId: string
  sprintId: string
  snapshotHash: string
  drafts: LearningDraft[]
  draftsHash: string
  evidence: LearningEvidenceItem[]
  stagedBy: { role: string; label: string }
  stagedAt: string
}

/** What an entry of a learning's append-only history records. */
export const LEARNING_HISTORY_KINDS = ['published', 'retired', 'replaced', 'created_by_replacement'] as const
type LearningHistoryKind = (typeof LEARNING_HISTORY_KINDS)[number]

/** One append-only history entry: who changed the learning, why, its revision afterwards and its source links. */
export interface LearningHistoryEntryView {
  seq: number
  learningId: string
  kind: LearningHistoryKind
  /** The successor of a `replaced` entry, the predecessor of a `created_by_replacement` one; otherwise null. */
  relatedId: string | null
  reason: string
  revision: number
  actor: { role: string; label: string }
  source: LearningRecord['source']
  at: string
}

export interface LearningDetailView {
  learning: LearningView
  history: LearningHistoryEntryView[]
}

type LearningListState = LearningState | 'all'

export interface ListLearningsInput {
  /** Default `active`: retired learnings are listed only when asked for. */
  state?: LearningListState
  /** Words that must all appear in a learning's content or its history, case-insensitively. */
  query?: string
  limit?: number
}

export interface RetireLearningInput {
  learningId: string
  expectedRevision: number
  reason: string
  idempotencyKey?: string
}

export interface ReplaceLearningInput extends RetireLearningInput {
  replacement: LearningReplacementContent
}

export interface ReplaceLearningResultView {
  retired: LearningView
  replacement: LearningView
}

// DM-936: published learnings as execution context. Selection is bounded by its own budget and reports omissions;
// an item carries text and provenance only, never applicability, lifecycle or any field that could read as authority.

/** One active learning selected into a worker packet or an orchestrator's knowledge context. */
interface LearningContextItemView {
  id: string
  title: string
  rule: string
  check: string
  /** The approved card attempt the learning was published from. */
  source: LearningRecord['source']
}

/** The learnings selected for one role, event and set of paths, and the matches the learnings' budget left out. */
export interface LearningContextView {
  learnings: LearningContextItemView[]
  omitted: { id: string; title: string; tokens: number }[]
  usedTokens: number
  budgetTokens: number
}

// ─── DM-937: generated sprint learning cards ───────────────────────────────────────────────────────────────────────

/** The completed increment of one affected repository a sprint learning card was generated against. */
interface LearningIncrementBase {
  /** In a folder of repositories: the child repository; null in a single repository. */
  repo: string | null
  branch: string
  commit: string
  /** The acceptance-node attempt that named the increment. */
  attemptId: string
}

/**
 * The one learning card a successful checkpoint advance generated for a sprint of a run, as the run and the advance
 * show it. The owning orchestrator claims it before polling the next sprint; it never gates the next sprint.
 */
export interface SprintLearningCardView {
  cardId: string
  key: string
  epicId: string
  runId: string
  sprintId: string
  reportId: string
  revisionId: string | null
  checkpointId: string | null
  /** `contentHash` of the stored evidence snapshot. */
  evidenceHash: string
  /** Items in the snapshot; zero for a sprint without negative evidence. */
  evidenceItems: number
  bases: LearningIncrementBase[]
  lane: 'backlog' | 'in_progress' | 'ready_for_review' | 'done'
  /** Queued for the orchestrator and not yet claimed. */
  playPending: boolean
  createdAt: string
}

// ─── End of DM-937 ─────────────────────────────────────────────────────────────────────────────────────────────────

// ─── DM-935: learning integration recovery manifest ────────────────────────────────────────────────────────────────
//
// What a recoverable integration of an approved learning card must remember to resume after a restart or on another
// clone: which approved attempt and exact drafts it publishes, and where each repository's update starts and landed.
// A manifest never carries the learnings themselves: only publication creates learning records, so a manifest in any
// state, imported or not, never makes a learning active.

/** Where one repository's update stands: waiting, being applied, landed at `resultCommit`, or stopped on a conflict. */
const LEARNING_TARGET_STATES = ['pending', 'integrating', 'integrated', 'conflicted'] as const
type LearningIntegrationTargetState = (typeof LEARNING_TARGET_STATES)[number]

const commitId = z.string().regex(/^[0-9a-f]{7,64}$/, 'Not a commit hash')

const integrationTargetSchema = z
  .strictObject({
    /** The child repository of a folder of repositories; null for the project's own repository. */
    repository: z.string().min(1).max(255).regex(/^[^/\\\p{Cc}]+$/u, 'Must be one folder name').refine((name) => name !== '.' && name !== '..', 'Must be one folder name').nullable(),
    branch: line(255),
    baseCommit: commitId,
    resultCommit: commitId.nullable(),
    state: z.enum(LEARNING_TARGET_STATES)
  })
  .refine((target) => (target.state === 'integrated') === (target.resultCommit !== null), 'Only an integrated target has a result commit')

/** The recovery manifest stored as `learning_integrations.manifest_json`; `manifest_hash` is its `contentHash`. */
export const learningIntegrationManifestSchema = z.strictObject({
  formatVersion: z.literal(1),
  cardId: idOf('kc'),
  attemptId: idOf('ka'),
  runId: idOf('rn'),
  sprintId: idOf('sp'),
  /** The exact staged drafts the person approved (`learning_stagings.drafts_hash`). */
  draftsHash: sha256,
  targets: z
    .array(integrationTargetSchema)
    .min(1)
    .max(64)
    .refine((targets) => new Set(targets.map((target) => target.repository ?? '')).size === targets.length, 'Must not name a repository twice')
})
export type LearningIntegrationManifest = z.infer<typeof learningIntegrationManifestSchema>

/** Why an integration stopped: set only for a `conflicted` or `aborted` one. */
export const learningIntegrationFailureSchema = z.strictObject({
  code: line(100),
  message: paragraph(2000)
})

// ─── End DM-935 ───
