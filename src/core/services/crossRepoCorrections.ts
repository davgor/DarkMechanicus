/**
 * Corrective work a sprint retro asks of the Dark Mechanicus source (`src/shared/domain/crossRepoCorrections.ts`): the
 * core of the desktop broker (`src/main/desktop/crossRepoCorrections.ts`). Two sides, each run on its own project's
 * context, and neither reaches the other: the broker carries the fully specified draft (`CrossRepoPacket`) between them.
 *
 * - **Source** (the project whose retro holds the experiment): reads the experiment from the latest revision of its
 *   sprint report, builds the draft and its portable provenance, and keeps the request's receipt in `correction_links`:
 *   written `pending` (with the draft) before the target is written, `linked` once the target holds it.
 * - **Target** (the Dark Mechanicus source project): previews and creates one backlog epic per experiment, holding the
 *   draft and carrying the provenance; a repeat finds that epic by the key and returns it, and refuses another payload.
 *
 * No command, MCP tool or grant reaches these functions; the writes need the person's `correction.cross_repo`
 * capability, which no agent role holds. Nothing is saved, adopted, started or approved in either project: the source's
 * epic, runs, reports and scores are only read, and the target epic gets its own branch, runs and checkpoints when the
 * person sets them up there.
 */
import { z } from 'zod'
import { TICKET_SIZES, type CorrectionProvenance, type PlanBundle } from '../../shared/domain/bundle'
import type { CorrectionTicketView, CorrectionWorkEdit } from '../../shared/domain/corrections'
import type {
  CreateCrossRepoCorrectionInput,
  CrossRepoCarriedGrade,
  CrossRepoCorrectionInput,
  CrossRepoCorrectionLinkView,
  CrossRepoCorrectionState,
  CrossRepoCorrectionStep,
  CrossRepoResultsView,
  CrossRepoTargetEpicView
} from '../../shared/domain/crossRepoCorrections'
import { FINAL_EXPERIMENT_STATUSES, type RetroExperiment } from '../../shared/domain/experiments'
import type { ValidationReport } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import { contentHash } from '../canonical'
import type { Ctx } from '../context'
import { parseJson, toJson } from '../db/database'
import { DomainError, fail } from '../errors'
import { getMeta, META_KEYS } from '../meta'
import {
  applyCorrections,
  type AppliedCorrections,
  correctionKey,
  correctionsOf,
  type CorrectiveItem,
  correctiveItems,
  experimentContext,
  experimentGoal
} from '../plan/corrections'
import type { DraftDeps } from '../plan/draftOps'
import { executionProblems, gradesOf, readMeasure } from '../plan/experiments'
import { sortedSprints, validatePlan } from '../plan/graph'
import { createInitialBundle, normalizeCriteria } from '../plan/normalize'
import { correctionProvenance } from '../repo/portable'
import {
  createCrossRepoCorrectionInput,
  crossRepoCorrectionInput,
  crossRepoCorrectionKeyInput,
  crossRepoCorrectionListInput,
  LIMITS,
  parseInput
} from '../schemas'
import { loadSource, type Source } from './corrections'
import { draftDeps } from './draftDeps'
import { writeDraft } from './drafts'
import { createCorrectionEpic, type EpicRow, loadEpicRow } from './epics'
import { appendEvent } from './events'
import { type CarriedResults, correctionEpicResults } from './experimentOutcomes'
import { getExperiment } from './experiments'
import { currentSavedBundle, loadDraftRow } from './plans'
import { parseScorecardSnapshot, snapshotHashOf } from '../space/snapshot'

/** The project the corrective work is asked of, as the chosen checkout names it. */
interface CrossRepoTarget {
  projectId: string
}

/** The fully specified draft the target creates: decided in the source, carried by the broker, kept in the receipt. */
interface CrossRepoPacket {
  provenance: CorrectionProvenance
  epic: { title: string; intent: string; successCriteria: string[] }
  sprintGoal: string
  items: CorrectiveItem[]
  fireguard: boolean
}

const item = z.strictObject({
  ref: z.string().min(1).max(100),
  experimentId: z.string().min(1).max(100),
  index: z.number().int().min(0).max(LIMITS.listItems),
  title: z.string().min(1).max(LIMITS.title),
  body: z.string().max(LIMITS.markdown),
  size: z.enum(TICKET_SIZES).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(LIMITS.shortText)).min(1).max(LIMITS.criteria),
  tags: z.array(z.string().max(LIMITS.label)).max(LIMITS.listItems),
  repo: z.null(),
  dependsOn: z.array(z.strictObject({ work: z.strictObject({ experimentId: z.string().min(1).max(100), index: z.number().int().min(0) }) })).max(LIMITS.listItems)
})

/** The draft content of a packet; the source checks it before a receipt is written, so the target never refuses its shape. */
const contentSchema = z.strictObject({
  epic: z.strictObject({
    title: z.string().min(1).max(LIMITS.title),
    intent: z.string().max(LIMITS.markdown),
    successCriteria: z.array(z.string().min(1).max(LIMITS.shortText)).min(1).max(LIMITS.criteria)
  }),
  sprintGoal: z.string().max(LIMITS.shortText),
  items: z.array(item).min(1).max(LIMITS.listItems),
  fireguard: z.boolean()
})

/** A packet read back from a receipt or handed to the target is checked again: the target trusts no stored text. */
const packetSchema = contentSchema.extend({ provenance: correctionProvenance })

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  return `${issue?.path.join('.') || '?'}: ${issue?.message ?? 'invalid'}`
}

function parsePacket(raw: unknown): CrossRepoPacket {
  const parsed = packetSchema.safeParse(raw)
  if (!parsed.success) fail('invalid_input', `The corrective draft is malformed at ${firstIssue(parsed.error)}.`)
  return parsed.data as CrossRepoPacket
}

