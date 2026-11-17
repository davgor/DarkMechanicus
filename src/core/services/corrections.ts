/**
 * Corrective work from a sprint retro's experiments (`src/shared/domain/corrections.ts`), in the same repository:
 * previewing it, and creating it as DRAFT work the person reviews. For an unfinished epic it goes into a future sprint
 * of the epic's draft or a sprint appended after the last one; for a completed epic it becomes a new follow-up epic
 * linked to it (provenance), whose draft holds it. Only drafts change (and, for a follow-up, a new backlog epic is
 * created): no plan is saved, no revision adopted, no run started, nothing approved, granted, retried or continued.
 * The source epic's passed sprints, its saved revisions, runs, reports, acceptance history and scores stay as they are.
 *
 * An experiment is created at most once. Its tickets carry a correction marker (`plan/corrections.ts`) naming its
 * stable key (source report, experiment, target) and the request's payload hash; a repeat finds them in any draft or
 * saved revision of the project, returns the same work when the payload matches and refuses it otherwise.
 */
import type { PlanBundle, SprintDef } from '../../shared/domain/bundle'
import type {
  CorrectionExistingView,
  CorrectionExperimentView,
  CorrectionPlanView,
  CorrectionsInput,
  CorrectionsResultView,
  CorrectionTargetKind,
  CorrectionWorkEdit,
  CreateCorrectionsInput
} from '../../shared/domain/corrections'
import { FINAL_EXPERIMENT_STATUSES, type RetroExperiment } from '../../shared/domain/experiments'
import type { SprintRetro } from '../../shared/domain/retro'
import type { ValidationIssue, ValidationReport } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import { contentHash } from '../canonical'
import type { Ctx } from '../context'
import { parseJson } from '../db/database'
import { fail } from '../errors'
import {
  applyCorrections,
  type AppliedCorrections,
  correctionKey,
  correctionsOf,
  correctionTargetKey,
  type CorrectionPlacement,
  type CorrectionRequest,
  type CorrectiveItem,
  correctiveItems,
  experimentContext,
  experimentGoal
} from '../plan/corrections'
import { CORRECTION_MARKER_PREFIX } from '../plan/correctionMarker'
import { executionProblems, restatementOf } from '../plan/experiments'
import type { DraftDeps } from '../plan/draftOps'
import { sortedSprints, validatePlan } from '../plan/graph'
import { createInitialBundle, normalizeCriteria } from '../plan/normalize'
import { correctionsInput, createCorrectionsInput, parseInput } from '../schemas'
import { draftDeps, initialPlanIds } from './draftDeps'
import { ensureDraft, writeDraft } from './drafts'
import { assertEpicOpen, createEpic, type EpicRow, loadEpicRow } from './epics'
import { appendEvent } from './events'
import { markedBundles } from './experimentOutcomes'
import { experimentStanding } from './experiments'
import { assertDraftRevision, currentSavedBundle, type DraftRow, loadDraftRow } from './plans'
import { loadBundle } from './reports'
import { withRunWarnings } from './runWarnings'

const ACTIVE_RUN_STATES = `('queued','running','awaiting_checkpoint','paused')`

/** The report revision the experiments are read from, with its run, sprint and epic. */
export interface Source {
  reportId: string
  reportRevision: number
  runId: string
  runNumber: number
  sprintId: string
  sprintOrdinal: number | null
  epic: EpicRow
  experiments: RetroExperiment[]
  leftovers: string[]
}

interface SourceRow {
  id: string
  run_id: string
  sprint_id: string
  report_revision: number
  content_json: string
  epic_id: string
  run_number: number
  revision_id: string
}

/** Refuses a report revision a later revision of its sprint's report replaced (its experiments may differ). */
function requireLatest(ctx: Ctx, row: SourceRow): void {
  const latest = ctx.db.get<{ id: string; report_revision: number }>(
    'SELECT id, report_revision FROM sprint_reports WHERE run_id = ? AND sprint_id = ? ORDER BY report_revision DESC LIMIT 1',
    row.run_id,
    row.sprint_id
  )
  if (latest !== undefined && latest.id !== row.id) {
    fail('conflict', `Report ${row.id} is revision ${row.report_revision} of its sprint's report; revision ${latest.report_revision} (${latest.id}) replaced it. Read the corrections of the latest revision.`, {
      reportId: row.id,
      latestReportId: latest.id
    })
  }
}

/** The report revision with its run, sprint, epic and retro; it must be the latest revision of its sprint's report. */
export function loadSource(ctx: Ctx, reportId: string): Source {
  const row =
    ctx.db.get<SourceRow>(
      `SELECT r.id, r.run_id, r.sprint_id, r.report_revision, r.content_json, runs.epic_id, runs.number AS run_number, runs.revision_id
       FROM sprint_reports r JOIN runs ON runs.id = r.run_id WHERE r.id = ?`,
      reportId
    ) ?? fail('not_found', `Sprint report ${reportId} not found.`, { reportId })
  requireLatest(ctx, row)
  const retro: Partial<SprintRetro> = parseJson<{ retro?: SprintRetro | null }>(row.content_json, {}).retro ?? {}
  const sprint = loadBundle(ctx, row.revision_id).sprints.find((item) => item.id === row.sprint_id)
  return {
    reportId: row.id,
    reportRevision: row.report_revision,
    runId: row.run_id,
    runNumber: row.run_number,
    sprintId: row.sprint_id,
    sprintOrdinal: sprint?.ordinal ?? null,
    epic: loadEpicRow(ctx, row.epic_id),
    experiments: retro.experiments ?? [],
    leftovers: (retro.leftovers ?? []).map((item) => item.ticket)
  }
}