// ---------------------------------------------------------------------------------------------------------------
// Source: the experiment and its draft

/** The experiment as the request reads it, with everything its draft needs. */
interface Prepared {
  source: Source
  projectId: string
  projectName: string
  reportHash: string
  experiment: RetroExperiment
  edits: CorrectionWorkEdit[]
  /** The draft content (everything of the packet but its provenance). */
  content: Omit<CrossRepoPacket, 'provenance'>
  /** Why it cannot be requested as it is (empty: it can). */
  problems: string[]
}

/** Edits of the experiment's own work only, each once; a prerequisite names another of its work items. */
function checkedEdits(input: CrossRepoCorrectionInput): CorrectionWorkEdit[] {
  const seen = new Set<number>()
  for (const edit of input.edits ?? []) {
    const at = `${edit.experimentId}#${edit.index}`
    if (edit.experimentId !== input.experimentId) fail('invalid_input', `The edit of ${at} names another experiment: edit only the work of ${input.experimentId}.`, { ref: at })
    if (seen.has(edit.index)) fail('invalid_input', `${at} is edited twice: give one edit per work item.`, { ref: at })
    seen.add(edit.index)
    for (const prerequisite of edit.dependsOn ?? []) {
      if (!('work' in prerequisite) || prerequisite.work.experimentId !== input.experimentId) {
        fail('invalid_input', `Invalid prerequisite of ${at}: the target epic is new, so a prerequisite names another work item of ${input.experimentId} ({ work }).`, { ref: at })
      }
    }
  }
  return [...(input.edits ?? [])].sort((a, b) => a.index - b.index)
}

function problemsOf(ctx: Ctx, experiment: RetroExperiment, generated: string[]): string[] {
  const read = getExperiment(ctx, { experimentId: experiment.id })
  const problems: string[] = []
  if (experiment.destination.kind !== 'darkmechanicus_source') {
    problems.push("its destination is this project's repository: create its corrective work here (createCorrections), not in the Dark Mechanicus source")
  }
  if (read.withdrawn) problems.push('a later revision of its sprint report left it out (withdrawn)')
  if (FINAL_EXPERIMENT_STATUSES.includes(read.status)) problems.push(`it is ${read.status}`)
  return [...problems, ...executionProblems(experiment), ...generated]
}

function prepare(ctx: Ctx, input: CrossRepoCorrectionInput): Prepared {
  const source = loadSource(ctx, input.reportId)
  const experiment =
    source.experiments.find((candidate) => candidate.id === input.experimentId) ??
    fail('not_found', `Experiment ${input.experimentId} is not in the retro of report ${source.reportId}.`, { experimentId: input.experimentId, reportId: source.reportId })
  const edits = checkedEdits(input)
  const generated = correctiveItems(experiment, edits)
  const reportHash = ctx.db.get<{ content_hash: string }>('SELECT content_hash FROM sprint_reports WHERE id = ?', source.reportId)?.content_hash ?? ''
  const projectName = getMeta(ctx.db, META_KEYS.projectName) ?? ctx.projectId
  const base = { source, projectId: ctx.projectId, projectName, reportHash, experiment, edits }
  const content = {
    epic: epicContent(base, input),
    sprintGoal: clipped(`Corrective work for experiment ${experiment.id} from the Sprint ${source.sprintOrdinal ?? '?'} retro of ${projectName}.`, LIMITS.shortText),
    items: generated.items,
    fireguard: input.fireguard ?? true
  }
  const problems = problemsOf(ctx, experiment, generated.problems)
  const shape = problems.length === 0 ? contentSchema.safeParse(content) : null
  if (shape?.success === false) problems.push(`its draft does not fit a plan (${firstIssue(shape.error)}): shorten the experiment or its work in a new report revision`)
  return { ...base, content, problems }
}