/** The selected experiments, in the order asked, each once and each in the report's retro. */
function selectedExperiments(source: Source, input: CorrectionsInput): RetroExperiment[] {
  const seen = new Set<string>()
  return input.experimentIds.map((id) => {
    if (seen.has(id)) fail('invalid_input', `Experiment ${id} is selected twice: select each once.`, { experimentId: id })
    seen.add(id)
    return (
      source.experiments.find((item) => item.id === id) ??
      fail('not_found', `Experiment ${id} is not in the retro of report ${source.reportId}.`, { experimentId: id, reportId: source.reportId })
    )
  })
}

/** Every edit names a selected experiment's work, and each work item at most once. */
function checkedEdits(input: CorrectionsInput): CorrectionWorkEdit[] {
  const edits = input.edits ?? []
  const seen = new Set<string>()
  for (const edit of edits) {
    const at = `${edit.experimentId}#${edit.index}`
    if (!input.experimentIds.includes(edit.experimentId)) {
      fail('invalid_input', `The edit of ${at} names an experiment that is not selected.`, { experimentId: edit.experimentId })
    }
    if (seen.has(at)) fail('invalid_input', `${at} is edited twice: give one edit per work item.`, { ref: at })
    seen.add(at)
  }
  return edits
}

// ---------------------------------------------------------------------------------------------------------------
// Target

/**
 * A future sprint (or one appended) of the unfinished source epic's draft. `problem` says why the named sprint cannot
 * take new work (missing, passed or in progress); it blocks only experiments not created yet, so a repeat of work
 * already created still answers `created` once the run has reached that sprint.
 */
interface SameEpicTarget {
  kind: 'new_sprint' | 'sprint'
  key: string
  epic: EpicRow
  draft: DraftRow | null
  base: PlanBundle
  afterOrdinal: number
  sprint: SprintDef | null
  problem: string | null
}

/**
 * A follow-up epic of the completed source epic: the open one an earlier request created for it (`reuse`, whose draft
 * takes the new work), or a new one, whose `base` is its first draft as creating it would give and whose `deps`
 * allocate its ids and keys and the work's after them.
 */
interface FollowUpTarget {
  kind: 'follow_up_epic'
  key: string
  title: string
  base: PlanBundle
  deps: DraftDeps
  reuse: { epic: EpicRow; draft: DraftRow | null } | null
}

type Target = SameEpicTarget | FollowUpTarget

/** The draft as it is, or what opening it would give (the saved plan), without writing anything. */
function draftBase(ctx: Ctx, epic: EpicRow): { draft: DraftRow | null; base: PlanBundle } {
  const draft = loadDraftRow(ctx, epic.id)
  if (draft !== null) return { draft, base: JSON.parse(draft.bundle_json) as PlanBundle }
  const saved = currentSavedBundle(ctx, epic.id)
  return { draft: null, base: saved?.bundle ?? createInitialBundle({ title: epic.title, intent: '', successCriteria: [], ownerRole: null }, initialPlanIds(ctx)) }
}

/**
 * The last sprint corrections may not touch: the report's own sprint, or the furthest sprint a run of the epic in
 * progress has reached (its active sprint), whichever is later. Passed and in-progress scope stays as it is.
 */
function passedOrdinal(ctx: Ctx, source: Source, base: PlanBundle): number {
  const ordinalOf = (sprintId: string | null): number => base.sprints.find((sprint) => sprint.id === sprintId)?.ordinal ?? 0
  const active = ctx.db.all<{ active_sprint_id: string | null }>(`SELECT active_sprint_id FROM runs WHERE epic_id = ? AND state IN ${ACTIVE_RUN_STATES}`, source.epic.id)
  return Math.max(ordinalOf(source.sprintId) || (source.sprintOrdinal ?? 0), ...active.map((run) => ordinalOf(run.active_sprint_id)))
}

function followUpTitle(source: Source, input: CorrectionsInput): string {
  const asked = input.target?.kind === 'follow_up_epic' ? input.target.title?.trim() : undefined
  return asked !== undefined && asked !== '' ? asked : `Follow-up: ${source.epic.title}`.slice(0, 300)
}

function followUpContent(source: Source, title: string, experiments: RetroExperiment[]): { title: string; intent: string; successCriteria: string[] } {
  const intent = [
    `Corrective follow-up of the completed epic "${source.epic.title}" (\`${source.epic.id}\`), from the Sprint ${source.sprintOrdinal ?? '?'} retro of Run #${source.runNumber} (report \`${source.reportId}\`, revision ${source.reportRevision}). The completed epic, its runs, reports and scores stay as they are.`,
    '',
    'Each experiment below states a hypothesis, not a proven cause; its work is measured against its baseline after it lands.',
    '',
    ...experiments.map((experiment) => experimentContext(experiment).replace(/^## /, '### '))
  ].join('\n')
  return { title, intent, successCriteria: experiments.map(experimentGoal) }
}

/** The target kind the request names, or the default for the epic's status, checked against that status. */
function targetKind(source: Source, input: CorrectionsInput): CorrectionTargetKind {
  const completed = source.epic.status === 'completed'
  const kind: CorrectionTargetKind = input.target?.kind ?? (completed ? 'follow_up_epic' : 'new_sprint')
  if (completed && kind !== 'follow_up_epic') {
    fail('completed_epic', `Epic ${source.epic.id} is completed and read-only: its corrective work goes into a new follow-up epic (target follow_up_epic).`, { epicId: source.epic.id })
  }
  if (!completed && kind === 'follow_up_epic') {
    fail('invalid_input', `Epic ${source.epic.id} is not completed: its corrective work goes into a future sprint of its own draft (target new_sprint or sprint), not a follow-up epic.`, { epicId: source.epic.id })
  }
  return kind
}

/** Why a named sprint cannot take new corrective work, or null when it can. */
function sprintProblem(source: Source, sprintId: string, sprint: SprintDef | null, afterOrdinal: number): string | null {
  if (sprint === null) return `Sprint ${sprintId} is not in the draft of epic ${source.epic.id}: pick a sprint of that draft after Sprint ${afterOrdinal} or append a new one`
  if (sprint.ordinal <= afterOrdinal) {
    return `Sprint ${sprint.ordinal} is passed or in progress (corrections go after Sprint ${afterOrdinal}): pick a later sprint or append a new one`
  }
  return null
}

/** A future sprint of the unfinished epic's draft (named, or appended when `sprintId` is null). */
function sameEpicTarget(ctx: Ctx, source: Source, sprintId: string | null): SameEpicTarget {
  assertEpicOpen(source.epic)
  const { draft, base } = draftBase(ctx, source.epic)
  const afterOrdinal = passedOrdinal(ctx, source, base)
  const key = correctionTargetKey('same_epic', source.epic.id)
  if (sprintId === null) return { kind: 'new_sprint', key, epic: source.epic, draft, base, afterOrdinal, sprint: null, problem: null }
  const sprint = base.sprints.find((item) => item.id === sprintId) ?? null
  return { kind: 'sprint', key, epic: source.epic, draft, base, afterOrdinal, sprint, problem: sprintProblem(source, sprintId, sprint, afterOrdinal) }
}

/** The open follow-up epic an earlier request of this source epic created, holding one of the selected experiments' work. */
function openFollowUp(ctx: Ctx, key: string, existing: ReadonlyMap<string, CorrectionExistingView | null>): EpicRow | null {
  for (const found of existing.values()) {
    if (found !== null && found.key.endsWith(`/${key}`)) {
      const epic = loadEpicRow(ctx, found.epicId)
      if (epic.status !== 'completed') return epic
    }
  }
  return null
}

/**
 * The earliest open follow-up epic of the source epic holding corrective work of any of its experiments (in its draft or
 * a saved revision): new experiments join it rather than open another follow-up beside it.
 */
function heldFollowUp(ctx: Ctx, sourceEpicId: string, key: string): EpicRow | null {
  const pattern = `%${CORRECTION_MARKER_PREFIX}%/${key}#%`
  const row = ctx.db.get<{ id: string }>(
    `SELECT e.id FROM epics e
     WHERE e.status <> 'completed' AND json_extract(e.provenance_json, '$.sourceEpicId') = ? AND json_extract(e.provenance_json, '$.kind') IS NULL
       AND (EXISTS (SELECT 1 FROM drafts d WHERE d.epic_id = e.id AND d.bundle_json LIKE ?) OR EXISTS (SELECT 1 FROM plan_revisions p WHERE p.epic_id = e.id AND p.bundle_json LIKE ?))
     ORDER BY e.created_at, e.id LIMIT 1`,
    sourceEpicId,
    pattern,
    pattern
  )
  return row === undefined ? null : loadEpicRow(ctx, row.id)
}

function resolveTarget(ctx: Ctx, source: Source, input: CorrectionsInput, existing: ReadonlyMap<string, CorrectionExistingView | null>): Target {
  if (targetKind(source, input) !== 'follow_up_epic') {
    return sameEpicTarget(ctx, source, input.target?.kind === 'sprint' ? input.target.sprintId : null)
  }
  const key = correctionTargetKey('follow_up', source.epic.id)
  const epic = openFollowUp(ctx, key, existing) ?? heldFollowUp(ctx, source.epic.id, key)
  if (epic !== null) {
    const { draft, base } = draftBase(ctx, epic)
    return { kind: 'follow_up_epic', key, title: base.epic.title, base, deps: draftDeps(ctx, epic.id), reuse: { epic, draft } }
  }
  const title = followUpTitle(source, input)
  const deps = draftDeps(ctx)
  const ids = { sprintId: deps.newId('sprint'), ticketId: deps.newId('ticket'), ticketKey: deps.nextKey() }
  const base = createInitialBundle({ title, intent: '', successCriteria: [], ownerRole: null }, ids)
  return { kind: 'follow_up_epic', key, title, base, deps, reuse: null }
}

// ---------------------------------------------------------------------------------------------------------------
// Each experiment

/** Where an experiment's corrective work already is: any draft first, then the latest saved revision holding it. */
function existingCorrections(ctx: Ctx, experimentId: string): CorrectionExistingView | null {
  for (const row of markedBundles(ctx, experimentId)) {
    const found = correctionsOf(JSON.parse(row.bundle_json) as PlanBundle, experimentId)
    const first = found.find((item) => item.marker.role === 'work') ?? found[0]
    if (first !== undefined) {
      const tickets = [...new Map(found.map((item) => [item.ticket.id, item.ticket])).values()]
      return {
        key: first.marker.key,
        payloadHash: first.marker.payloadHash,
        epicId: row.epic_id,
        holder: row.holder,
        revisionNumber: row.number,
        ticketIds: tickets.map((ticket) => ticket.id),
        keys: tickets.map((ticket) => ticket.key)
      }
    }
  }
  return null
}

/** Why an experiment cannot become same-repository work as it is (empty: it can). */
function blockers(ctx: Ctx, experiment: RetroExperiment): string[] {
  const read = experimentStanding(ctx, experiment.id)
  const problems: string[] = []
  if (read.withdrawn) problems.push('a later revision of its sprint report left it out (withdrawn)')
  if (FINAL_EXPERIMENT_STATUSES.includes(read.status)) problems.push(`it is ${read.status}`)
  problems.push(...executionProblems(experiment))
  const { destination } = experiment
  if (destination.kind === 'darkmechanicus_source') {
    problems.push('its destination is the Dark Mechanicus source, another repository: cross-repository corrective work is created through that destination, not here')
  } else if (destination.repository !== null && !(ctx.repositories() ?? []).includes(destination.repository)) {
    problems.push(`its repository "${destination.repository}" is not a repository of this folder`)
  }
  return problems
}

interface Assessed {
  view: CorrectionExperimentView
  items: CorrectiveItem[]
}

/** What one request asks of every selected experiment: the target, the Fireguard choice and the person's edits. */
interface Ask {
  target: Target
  input: CorrectionsInput
  edits: CorrectionWorkEdit[]
}

function targetPayload(ask: Ask): unknown {
  const { target, input } = ask
  if (input.target?.kind === 'sprint') return { kind: target.kind, sprintId: input.target.sprintId }
  return target.kind === 'follow_up_epic' ? { kind: target.kind, title: input.target?.kind === 'follow_up_epic' ? (input.target.title ?? null) : null } : { kind: target.kind }
}

/**
 * The content hash of what the request asks for an experiment: its definition without its source reference, whose
 * form changes when a later report revision restates it (`own` becomes `earlier`; the key already names the source
 * report and the experiment), with the source assessment, the target, the Fireguard choice and its edits.
 */
function payloadHashOf(experiment: RetroExperiment, ask: Ask, edits: CorrectionWorkEdit[]): string {
  const { source, ...definition } = experiment
  return contentHash({ definition, assessmentId: source.assessmentId, target: targetPayload(ask), fireguard: ask.input.fireguard ?? true, edits })
}

function existingProblem(existing: CorrectionExistingView, key: string): string {
  const holder = existing.holder === 'draft' ? 'its draft' : `saved revision ${existing.revisionNumber ?? '?'}`
  return `already created as ${existing.keys.join(', ')} in epic ${existing.epicId} (${holder}) under key ${existing.key} with ${existing.key === key ? 'another payload' : 'another target'}; an experiment is created once`
}

/** Why the target cannot take this experiment's new work (a named sprint that is missing, passed or in progress). */
function targetProblems(target: Target): string[] {
  return target.kind === 'follow_up_epic' || target.problem === null ? [] : [target.problem]
}

function assess(ctx: Ctx, experiment: RetroExperiment, ask: Ask, existing: CorrectionExistingView | null): Assessed {
  const mine = ask.edits.filter((edit) => edit.experimentId === experiment.id).sort((a, b) => a.index - b.index)
  const key = correctionKey(experiment, ask.target.key)
  const payloadHash = payloadHashOf(experiment, ask, mine)
  const base = { experimentId: experiment.id, concern: experiment.concern ?? null, key, payloadHash }
  if (existing !== null) {
    const same = existing.key === key && existing.payloadHash === payloadHash
    return { view: { ...base, state: same ? 'created' : 'conflict', problems: same ? [] : [existingProblem(existing, key)], restatement: null, existing }, items: [] }
  }
  const generated = correctiveItems(experiment, mine)
  const problems = [...targetProblems(ask.target), ...blockers(ctx, experiment), ...generated.problems]
  const restatement = executionProblems(experiment).length > 0 ? restatementOf(experiment) : null
  return {
    view: { ...base, state: problems.length === 0 ? 'ready' : 'blocked', problems, restatement, existing: null },
    items: problems.length === 0 ? generated.items : []
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The plan

interface Planned {
  source: Source
  target: Target
  experiments: CorrectionExperimentView[]
  ready: RetroExperiment[]
  request: CorrectionRequest
}

function sprintGoal(source: Source, ready: RetroExperiment[]): string {
  return `Corrective work from the Sprint ${source.sprintOrdinal ?? '?'} retro (report revision ${source.reportRevision}): experiments ${ready.map((item) => item.id).join(', ')}.`
}

/** A follow-up epic not saved yet takes the work in its first sprint; a reused one that was saved, in a sprint appended last. */
function followUpPlacement(source: Source, target: FollowUpTarget, ready: RetroExperiment[]): CorrectionPlacement {
  if (target.reuse !== null && target.reuse.epic.current_revision_id !== null) return { kind: 'append', goal: sprintGoal(source, ready) }
  return { kind: 'sprint', sprintId: sortedSprints(target.base)[0]?.id ?? '', goal: target.reuse === null ? sprintGoal(source, ready) : null }
}

/** Where the work goes: the named sprint, a sprint appended after the last one, or a follow-up epic's sprint. */
function placementOf(source: Source, target: Target, ready: RetroExperiment[]): CorrectionPlacement {
  if (target.kind === 'follow_up_epic') return followUpPlacement(source, target, ready)
  return target.kind === 'sprint' ? { kind: 'sprint', sprintId: target.sprint?.id ?? '', goal: null } : { kind: 'append', goal: sprintGoal(source, ready) }
}

/** The follow-up epic's content as the work leaves it: a new one's intent and criteria, or a reused one's criteria plus the new experiments'. */
function withFollowUpContent(source: Source, target: FollowUpTarget, ready: RetroExperiment[]): void {
  const { epic } = target.base
  if (target.reuse === null) {
    const content = followUpContent(source, target.title, ready)
    target.base.epic = { ...epic, intent: content.intent, successCriteria: normalizeCriteria(content.successCriteria, [], 's') }
    return
  }
  if (ready.length > 0) {
    const criteria = [...epic.successCriteria.map(({ id, text }) => ({ id, text })), ...ready.map(experimentGoal)]
    target.base.epic = { ...epic, successCriteria: normalizeCriteria(criteria, epic.successCriteria, 's') }
  }
}

function plan(ctx: Ctx, input: CorrectionsInput): Planned {
  const source = loadSource(ctx, input.reportId)
  const selected = selectedExperiments(source, input)
  // Work already created is looked up first: a repeat answers `created` whatever the target has become since.
  const existing = new Map(selected.map((experiment) => [experiment.id, existingCorrections(ctx, experiment.id)]))
  const target = resolveTarget(ctx, source, input, existing)
  const ask: Ask = { target, input, edits: checkedEdits(input) }
  const assessed = selected.map((experiment) => assess(ctx, experiment, ask, existing.get(experiment.id) ?? null))
  const ready = selected.filter((_experiment, index) => assessed[index]?.view.state === 'ready')
  if (target.kind === 'follow_up_epic') withFollowUpContent(source, target, ready)
  const request: CorrectionRequest = {
    placement: placementOf(source, target, ready),
    items: assessed.flatMap((item) => item.items),
    fireguard: input.fireguard ?? true,
    markers: new Map(assessed.map((item) => [item.view.experimentId, { key: item.view.key, payloadHash: item.view.payloadHash }]))
  }
  return { source, target, experiments: assessed.map((item) => item.view), ready, request }
}

function validationOf(ctx: Ctx, epicId: string | null, bundle: PlanBundle): ValidationReport {
  const report = validatePlan(bundle, { repositories: ctx.repositoryEntries() })
  return epicId === null ? report : withRunWarnings(ctx, epicId, bundle, report)
}

/** The errors the corrective work brings into the plan; the draft's own earlier errors are the person's. */
function newErrors(before: ValidationReport, after: ValidationReport): ValidationIssue[] {
  const known = new Set(before.errors.map((issue) => `${issue.code}\u0000${issue.message}`))
  return after.errors.filter((issue) => !known.has(`${issue.code}\u0000${issue.message}`))
}

function nextSteps(planned: Planned): string[] {
  const { source, target } = planned
  const record = 'Once the work is planned, the orchestrator records each experiment as scheduled (record_experiment_event) with a note naming its tickets.'
  if (target.kind === 'follow_up_epic') {
    return [
      'Review the follow-up epic\'s draft: its tickets, criteria, dependencies, Fireguard ticket and acceptance node.',
      'Bind its branch and Save the draft; then start a run of it with the normal run controls. Its sprint stops at a human checkpoint.',
      'Nothing runs, is approved or is retried because of a grade: the completed epic and its reports stay as they are.',
      record
    ]
  }
  return [
    `Review epic ${source.epic.id}'s draft: the corrective tickets, criteria, dependencies, Fireguard ticket and acceptance node.`,
    `Save the draft, then adopt the saved revision into the run at its checkpoint (or Approve with redraft, which saves, adopts, approves and advances in one approval). Sprint ${source.sprintOrdinal ?? '?'}'s gates still apply; the run reaches the corrective work only through the normal advance.`,
    'Nothing runs, is approved or is retried because of a grade, and the checkpoint stays human.',
    record
  ]
}

function notesOf(ctx: Ctx, planned: Planned): string[] {
  const { source, target } = planned
  if (target.kind === 'follow_up_epic') return []
  const notes: string[] = []
  const pending = source.leftovers.filter((ticketId) => target.base.sprints.find((sprint) => sprint.id === source.sprintId)?.ticketIds.includes(ticketId) === true)
  if (pending.length > 0) {
    notes.push(
      `The Sprint ${source.sprintOrdinal ?? '?'} retro lists ${pending.length} leftover(s) still in that sprint: redrafting moves them to the sprint right after it, ahead of its acceptance node, as before.`
    )
  }
  const waiting = ctx.db.get<{ number: number }>("SELECT number FROM runs WHERE epic_id = ? AND state = 'awaiting_checkpoint'", source.epic.id)
  if (waiting !== undefined) notes.push(`Run #${waiting.number} waits at its checkpoint: its plan_current gate stays unmet until the saved draft is adopted (or the draft discarded).`)
  if (target.kind === 'sprint' && target.sprint !== null && planned.request.items.length > 0) {
    const node = target.base.tickets.find((ticket) => target.sprint?.ticketIds.includes(ticket.id) === true && ticket.kind === 'acceptance')
    if (node === undefined) notes.push(`Sprint ${target.sprint.ordinal} has no acceptance node, so nothing covers the corrective tickets there.`)
  }
  return notes
}

interface Outcome {
  applied: AppliedCorrections | null
  /** Whether the applied ids are written (a creation) or only planned (a preview). */
  known: boolean
  epicId: string | null
  draftRevision: number | null
  validation: ValidationReport
}

/** The epic that takes new work: the unfinished source epic, a reused follow-up epic, or null for one still to be created. */
function targetEpic(target: Target): EpicRow | null {
  return target.kind === 'follow_up_epic' ? (target.reuse?.epic ?? null) : target.epic
}

function targetDraft(target: Target): DraftRow | null {
  return target.kind === 'follow_up_epic' ? (target.reuse?.draft ?? null) : target.draft
}

function sourceView(source: Source): CorrectionPlanView['source'] {
  return {
    epicId: source.epic.id,
    epicTitle: source.epic.title,
    epicStatus: source.epic.status,
    runId: source.runId,
    sprintId: source.sprintId,
    sprintOrdinal: source.sprintOrdinal,
    reportId: source.reportId,
    reportRevision: source.reportRevision
  }
}

/** The target sprint as applied, or as it stands when nothing was added (undefined: a sprint still to be appended). */
function targetSprint(planned: Planned, outcome: Outcome): { sprint: SprintDef | undefined; goal: string; ordinal: number } {
  const { target, request } = planned
  const { placement } = request
  const bundle = outcome.applied?.bundle ?? target.base
  const sprintId = outcome.applied?.sprintId ?? (placement.kind === 'sprint' ? placement.sprintId : undefined)
  const sprint = bundle.sprints.find((item) => item.id === sprintId)
  if (sprint === undefined) return { sprint, goal: placement.goal ?? '', ordinal: plannedOrdinal(planned) }
  return { sprint, goal: sprint.goal, ordinal: sprint.ordinal }
}

/** The ordinal of a sprint still to be added: after the last one, or the first of a follow-up epic still to be created. */
function plannedOrdinal(planned: Planned): number {
  return planned.request.placement.kind === 'append' ? sortedSprints(planned.target.base).length + 1 : 1
}

/** Where the work goes; a sprint only planned (appended, or in a follow-up epic still to be created) has no id yet. */
function targetView(planned: Planned, outcome: Outcome): CorrectionPlanView['target'] {
  const { target, request } = planned
  const { sprint, goal, ordinal } = targetSprint(planned, outcome)
  const unborn = target.kind === 'follow_up_epic' && target.reuse === null
  const named = outcome.known || (request.placement.kind === 'sprint' && !unborn)
  const common = { epicId: outcome.epicId, sprintId: named ? (sprint?.id ?? null) : null, sprintGoal: goal, sprintOrdinal: ordinal }
  if (target.kind === 'follow_up_epic') return { ...common, kind: target.kind, epicTitle: target.title, afterOrdinal: null }
  return { ...common, kind: target.kind, epicTitle: target.epic.title, afterOrdinal: target.afterOrdinal }
}

/** Every epic that holds work already created for the selected experiments, with those experiments. */
function createdIn(planned: Planned): CorrectionPlanView['createdIn'] {
  const byEpic = new Map<string, string[]>()
  for (const item of planned.experiments) {
    if (item.state === 'created' && item.existing !== null) byEpic.set(item.existing.epicId, [...(byEpic.get(item.existing.epicId) ?? []), item.experimentId])
  }
  return [...byEpic].map(([epicId, experimentIds]) => ({ epicId, experimentIds }))
}

function viewOf(ctx: Ctx, planned: Planned, outcome: Outcome): CorrectionPlanView {
  // A new follow-up epic's acceptance node comes with the epic, which a preview does not create yet.
  const unborn = planned.target.kind === 'follow_up_epic' && planned.target.reuse === null && !outcome.known
  return {
    source: sourceView(planned.source),
    target: targetView(planned, outcome),
    experiments: planned.experiments,
    createdIn: createdIn(planned),
    tickets: (outcome.applied?.tickets ?? []).map((ticket) => (unborn ? { ...ticket, existing: false, ticketId: null } : ticket)),
    dependencies: outcome.applied?.dependencies ?? [],
    draftRevision: outcome.draftRevision,
    validation: outcome.validation,
    nextSteps: nextSteps(planned),
    notes: notesOf(ctx, planned)
  }
}

/**
 * Read only. What creating the corrective work for the selected experiments of a report revision would do: each
 * experiment's state (`ready`, `created`, `conflict` or `blocked` with its problems, and a restatement for unsized or
 * vague work), the target (a future sprint of an unfinished epic's draft, one appended after its last sprint, or a new
 * follow-up epic of a completed one), the tickets with their size, criteria and dependencies, the Fireguard ticket, the
 * acceptance node's covering criteria, and the target draft's validation. Nothing is written.
 */
export function previewCorrections(ctx: Ctx, raw: CorrectionsInput): CorrectionPlanView {
  requireCapability(ctx.session, 'read')
  const input = parseInput(correctionsInput, raw, 'corrections') as CorrectionsInput
  return ctx.db.tx(() => {
    const planned = plan(ctx, input)
    const { target } = planned
    const epicId = targetEpic(target)?.id ?? null
    const draftRevision = targetDraft(target)?.draft_revision ?? null
    if (planned.request.items.length === 0) {
      return viewOf(ctx, planned, { applied: null, known: false, epicId, draftRevision, validation: validationOf(ctx, epicId, target.base) })
    }
    const deps = target.kind === 'follow_up_epic' ? target.deps : draftDeps(ctx, target.epic.id)
    const applied = applyCorrections(target.base, planned.request, deps, { known: false })
    return viewOf(ctx, planned, { applied, known: false, epicId, draftRevision, validation: validationOf(ctx, epicId, applied.bundle) })
  })
}

/**
 * Refuses the whole request when any selected experiment conflicts with earlier work, when the named sprint cannot take
 * new work (`not_found` when the draft has no such sprint, `conflict` when it is passed or in progress), or when any
 * experiment is blocked.
 */
function requireCreatable(planned: Planned): void {
  const conflicts = planned.experiments.filter((item) => item.state === 'conflict')
  if (conflicts.length > 0) {
    fail('idempotency_mismatch', `Corrective work was already created differently: ${conflicts.map((item) => `${item.experimentId} ${item.problems.join('; ')}`).join('. ')}.`, {
      experiments: conflicts.map((item) => ({ experimentId: item.experimentId, key: item.key, existing: item.existing }))
    })
  }
  const { target } = planned
  if (target.kind === 'sprint' && target.problem !== null && planned.experiments.some((item) => item.state === 'blocked' && item.problems.includes(target.problem ?? ''))) {
    fail(target.sprint === null ? 'not_found' : 'conflict', `Not created: ${target.problem}. Nothing was written.`)
  }
  const blocked = planned.experiments.filter((item) => item.state === 'blocked')
  if (blocked.length > 0) {
    fail('conflict', `Not created: ${blocked.map((item) => `${item.experimentId} ${item.problems.join('; ')}`).join('. ')}. Deselect it, or restate it in a new report revision (by its id, from its original { reportId, assessmentId }) with sized, specific work.`, {
      experiments: blocked.map((item) => ({ experimentId: item.experimentId, problems: item.problems }))
    })
  }
}

/**
 * The draft revision the preview read still holds: null (no draft then) refuses a draft opened since, and a number
 * refuses a draft changed since or gone (there is no open draft now). Undefined checks nothing.
 */
function assertExpectedDraft(open: DraftRow | null, expected: number | null | undefined): void {
  if (expected === undefined) return
  if (open !== null) {
    assertDraftRevision(open, expected)
  } else if (expected !== null) {
    fail('conflict', `The draft is gone (your preview read revision ${expected}; there is no open draft now). Reload and reapply your edit.`, { currentDraftRevision: null })
  }
}

/**
 * Applies the work to `base` (the target draft as planned: a reused follow-up epic's gains the new experiments' success
 * criteria), refusing any validation error it would bring, and writes the draft. The event names the source run only
 * for work in the source epic: a follow-up epic's draft is not that run's.
 */
function written(ctx: Ctx, target: { epicId: string; draft: DraftRow; base: PlanBundle }, planned: Planned): { applied: AppliedCorrections; draftRevision: number; validation: ValidationReport } {
  const { epicId, draft, base } = target
  const applied = applyCorrections(base, planned.request, draftDeps(ctx, epicId), { known: true })
  const validation = validationOf(ctx, epicId, applied.bundle)
  const errors = newErrors(validationOf(ctx, epicId, JSON.parse(draft.bundle_json) as PlanBundle), validation)
  if (errors.length > 0) {
    fail('invalid_graph', `The corrective work would make the plan invalid: ${errors.map((issue) => issue.message).join(' ')}`, { errors })
  }
  const draftRevision = writeDraft(ctx, draft, applied.bundle)
  appendEvent(ctx, {
    kind: 'draft.corrected',
    epicId,
    ...(epicId === planned.source.epic.id ? { runId: planned.source.runId } : {}),
    payload: {
      reportId: planned.source.reportId,
      sourceEpicId: planned.source.epic.id,
      experiments: planned.ready.map((item) => item.id),
      keys: planned.experiments.filter((item) => item.state === 'ready').map((item) => item.key),
      sprintId: applied.sprintId,
      added: [...applied.refMap.values()],
      draftRevision
    }
  })
  return { applied, draftRevision, validation }
}

/** Every selected experiment was already created by an identical request: nothing to write. */
function unchanged(ctx: Ctx, planned: Planned): CorrectionsResultView {
  const { target } = planned
  const epicId = targetEpic(target)?.id ?? createdIn(planned)[0]?.epicId ?? null
  const draftRevision = targetDraft(target)?.draft_revision ?? null
  return { ...viewOf(ctx, planned, { applied: null, known: false, epicId, draftRevision, validation: validationOf(ctx, epicId, target.base) }), changed: false }
}

/** A new backlog epic linked to the completed source epic, whose draft then takes the work. */
function createFollowUp(ctx: Ctx, planned: Planned, target: FollowUpTarget): CorrectionsResultView {
  requireCapability(ctx.session, 'epic.create')
  const { source } = planned
  const epic = createEpic(ctx, {
    ...followUpContent(source, target.title, planned.ready),
    provenance: { sourceEpicId: source.epic.id, note: `Corrective follow-up from report ${source.reportId} (Sprint ${source.sprintOrdinal ?? '?'} of Run #${source.runNumber}): ${planned.ready.map((item) => item.id).join(', ')}.` }
  })
  const draft = loadDraftRow(ctx, epic.id) ?? fail('internal', `Epic ${epic.id} has no draft.`)
  const base = JSON.parse(draft.bundle_json) as PlanBundle
  const followUp: Planned = { ...planned, target: { ...target, base } }
  followUp.request = { ...planned.request, placement: placementOf(source, followUp.target, planned.ready) }
  const done = written(ctx, { epicId: epic.id, draft, base }, followUp)
  return { ...viewOf(ctx, followUp, { ...done, known: true, epicId: epic.id }), changed: true }
}

/**
 * Creates the corrective work for the selected experiments of a report revision as DRAFT work: in the unfinished
 * source epic's draft (a future sprint, or a sprint appended after the last one with a human checkpoint), or for a
 * completed source epic in the open follow-up epic an earlier request created for it, else in a new follow-up epic
 * linked to it (backlog, never saved). Each experiment's tickets carry its stable key, so a repeat of the same request
 * adds nothing (`changed: false`) and a different request for an experiment already created is refused with
 * `idempotency_mismatch`; a named sprint the draft lacks with `not_found` and one passed or in progress with `conflict`;
 * a blocked experiment refuses the whole request with `conflict`, a stale `expectedDraftRevision` with `conflict` (null,
 * as a preview that found no draft reads it, refuses once the target epic has an open draft; a number refuses a draft
 * changed or gone since), and work that would make the plan invalid with `invalid_graph`. Nothing is
 * saved, adopted, started, approved, granted or continued.
 */
export function createCorrections(ctx: Ctx, raw: CreateCorrectionsInput): CorrectionsResultView {
  requireCapability(ctx.session, 'draft.edit')
  const input = parseInput(createCorrectionsInput, raw, 'corrections') as CreateCorrectionsInput
  return ctx.db.tx(() => {
    const planned = plan(ctx, input)
    requireCreatable(planned)
    const { target } = planned
    if (planned.request.items.length === 0) return unchanged(ctx, planned)
    const epic = targetEpic(target)
    // A preview that read no draft (null) finds one opened since stale; one that read a draft finds it changed or gone.
    assertExpectedDraft(targetDraft(target), input.expectedDraftRevision)
    if (epic === null) return createFollowUp(ctx, planned, target as FollowUpTarget)
    const draft = ensureDraft(ctx, epic)
    const done = written(ctx, { epicId: epic.id, draft, base: target.base }, planned)
    return { ...viewOf(ctx, planned, { ...done, known: true, epicId: epic.id }), changed: true }
  })
}