function clipped(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function epicContent(prepared: Pick<Prepared, 'source' | 'experiment' | 'projectName' | 'projectId'>, input: CrossRepoCorrectionInput): CrossRepoPacket['epic'] {
  const { source, experiment, projectName, projectId } = prepared
  const title = input.title?.trim() || clipped(`Correction from ${projectName}: ${experiment.issue.summary}`, LIMITS.title)
  const intent = [
    `Corrective work the project "${projectName}" (\`${projectId}\`) asked of this project: experiment \`${experiment.id}\` of the Sprint ${source.sprintOrdinal ?? '?'} retro of Run #${source.runNumber} of its epic "${source.epic.title}" (\`${source.epic.id}\`), report \`${source.reportId}\` (revision ${source.reportRevision}).`,
    '',
    "That project, its runs, reports and scores stay as they are. This epic is this project's own: its branch, runs, checkpoints and approvals are here, and nothing runs until the person saves and starts it.",
    '',
    'The experiment states a hypothesis, not a proven cause; its work is measured against its baseline after it lands.',
    '',
    experimentContext(experiment).replace(/^## /, '### ')
  ].join('\n')
  return { title, intent, successCriteria: [experimentGoal(experiment)] }
}

/** The key and payload hash of what the request asks of `targetProjectId` (titles of the source never take part). */
function askOf(prepared: Prepared, input: CrossRepoCorrectionInput, targetProjectId: string): { key: string; payloadHash: string } {
  const { source, ...definition } = prepared.experiment
  return {
    key: correctionKey(prepared.experiment, `from:${prepared.projectId}/to:${targetProjectId}`),
    payloadHash: contentHash({
      definition,
      assessmentId: source.assessmentId,
      target: { kind: 'darkmechanicus_source', projectId: targetProjectId },
      title: input.title?.trim() ?? null,
      fireguard: input.fireguard ?? true,
      edits: prepared.edits
    })
  }
}

function provenanceOf(prepared: Prepared, ask: { key: string; payloadHash: string }, target: CrossRepoTarget): CorrectionProvenance {
  const { source, experiment } = prepared
  return {
    kind: 'cross_repo_correction',
    key: ask.key,
    payloadHash: ask.payloadHash,
    source: {
      projectId: prepared.projectId,
      projectName: prepared.projectName,
      epicId: source.epic.id,
      runId: source.runId,
      sprintId: source.sprintId,
      reportId: source.reportId,
      reportRevision: source.reportRevision,
      reportHash: prepared.reportHash,
      experimentId: experiment.id,
      assessment: {
        reportId: experiment.source.reportId,
        assessmentId: experiment.source.assessmentId,
        snapshotId: experiment.source.snapshotId,
        policyHash: experiment.source.policyHash
      }
    },
    target: { projectId: target.projectId },
    note: clipped(`Asked by the Sprint ${source.sprintOrdinal ?? '?'} retro of Run #${source.runNumber} of "${source.epic.title}" in ${prepared.projectName}.`, LIMITS.shortText)
  }
}

function packetOf(prepared: Prepared, input: CrossRepoCorrectionInput, target: CrossRepoTarget): CrossRepoPacket {
  return { ...prepared.content, provenance: provenanceOf(prepared, askOf(prepared, input, target.projectId), target) }
}

// ---------------------------------------------------------------------------------------------------------------
// Source: the receipt

interface LinkRow {
  key: string
  experiment_id: string
  source_epic_id: string
  report_id: string
  target_project_id: string
  payload_hash: string
  packet_json: string
  state: 'pending' | 'linked'
  target_json: string | null
  attempts: number
  last_error_json: string | null
  created_at: string
  updated_at: string
  linked_at: string | null
  evidence_json: string | null
}

/** The receipt's `evidence_json`: what it brought back, with the summary the person and the orchestrator read. */
interface StoredResults extends CarriedResults {
  view: CrossRepoResultsView
}

function linkView(row: LinkRow): CrossRepoCorrectionLinkView {
  return {
    key: row.key,
    experimentId: row.experiment_id,
    reportId: row.report_id,
    sourceEpicId: row.source_epic_id,
    targetProjectId: row.target_project_id,
    payloadHash: row.payload_hash,
    state: row.state,
    target: parseJson<CrossRepoTargetEpicView | null>(row.target_json, null),
    attempts: row.attempts,
    lastError: parseJson<CrossRepoCorrectionLinkView['lastError']>(row.last_error_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    linkedAt: row.linked_at,
    results: parseJson<StoredResults | null>(row.evidence_json, null)?.view ?? null
  }
}

const LINK_BY_KEY = 'SELECT * FROM correction_links WHERE key = ?'

function requireLink(ctx: Ctx, key: string): LinkRow {
  return ctx.db.get<LinkRow>(LINK_BY_KEY, key) ?? fail('not_found', `No cross-repository correction was requested under key ${key}.`, { key })
}

/** The receipt of the experiment for any target project: the one for `key` first. */
function experimentLink(ctx: Ctx, experimentId: string, key: string | null): LinkRow | null {
  return ctx.db.get<LinkRow>('SELECT * FROM correction_links WHERE experiment_id = ? ORDER BY key = ? DESC, created_at LIMIT 1', experimentId, key ?? '') ?? null
}

function mismatch(row: LinkRow): never {
  const next =
    row.state === 'pending'
      ? 'finish it with a retry, or withdraw it if the Dark Mechanicus source never accepted it, then request again'
      : "edit the target epic's draft there"
  fail('idempotency_mismatch', `The corrective work of ${row.experiment_id} for project ${row.target_project_id} was already requested with another payload (${row.state}): ${next}.`, {
    key: row.key,
    state: row.state
  })
}

/** A receipt as written when a request first reaches the source (`pending`, not yet delivered). */
interface NewReceipt {
  key: string
  experimentId: string
  sourceEpicId: string
  reportId: string
  targetProjectId: string
  payloadHash: string
  packet: CrossRepoPacket
}

export interface BegunCorrection {
  link: CrossRepoCorrectionLinkView
  packet: CrossRepoPacket
  /** True when this call wrote the receipt; false when an identical request had, or nothing was written (`unsaved`). */
  inserted: boolean
  /**
   * Why the experiment no longer takes new work (withdrawn, final, aimed elsewhere or its work not specific), or null.
   * It forbids creating a target epic, never recording the link to one the target already holds.
   */
  closed: string | null
  /**
   * Set when the experiment cannot be requested as it is and no receipt exists: nothing was written here. The receipt
   * is written (linked at once) only when the target already holds an epic for the request (`recordCrossRepoDelivery`);
   * otherwise the request is refused with nothing kept.
   */
  unsaved: NewReceipt | null
}

/**
 * The first write of a request, in the source: the receipt, `pending` with the fully specified draft, before anything
 * is written to the target. An identical earlier request returns its receipt (pending or linked) unchanged; another
 * payload under the same key is `idempotency_mismatch`, another target project for the same experiment is `conflict`.
 * An experiment that cannot be requested as it is (closed, or its work not specific) writes nothing: its well-formed
 * draft comes back `unsaved` with `closed` set, so the target only links an epic it already holds for the request (a
 * receipt lost here) and never creates one; a draft the target would refuse for its shape is refused here.
 */
export function beginCrossRepoCorrection(ctx: Ctx, raw: CreateCrossRepoCorrectionInput, target: CrossRepoTarget): BegunCorrection {
  requireCapability(ctx.session, 'correction.cross_repo')
  const input = parseInput(createCrossRepoCorrectionInput, raw, 'cross-repository correction') as CreateCrossRepoCorrectionInput
  return ctx.db.tx(() => {
    const prepared = prepare(ctx, input)
    const ask = askOf(prepared, input, target.projectId)
    const existing = ctx.db.get<LinkRow>(LINK_BY_KEY, ask.key) ?? null
    if (existing !== null) {
      if (existing.payload_hash !== ask.payloadHash) mismatch(existing)
      return { link: linkView(existing), packet: parsePacket(JSON.parse(existing.packet_json)), inserted: false, closed: standingProblem(ctx, existing.experiment_id), unsaved: null }
    }
    const other = experimentLink(ctx, prepared.experiment.id, null)
    if (other !== null) {
      fail('conflict', `The corrective work of ${other.experiment_id} was already requested for project ${other.target_project_id} (${other.state}): an experiment's corrective work is created once.`, {
        key: other.key
      })
    }
    // The draft is checked before anything is written: a request the target would refuse for its shape stores nothing.
    const built = packetOf(prepared, input, target)
    if (prepared.problems.length > 0 && !packetSchema.safeParse(built).success) refusedRequest(prepared)
    const receipt: NewReceipt = {
      key: ask.key,
      experimentId: prepared.experiment.id,
      sourceEpicId: prepared.source.epic.id,
      reportId: prepared.source.reportId,
      targetProjectId: target.projectId,
      payloadHash: ask.payloadHash,
      packet: parsePacket(built)
    }
    if (prepared.problems.length > 0) {
      return { link: unsavedView(receipt, ctx.clock.nowIso()), packet: receipt.packet, inserted: false, closed: prepared.problems.join('; '), unsaved: receipt }
    }
    insertReceipt(ctx, receipt)
    return { link: linkView(requireLink(ctx, ask.key)), packet: receipt.packet, inserted: true, closed: null, unsaved: null }
  })
}

/** Writes a new `pending` receipt and its `correction.requested` event. */
function insertReceipt(ctx: Ctx, receipt: NewReceipt): void {
  const now = ctx.clock.nowIso()
  ctx.db.run(
    `INSERT INTO correction_links (key, experiment_id, source_epic_id, report_id, target_project_id, payload_hash, packet_json, state,
       target_json, attempts, last_error_json, created_at, updated_at, linked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, NULL, ?, ?, NULL)`,
    receipt.key,
    receipt.experimentId,
    receipt.sourceEpicId,
    receipt.reportId,
    receipt.targetProjectId,
    receipt.payloadHash,
    toJson(receipt.packet),
    now,
    now
  )
  appendEvent(ctx, {
    kind: 'correction.requested',
    epicId: receipt.sourceEpicId,
    payload: { key: receipt.key, targetProjectId: receipt.targetProjectId, payloadHash: receipt.payloadHash }
  })
}

/** How a receipt that was not written reads: pending, never attempted. */
function unsavedView(receipt: NewReceipt, now: string): CrossRepoCorrectionLinkView {
  return {
    key: receipt.key,
    experimentId: receipt.experimentId,
    reportId: receipt.reportId,
    sourceEpicId: receipt.sourceEpicId,
    targetProjectId: receipt.targetProjectId,
    payloadHash: receipt.payloadHash,
    state: 'pending',
    target: null,
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    linkedAt: null,
    results: null
  }
}

/** Why an experiment cannot be requested as it is, as the refusal of a request the target holds nothing for. */
function refusedRequest(prepared: Pick<Prepared, 'experiment' | 'problems'>): never {
  const restate = executionProblems(prepared.experiment).length > 0 ? ' Restate it in a new report revision (by its id, from its original { reportId, assessmentId }) with sized, specific work.' : ''
  return fail('conflict', `Not requested: ${prepared.experiment.id} ${prepared.problems.join('; ')}.${restate}`, {
    experimentId: prepared.experiment.id,
    problems: prepared.problems
  })
}

/**
 * The refusal of a request this very call made for an experiment that cannot be requested as it is (`closed`), once
 * the target turned out to hold no epic for it to link (or could not be read): nothing is kept.
 */
export function closedRequestRefusal(experimentId: string, closed: string): DomainError {
  return new DomainError('conflict', `Not requested: ${experimentId} ${closed}. The Dark Mechanicus source holds no epic for it to link to, so nothing was kept.`, {
    experimentId,
    problem: 'experiment_closed'
  })
}

/**
 * Why an experiment no longer takes new corrective work as it stands now: withdrawn, completed or abandoned, aimed
 * elsewhere, or its work not specific (`problemsOf` on its current definition). Null while it does.
 */
function standingProblem(ctx: Ctx, experimentId: string): string | null {
  const problems = problemsOf(ctx, getExperiment(ctx, { experimentId }).experiment, [])
  return problems.length === 0 ? null : problems.join('; ')
}

/** A request's receipt and the draft it keeps, for a retry, with whether its experiment still takes new work (recomputed now). */
export function requestedCrossRepoCorrection(ctx: Ctx, raw: { key: string }): Omit<BegunCorrection, 'inserted'> {
  requireCapability(ctx.session, 'correction.cross_repo')
  const { key } = parseInput(crossRepoCorrectionKeyInput, raw, 'cross-repository correction')
  const row = requireLink(ctx, key)
  return { link: linkView(row), packet: parsePacket(JSON.parse(row.packet_json)), closed: standingProblem(ctx, row.experiment_id), unsaved: null }
}

/** Read only: one receipt by key. */
export function crossRepoCorrectionLink(ctx: Ctx, raw: { key: string }): CrossRepoCorrectionLinkView {
  requireCapability(ctx.session, 'read')
  const { key } = parseInput(crossRepoCorrectionKeyInput, raw, 'cross-repository correction')
  return linkView(requireLink(ctx, key))
}

/**
 * The last write of a request: the receipt names the target epic that holds the work (`linked`). The stored view never
 * says `created`: only the call that created the epic reports it.
 */
export function recordCrossRepoDelivery(ctx: Ctx, key: string, target: CrossRepoTargetEpicView, unsaved: NewReceipt | null = null): CrossRepoCorrectionLinkView {
  requireCapability(ctx.session, 'correction.cross_repo')
  return ctx.db.tx(() => {
    if (unsaved !== null && ctx.db.get(LINK_BY_KEY, key) === undefined) insertReceipt(ctx, unsaved)
    const row = requireLink(ctx, key)
    if (row.target_project_id !== target.projectId) {
      fail('project_mismatch', `The receipt ${key} is for project ${row.target_project_id}, not ${target.projectId}.`, { key })
    }
    // Grades brought back from another epic are not this epic's: a link to a new epic clears them.
    const before = parseJson<CrossRepoTargetEpicView | null>(row.target_json, null)?.epicId ?? null
    const now = ctx.clock.nowIso()
    ctx.db.run(
      `UPDATE correction_links SET state = 'linked', target_json = ?, attempts = attempts + 1, last_error_json = NULL, updated_at = ?,
         linked_at = COALESCE(linked_at, ?), evidence_json = CASE WHEN ? = 1 THEN evidence_json ELSE NULL END WHERE key = ?`,
      toJson({ ...target, created: false }),
      now,
      now,
      before === target.epicId ? 1 : 0,
      key
    )
    appendEvent(ctx, { kind: 'correction.linked', epicId: row.source_epic_id, payload: { key, targetProjectId: target.projectId, targetEpicId: target.epicId, created: target.created } })
    return linkView(requireLink(ctx, key))
  })
}

/**
 * A failed delivery: the receipt keeps its state and records the step and code (never a message or a path). When the
 * target accepted the work but the link failed, `target` is kept too, so a later delivery expects that very epic.
 */
export function recordCrossRepoFailure(
  ctx: Ctx,
  key: string,
  failure: { step: CrossRepoCorrectionStep; code: string; problem: string | null; target: CrossRepoTargetEpicView | null }
): CrossRepoCorrectionLinkView {
  requireCapability(ctx.session, 'correction.cross_repo')
  return ctx.db.tx(() => {
    requireLink(ctx, key)
    const now = ctx.clock.nowIso()
    const { target, ...rest } = failure
    ctx.db.run(
      "UPDATE correction_links SET attempts = attempts + 1, last_error_json = ?, target_json = COALESCE(?, target_json), updated_at = ? WHERE key = ? AND state = 'pending'",
      toJson({ ...rest, at: now }),
      target === null ? null : toJson({ ...target, created: false }),
      now,
      key
    )
    return linkView(requireLink(ctx, key))
  })
}

/**
 * Removes a pending receipt: one the target refused for good as this very call wrote it, or one the person withdraws
 * (the broker checks first that the target never accepted it). A linked receipt is never removed.
 */
export function discardCrossRepoCorrection(ctx: Ctx, key: string, reason: 'refused' | 'withdrawn'): CrossRepoCorrectionLinkView {
  requireCapability(ctx.session, 'correction.cross_repo')
  return ctx.db.tx(() => {
    const row = requireLink(ctx, key)
    if (row.state !== 'pending') fail('conflict', `The request ${key} is linked to an epic of project ${row.target_project_id}: it stays.`, { key })
    ctx.db.run('DELETE FROM correction_links WHERE key = ?', key)
    appendEvent(ctx, { kind: `correction.${reason}`, epicId: row.source_epic_id, payload: { key, targetProjectId: row.target_project_id, payloadHash: row.payload_hash } })
    return linkView(row)
  })
}

/** The experiment ids a report revision's retro holds (any revision, not only the latest). */
function reportExperiments(ctx: Ctx, reportId: string): Set<string> {
  const row = ctx.db.get<{ content_json: string }>('SELECT content_json FROM sprint_reports WHERE id = ?', reportId) ?? fail('not_found', `Sprint report ${reportId} not found.`, { reportId })
  const retro = parseJson<{ retro?: { experiments?: { id: string }[] } | null }>(row.content_json, {}).retro
  return new Set((retro?.experiments ?? []).map((experiment) => experiment.id))
}

/** The receipts of this project's requests, newest first; of one report revision's experiments or one experiment when asked. */
export function listCrossRepoCorrections(ctx: Ctx, raw: { reportId?: string; experimentId?: string }): CrossRepoCorrectionLinkView[] {
  requireCapability(ctx.session, 'read')
  const input = parseInput(crossRepoCorrectionListInput, raw, 'cross-repository corrections')
  const experiments = input.reportId === undefined ? null : reportExperiments(ctx, input.reportId)
  return ctx.db
    .all<LinkRow>('SELECT * FROM correction_links ORDER BY created_at DESC, key')
    .filter((row) => (input.experimentId === undefined || row.experiment_id === input.experimentId) && (experiments === null || experiments.has(row.experiment_id)))
    .map(linkView)
}

/** What the source says of a request before the target is read. */
export interface SourcePreview {
  source: Source & { projectId: string; projectName: string }
  experiment: RetroExperiment
  problems: string[]
  epic: CrossRepoPacket['epic']
  /** Null without a target project. */
  packet: CrossRepoPacket | null
  link: CrossRepoCorrectionLinkView | null
  /** The state the receipt gives (`ready` when there is none and nothing blocks it). */
  state: CrossRepoCorrectionState
}

/**
 * What the receipt says of the request for `packet`: another key or payload is a conflict; without a chosen target
 * the receipt's own state shows. With no receipt, the experiment is ready unless something blocks it.
 */
function sourceState(row: LinkRow | null, packet: CrossRepoPacket | null, problems: string[]): { state: CrossRepoCorrectionState; problems: string[] } {
  if (row === null) return { state: problems.length > 0 ? 'blocked' : 'ready', problems }
  if (packet !== null && (row.key !== packet.provenance.key || row.payload_hash !== packet.provenance.payloadHash)) {
    const other = row.key === packet.provenance.key ? 'another payload' : 'another target project'
    return { state: 'conflict', problems: [`already requested for project ${row.target_project_id} under key ${row.key} with ${other}`] }
  }
  if (row.state === 'linked') return { state: 'created', problems: [] }
  // A pending request whose experiment closed since creates nothing any more; one the target accepted still links on a retry.
  return problems.length > 0 && row.target_json === null ? { state: 'blocked', problems } : { state: 'pending', problems: [] }
}

/** Read only. The experiment's draft for `target` (or none chosen), its problems and its receipt. */
export function previewCrossRepoSource(ctx: Ctx, raw: CrossRepoCorrectionInput, target: CrossRepoTarget | null): SourcePreview {
  requireCapability(ctx.session, 'read')
  const input = parseInput(crossRepoCorrectionInput, raw, 'cross-repository correction') as CrossRepoCorrectionInput
  return ctx.db.tx(() => {
    const prepared = prepare(ctx, input)
    const packet = target === null ? null : packetOf(prepared, input, target)
    const row = experimentLink(ctx, prepared.experiment.id, packet?.provenance.key ?? null)
    return {
      source: { ...prepared.source, projectId: prepared.projectId, projectName: prepared.projectName },
      experiment: prepared.experiment,
      epic: prepared.content.epic,
      packet,
      link: row === null ? null : linkView(row),
      ...sourceState(row, packet, prepared.problems)
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Target: the epic that holds the work

/** The draft the packet becomes on `base` (a new epic's initial draft): its first sprint takes the work. */
function applied(base: PlanBundle, packet: CrossRepoPacket, deps: DraftDeps, ids: { known: boolean }): AppliedCorrections {
  const sprintId = sortedSprints(base)[0]?.id ?? fail('internal', 'A new epic has no sprint.')
  const { key, payloadHash, source } = packet.provenance
  return applyCorrections(
    base,
    { placement: { kind: 'sprint', sprintId, goal: packet.sprintGoal }, items: packet.items, fireguard: packet.fireguard, markers: new Map([[source.experimentId, { key, payloadHash }]]) },
    deps,
    ids
  )
}

/** The initial draft of a new epic with the packet's content, as `deps` would allocate it. */
function initialDraft(packet: CrossRepoPacket, deps: DraftDeps): PlanBundle {
  const { title, intent, successCriteria } = packet.epic
  const ids = { sprintId: deps.newId('sprint'), ticketId: deps.newId('ticket'), ticketKey: deps.nextKey() }
  return createInitialBundle({ title, intent, successCriteria: normalizeCriteria(successCriteria, [], 's'), ownerRole: null }, ids)
}

/** Placeholder ids and keys (`NEW-1`, …) for a preview while the target cannot be read: nothing is allocated there. */
export function placeholderDeps(ctx: Ctx): DraftDeps {
  let next = 0
  return {
    newId: (kind) => ctx.ids.next(kind),
    nextKey: () => {
      next += 1
      return `NEW-${next}`
    },
    repositories: () => null,
    attachmentRefs: () => []
  }
}

/** The tickets and dependencies the packet adds, planned with `deps` (the target's, or placeholders). */
export function plannedTickets(packet: CrossRepoPacket, deps: DraftDeps): { tickets: CorrectionTicketView[]; dependencies: { from: string; to: string }[]; bundle: PlanBundle } {
  const result = applied(initialDraft(packet, deps), packet, deps, { known: false })
  return { tickets: result.tickets.map((ticket) => ({ ...ticket, existing: false, ticketId: null })), dependencies: result.dependencies, bundle: result.bundle }
}

/** The packet is meant for this project; anything else is refused before a read or a write. */
function assertTarget(ctx: Ctx, packet: CrossRepoPacket): void {
  const asked = packet.provenance.target.projectId
  if (asked !== ctx.projectId) {
    fail('project_mismatch', `This project is ${ctx.projectId}; the corrective work was asked of project ${asked}. Nothing was written.`, { projectId: ctx.projectId, targetProjectId: asked })
  }
}

/** The plan an epic holds the work in: its draft, else its saved plan (null when it has neither). */
function heldPlan(ctx: Ctx, epicId: string): { bundle: PlanBundle | null; draftRevision: number | null } {
  const draft = loadDraftRow(ctx, epicId)
  if (draft !== null) return { bundle: JSON.parse(draft.bundle_json) as PlanBundle, draftRevision: draft.draft_revision }
  return { bundle: currentSavedBundle(ctx, epicId)?.bundle ?? null, draftRevision: null }
}

/** The epic as it holds the work now: the tickets carrying the key's markers, and the sprint holding them. */
function heldView(ctx: Ctx, epic: EpicRow, provenance: CorrectionProvenance, created: boolean): CrossRepoTargetEpicView {
  const { bundle, draftRevision } = heldPlan(ctx, epic.id)
  const found = bundle === null ? [] : correctionsOf(bundle, provenance.source.experimentId).filter((entry) => entry.marker.key === provenance.key)
  const tickets = [...new Map(found.map((entry) => [entry.ticket.id, entry.ticket])).values()]
  const holder = bundle?.sprints.find((sprint) => tickets.some((ticket) => sprint.ticketIds.includes(ticket.id))) ?? (bundle === null ? undefined : sortedSprints(bundle)[0])
  return {
    projectId: ctx.projectId,
    epicId: epic.id,
    epicTitle: bundle?.epic.title ?? epic.title,
    sprintId: holder?.id ?? '',
    ticketIds: tickets.map((ticket) => ticket.id),
    keys: tickets.map((ticket) => ticket.key),
    draftRevision,
    status: epic.status,
    saved: epic.current_revision_id !== null,
    created
  }
}

/**
 * The epic of this project created under `key`: exactly `expected` when the request reached that epic before, else the
 * earliest (two epics can share a key only after another checkout's records arrived; the order keeps it deterministic).
 */
function epicWithKey(ctx: Ctx, key: string, expected: string | null): EpicRow | null {
  const byKey = "json_extract(provenance_json, '$.kind') = 'cross_repo_correction' AND json_extract(provenance_json, '$.key') = ?"
  const row =
    expected === null
      ? ctx.db.get<EpicRow>(`SELECT * FROM epics WHERE ${byKey} ORDER BY created_at, id LIMIT 1`, key)
      : ctx.db.get<EpicRow>(`SELECT * FROM epics WHERE ${byKey} AND id = ?`, key, expected)
  return row ?? null
}

/** The epic holding `packet`'s key with the same payload, or null; another payload under the key is `idempotency_mismatch`. */
function held(ctx: Ctx, packet: CrossRepoPacket, expected: string | null): CrossRepoTargetEpicView | null {
  const { key, payloadHash } = packet.provenance
  const epic = epicWithKey(ctx, key, expected)
  if (epic === null) return null
  const stored = parseJson<CorrectionProvenance | null>(epic.provenance_json, null)
  if (stored?.payloadHash !== payloadHash) {
    fail('idempotency_mismatch', `Epic ${epic.id} of this project already holds the corrective work under key ${key} with another payload: a request is created once. Edit that epic's draft instead.`, {
      key,
      epicId: epic.id
    })
  }
  return heldView(ctx, epic, packet.provenance, false)
}

/**
 * Read only, in the target: the epic created under `key` (with any payload) and its payload hash, or null; and, when
 * `reached` names the epic a request reached before, whether this project still holds that epic under the key.
 */
export function heldCorrection(ctx: Ctx, key: string, reached: string | null = null): { held: { epicId: string; payloadHash: string } | null; holdsReached: boolean } {
  requireCapability(ctx.session, 'read')
  const epic = epicWithKey(ctx, key, null)
  const stored = epic === null ? null : parseJson<CorrectionProvenance | null>(epic.provenance_json, null)
  const held = epic === null || stored === null ? null : { epicId: epic.id, payloadHash: stored.payloadHash }
  return { held, holdsReached: reached !== null && epicWithKey(ctx, key, reached) !== null }
}

/**
 * Read only, in the target: what epic `epicId` (created under `key`) holds for measuring experiment `experimentId`
 * (`correctionEpicResults`). An epic this project no longer holds under the key is a `conflict` (`target_missing`).
 */
export function crossRepoResults(ctx: Ctx, raw: { key: string; epicId: string; experimentId: string }): Omit<CarriedResults, 'readAt'> {
  requireCapability(ctx.session, 'read')
  const epic =
    epicWithKey(ctx, raw.key, raw.epicId) ??
    fail('conflict', `This checkout of project ${ctx.projectId} does not hold epic ${raw.epicId} under the request ${raw.key}: another checkout holds it, or it was deleted.`, {
      problem: 'target_missing',
      epicId: raw.epicId,
      key: raw.key
    })
  return correctionEpicResults(ctx, epic, { id: raw.experimentId }, raw.key)
}

/** The grades of a carried scorecard at the baseline's level, with the baseline measure read from each. */
function carriedGrades(experiment: RetroExperiment, card: CarriedResults['scorecards'][number]): CrossRepoCarriedGrade[] {
  const { measure } = experiment.baseline
  return gradesOf(card)
    .filter((grade) => grade.subject.level === experiment.source.subject.level)
    .map((grade) => {
      const reading = readMeasure(card, grade, measure)
      return {
        reportId: card.report.reportId,
        reportRevision: card.report.reportRevision,
        runId: card.runId,
        sprintId: card.sprintId,
        assessmentId: grade.assessmentId,
        subject: grade.subject,
        from: grade.dispatchedAt,
        to: card.cutoff,
        ...('missing' in reading ? { value: null, state: 'missing' as const } : { value: reading.value, state: reading.state })
      }
    })
}

/**
 * In the source: keeps what the target epic of a linked request holds for measuring its experiment (read by
 * `crossRepoResults` through the chosen checkout) on the receipt, replacing what it kept before. Every scorecard must
 * be of that epic, match its seal and grade as sealed; nothing is kept otherwise. Writes only the receipt: no report,
 * score or experiment event changes (the orchestrator records a result citing one of these grades as usual).
 */
export function recordCrossRepoResults(ctx: Ctx, key: string, carried: CarriedResults): CrossRepoCorrectionLinkView {
  requireCapability(ctx.session, 'correction.cross_repo')
  return ctx.db.tx(() => {
    const row = requireLink(ctx, key)
    const target = parseJson<CrossRepoTargetEpicView | null>(row.target_json, null)
    if (row.state !== 'linked' || target === null) fail('conflict', `The request ${key} is not linked to an epic of project ${row.target_project_id} yet: finish it first.`, { key })
    if (carried.projectId !== row.target_project_id || carried.epicId !== target.epicId || carried.key !== key) {
      fail('project_mismatch', `What was read is of epic ${carried.epicId} of project ${carried.projectId}, not the linked epic ${target.epicId} of project ${row.target_project_id}.`, { key })
    }
    for (const card of carried.scorecards) {
      if (card.epicId !== carried.epicId || snapshotHashOf(card) !== card.snapshotHash) {
        fail('invalid_input', `The scorecard of report ${card.report.reportId} read from the target is not a sealed scorecard of epic ${carried.epicId}; nothing was kept.`, { key })
      }
      parseScorecardSnapshot(card)
    }
    const { experiment } = getExperiment(ctx, { experimentId: row.experiment_id })
    const view: CrossRepoResultsView = {
      readAt: carried.readAt,
      epicId: carried.epicId,
      epicTitle: carried.epicTitle,
      tickets: carried.corrections.map((ticket) => ({ key: ticket.key, title: ticket.title, role: ticket.role, acceptedAt: ticket.accepted?.at ?? null })),
      grades: carried.scorecards.flatMap((card) => carriedGrades(experiment, card))
    }
    ctx.db.run('UPDATE correction_links SET evidence_json = ?, updated_at = ? WHERE key = ?', toJson({ ...carried, view } satisfies StoredResults), ctx.clock.nowIso(), key)
    return linkView(requireLink(ctx, key))
  })
}

export interface TargetPreview {
  state: 'ready' | 'created' | 'conflict'
  existing: CrossRepoTargetEpicView | null
  problems: string[]
  tickets: CorrectionTicketView[]
  dependencies: { from: string; to: string }[]
  validation: ValidationReport
}

/** Read only, in the target. Whether it holds the packet's key already, and the draft the packet would become here. */
export function previewCrossRepoTarget(ctx: Ctx, raw: CrossRepoPacket): TargetPreview {
  requireCapability(ctx.session, 'read')
  const packet = parsePacket(raw)
  return ctx.db.tx(() => {
    assertTarget(ctx, packet)
    let existing: CrossRepoTargetEpicView | null = null
    let problems: string[] = []
    try {
      existing = held(ctx, packet, null)
    } catch (error) {
      // Another payload under the key: the preview shows the conflict the creation would refuse.
      if (!(error instanceof DomainError) || error.code !== 'idempotency_mismatch') throw error
      problems = [error.message]
    }
    const planned = plannedTickets(packet, draftDeps(ctx))
    const validation = validatePlan(planned.bundle, { repositories: ctx.repositoryEntries() })
    const state = problems.length > 0 ? 'conflict' : existing === null ? 'ready' : 'created'
    return { state, existing, problems, tickets: planned.tickets, dependencies: planned.dependencies, validation }
  })
}

/** What a delivery may do in the target besides finding the epic it holds. */
interface MaterializeOptions {
  /** The epic an earlier delivery of the request reached: only that epic counts, and nothing new is created. */
  expected: string | null
  /** Why the experiment no longer takes new work: the epic the target holds is still found, but none is created. */
  closed: string | null
}

/**
 * Creates the target-owned epic in this project (the Dark Mechanicus source): a backlog epic carrying the portable
 * provenance, whose draft's first sprint holds the corrective tickets (each with its marker), their Fireguard ticket
 * and the acceptance node's covering criteria. One transaction: a draft the target would not accept as valid
 * (`invalid_graph`) leaves no epic behind. A repeat of the same key and payload returns the epic created before
 * (`created: false`); another payload is `idempotency_mismatch`; a packet for another project is `project_mismatch`.
 * With `expected`, only that epic counts: when this project does not hold it, it is a `conflict` (`problem:
 * target_missing`; another checkout of the project holds it, or it was deleted) and nothing is created, unless the
 * person asked to create it again (`expected` null). With `closed`, nothing is created (`problem: experiment_closed`).
 */
export function materializeCrossRepoCorrection(ctx: Ctx, raw: CrossRepoPacket, options: MaterializeOptions): CrossRepoTargetEpicView {
  requireCapability(ctx.session, 'correction.cross_repo')
  requireCapability(ctx.session, 'draft.edit')
  const packet = parsePacket(raw)
  const { expected, closed } = options
  return ctx.db.tx(() => {
    assertTarget(ctx, packet)
    const existing = held(ctx, packet, expected)
    if (existing !== null) return existing
    if (expected !== null) {
      fail(
        'conflict',
        `This checkout of project ${ctx.projectId} does not hold epic ${expected}, which this request reached before: another checkout of the project holds it, or it was deleted. Choose the checkout that holds it (or bring its records here), or create the request again with recreate to make a new epic. Nothing was written.`,
        { problem: 'target_missing', epicId: expected, key: packet.provenance.key }
      )
    }
    if (closed !== null) {
      fail('conflict', `No epic is created for ${packet.provenance.source.experimentId}: ${closed}, and this project holds none for the request. Withdraw it. Nothing was written.`, {
        problem: 'experiment_closed',
        key: packet.provenance.key
      })
    }
    const epicId = createCorrectionEpic(ctx, packet.epic, packet.provenance)
    const draft = loadDraftRow(ctx, epicId) ?? fail('internal', `Epic ${epicId} has no draft.`)
    const result = applied(JSON.parse(draft.bundle_json) as PlanBundle, packet, draftDeps(ctx, epicId), { known: true })
    const validation = validatePlan(result.bundle, { repositories: ctx.repositoryEntries() })
    if (validation.errors.length > 0) {
      fail('invalid_graph', `The corrective draft would not be valid here: ${validation.errors.map((issue) => issue.message).join(' ')}`, { errors: validation.errors })
    }
    const draftRevision = writeDraft(ctx, draft, result.bundle)
    const { key, source } = packet.provenance
    appendEvent(ctx, {
      kind: 'draft.corrected',
      epicId,
      payload: { key, sourceProjectId: source.projectId, reportId: source.reportId, experiments: [source.experimentId], sprintId: result.sprintId, added: [...result.refMap.values()], draftRevision }
    })
    return heldView(ctx, loadEpicRow(ctx, epicId), packet.provenance, true)
  })
}
