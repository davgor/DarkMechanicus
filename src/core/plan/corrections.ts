/**
 * Corrective work from retro experiments (`src/shared/domain/corrections.ts`), the pure part: the stable correction
 * marker every created ticket carries, finding the work an experiment already produced in a bundle, the tickets an
 * experiment's proposed work becomes, and applying them to a draft bundle through the ordinary draft ops (a corrective
 * sprint or an existing future one, the work, its Fireguard ticket, the dependencies and the acceptance node's covers).
 *
 * The marker is a `doc` reference whose location names the experiment's source report, the experiment and the target
 * (`darkmechanicus:correction/<source report>/<experiment>/<target>#work/<index>`, or `#fireguard` for its Fireguard
 * ticket, `#fireguard/<repository>` in a folder of repositories) and whose hash is the payload hash of the request that
 * created it. It travels with the ticket through Save, adoption and the portable snapshots, and neither a rename nor a
 * references edit touches it (`plan/correctionMarker.ts`), so a repeat recognizes the work by identity, never by title.
 */
import type { DraftOp } from '../../shared/domain/api'
import type { EpicProvenance, PlanBundle, TicketContent, TicketReference, TicketSize } from '../../shared/domain/bundle'
import type {
  CorrectionCriterionView,
  CorrectionPrerequisite,
  CorrectionTicketView,
  CorrectionWorkEdit
} from '../../shared/domain/corrections'
import type { CrossRepoResultEvidence, RetroExperiment, SealedAssessmentRef } from '../../shared/domain/experiments'
import { contentHash } from '../canonical'
import { fail } from '../errors'
import { acceptanceNodeOf, isAcceptanceTicket } from './acceptance'
import { CORRECTION_MARKER_PREFIX } from './correctionMarker'
import { applyDraftOps, type DraftDeps } from './draftOps'
import { sortedSprints } from './graph'
import { vagueness } from './experiments'
import { parseScorecardSnapshot, snapshotHashOf } from '../space/snapshot'

const MARKER_PATTERN = /^darkmechanicus:correction\/([^/#]+)\/([^/#]+)\/([^#]+)#(?:work\/(\d+)|fireguard(?:\/[^/#]+)?)$/

/** The ref of the acceptance node in a request's ticket list. */
const ACCEPTANCE_REF = 'acceptance'

/** The ref of the Fireguard ticket of a repository's corrective work (null: a single-repository project). */
function fireguardRef(repo: string | null): string {
  return repo === null ? 'fireguard' : `fireguard:${repo}`
}

/** The target part of a correction key: a future sprint of the unfinished epic, or a follow-up of a completed one. */
export function correctionTargetKey(kind: 'same_epic' | 'follow_up', sourceEpicId: string): string {
  return kind === 'same_epic' ? `epic:${sourceEpicId}` : `follow-up:${sourceEpicId}`
}

/**
 * An experiment's stable idempotency key: the report its source assessment belongs to (every restatement keeps it), the
 * experiment and the target. Neither a title nor a report revision takes part, so it survives renames and resubmissions.
 */
export function correctionKey(experiment: RetroExperiment, target: string): string {
  return `${experiment.source.reportId}/${experiment.id}/${target}`
}

/** The idempotency key of a cross-repository request from project `from` to the Dark Mechanicus source `to`. */
export function crossRepoCorrectionKey(experiment: RetroExperiment, from: string, to: string): string {
  return correctionKey(experiment, `from:${from}/to:${to}`)
}

/** The seal over a carried cross-repository result: the canonical hash of every other field. */
export function crossRepoSealOf(carried: Omit<CrossRepoResultEvidence, 'seal'> & { seal?: string }): string {
  const { seal: _sealed, ...content } = carried
  return contentHash(content)
}

/**
 * Why a result's carried cross-repository evidence cannot be trusted here, or null. It must cite a grade (never a stated
 * value) of an epic that is not one of this project's (`own`), for an experiment aimed at the Dark Mechanicus source;
 * be bound to this very request (project, key, epic: the key is the one this project's request to that project has);
 * hold only that epic's starts and tickets; match its own seal (accepted times and planned sizes cannot change
 * unnoticed); and carry the cited scorecard whole, matching its seal and (on a write or an import, `regrade`) grading as
 * sealed. A read checks the seals only, as for this project's stored scorecards.
 */
export function crossRepoEvidenceProblem(
  carried: CrossRepoResultEvidence,
  experiment: RetroExperiment,
  here: { projectId: string; own: readonly string[]; regrade: boolean },
  cited: SealedAssessmentRef | null
): string | null {
  if (experiment.destination.kind !== 'darkmechanicus_source') return `carries a grade of another project, but experiment ${experiment.id} is not aimed at the Dark Mechanicus source`
  if (cited === null) return 'carries a grade of another project but cites none'
  if (here.own.includes(cited.epicId)) return `cites a grade of epic ${cited.epicId} of this project but carries one of another project`
  return bindingProblem(carried, experiment, here.projectId, cited) ?? sealProblem(carried, here.regrade)
}

/**
 * The carried evidence must be of this project's request to that project, of the cited epic and report only, and carry
 * the cited scorecard's own scope starts as that scorecard holds them (`startsProblem`).
 */
function bindingProblem(carried: CrossRepoResultEvidence, experiment: RetroExperiment, projectId: string, cited: SealedAssessmentRef): string | null {
  if (carried.projectId === projectId) return `carries a grade of project ${carried.projectId}, which is this project`
  const key = crossRepoCorrectionKey(experiment, projectId, carried.projectId)
  if (carried.key !== key) return `carries evidence of request ${carried.key}, not of this project's request ${key}`
  const card = carried.scorecard
  if (carried.epicId !== cited.epicId || card.epicId !== cited.epicId || card.report.reportId !== cited.reportId) {
    return `cites epic ${cited.epicId} (report ${cited.reportId}) but carries scorecard ${card.report.reportId} of epic ${card.epicId}`
  }
  const foreign = carried.corrections.some((ticket) => ticket.epicId !== carried.epicId) || carried.starts.some((item) => item.epicId !== carried.epicId)
  return foreign ? `carries tickets or scope starts of an epic other than ${carried.epicId}` : startsProblem(carried)
}

/**
 * The scope starts carried for the cited scorecard's own sprint must be exactly those the scorecard holds (its sprint,
 * run and tickets' first dispatches; another report revision of the sprint may grade other tickets, never another
 * sprint or run start): the scorecard is sealed and regraded, so where its own window starts is never the carrier's word.
 */
function startsProblem(carried: CrossRepoResultEvidence): string | null {
  const card = carried.scorecard
  const own = {
    epicId: carried.epicId,
    runId: card.runId,
    sprintId: card.sprintId,
    sprint: card.sprint.dispatchedAt,
    run: card.run.dispatchedAt,
    tickets: card.tickets.map((grade) => ({ ticketId: grade.subject.id, dispatchedAt: grade.dispatchedAt }))
  }
  const entries = carried.starts.filter((item) => item.runId === card.runId && item.sprintId === card.sprintId)
  const held = entries.some((item) => contentHash(item) === contentHash(own))
  const moved = entries.some((item) => item.sprint !== own.sprint || item.run !== own.run)
  return held && !moved ? null : `carries scope starts for sprint ${card.sprintId} of run ${card.runId} that are not those its scorecard ${card.report.reportId} holds`
}

/** The evidence and its scorecard must match their seals, and (`regrade`) the scorecard must grade as sealed. */
function sealProblem(carried: CrossRepoResultEvidence, regrade: boolean): string | null {
  const card = carried.scorecard
  if (crossRepoSealOf(carried) !== carried.seal) return 'carries evidence that does not match its seal'
  if (snapshotHashOf(card) !== card.snapshotHash) return `carries a scorecard of report ${card.report.reportId} that does not match its seal`
  if (!regrade) return null
  try {
    parseScorecardSnapshot(card)
    return null
  } catch {
    return `carries a scorecard of report ${card.report.reportId} that does not grade as sealed`
  }
}

/** A correction marker as read back from a ticket's references. */
interface CorrectionMarker {
  key: string
  sourceReportId: string
  experimentId: string
  target: string
  role: 'work' | 'fireguard'
  /** The proposed-work index for `work`; null for `fireguard`. */
  index: number | null
  payloadHash: string
}

/** The marker of an experiment's work item `index`, or of its Fireguard ticket (for `repo` in a folder of repositories). */
function markerReference(marker: Pick<CorrectionMarker, 'key' | 'experimentId' | 'payloadHash'>, part: { index: number } | { repo: string | null }): TicketReference {
  const { key, experimentId, payloadHash } = marker
  const work = 'index' in part
  const label = work ? `Corrective work ${part.index} of experiment ${experimentId}` : `Fireguard for experiment ${experimentId}`
  const suffix = work ? `work/${part.index}` : part.repo === null ? 'fireguard' : `fireguard/${part.repo}`
  return { kind: 'doc', label, location: `${CORRECTION_MARKER_PREFIX}${key}#${suffix}`, hash: payloadHash, remoteOnly: false }
}

/** The correction markers of a ticket (a Fireguard ticket shared by several experiments carries one each). */
function markersOf(ticket: TicketContent): CorrectionMarker[] {
  return ticket.references.flatMap((reference) => {
    const match = reference.kind === 'doc' && reference.hash !== null ? MARKER_PATTERN.exec(reference.location) : null
    if (match === null || reference.hash === null) return []
    const [, sourceReportId = '', experimentId = '', target = '', index] = match
    return [
      {
        key: `${sourceReportId}/${experimentId}/${target}`,
        sourceReportId,
        experimentId,
        target,
        role: index === undefined ? 'fireguard' : 'work',
        index: index === undefined ? null : Number.parseInt(index, 10),
        payloadHash: reference.hash
      } satisfies CorrectionMarker
    ]
  })
}

/** The tickets of a bundle created as corrective work for an experiment, each with its marker for that experiment. */
export function correctionsOf(bundle: PlanBundle, experimentId: string): { ticket: TicketContent; marker: CorrectionMarker }[] {
  return bundle.tickets.flatMap((ticket) => markersOf(ticket).filter((marker) => marker.experimentId === experimentId).map((marker) => ({ ticket, marker })))
}

const PAYLOAD_HASH = /^sha256:[0-9a-f]{64}$/

/** An epic as a correction check reads it: its provenance and the bundles of its saved revisions holding the markers. */
export interface CorrectionHolder {
  epicId: string
  provenance: EpicProvenance | null
  bundles: PlanBundle[]
}

/** The source epic a same-project follow-up names; a cross-repository correction epic (DM-190) is not a follow-up. */
function followUpSourceOf(holder: CorrectionHolder): string | null {
  const provenance = holder.provenance
  return provenance && !('kind' in provenance) ? provenance.sourceEpicId : null
}

/**
 * The key under which `holder` may hold `experiment`'s work in project `projectId`, or why it cannot hold it at all.
 * The experiment's own epic holds it under the same-epic key; a follow-up whose provenance names the experiment's epic
 * under the follow-up key; and a cross-repository correction epic of this very project (the active repository is the
 * Dark Mechanicus source and was chosen as its own target) under the request key from this project to itself, when
 * its provenance names this project on both sides, the experiment's epic, the experiment and that key.
 */
function holderKey(holder: CorrectionHolder, experiment: RetroExperiment, projectId: string | null): { key: string } | { problem: string } {
  const sourceEpicId = experiment.source.epicId
  if (holder.epicId === sourceEpicId) return { key: correctionKey(experiment, correctionTargetKey('same_epic', sourceEpicId)) }
  if (followUpSourceOf(holder) === sourceEpicId) return { key: correctionKey(experiment, correctionTargetKey('follow_up', sourceEpicId)) }
  const key = projectId === null ? null : selfTargetedKey(holder.provenance, experiment, projectId)
  return key !== null ? { key } : { problem: `epic ${holder.epicId} is neither a follow-up of epic ${sourceEpicId} nor this project's own correction epic for experiment ${experiment.id}` }
}

/** The request key of a correction epic this project made for `experiment` in itself, or null when `provenance` is not one. */
function selfTargetedKey(provenance: EpicProvenance | null, experiment: RetroExperiment, projectId: string): string | null {
  if (provenance === null || !('kind' in provenance)) return null
  const key = crossRepoCorrectionKey(experiment, projectId, projectId)
  const { source, target } = provenance
  const named = source.epicId === experiment.source.epicId && source.experimentId === experiment.id && provenance.key === key
  return named && source.projectId === projectId && target.projectId === projectId ? key : null
}

/**
 * Why `holder` does not hold `experiment`'s corrective work in project `projectId`, or null when it does (`holderKey`
 * says which epics may, under which key). Every marker of the experiment carries that key (source report, experiment,
 * target) and one well-formed payload hash: a marker under another key or payload is not this experiment's work.
 * Without `projectId` only the experiment's own epic and its follow-ups count.
 */
export function correctionHolderProblem(holder: CorrectionHolder, experiment: RetroExperiment, projectId: string | null = null): string | null {
  const found = holderKey(holder, experiment, projectId)
  if ('problem' in found) return found.problem
  const { key } = found
  const markers = holder.bundles.flatMap((bundle) => correctionsOf(bundle, experiment.id).map((item) => item.marker))
  if (markers.length === 0) return `no saved revision of epic ${holder.epicId} holds corrective work of experiment ${experiment.id}`
  if (markers.some((marker) => marker.key !== key)) return `epic ${holder.epicId} holds work of experiment ${experiment.id} under another key than ${key}`
  const hashes = new Set(markers.map((marker) => marker.payloadHash))
  const [hash = ''] = hashes
  return hashes.size === 1 && PAYLOAD_HASH.test(hash) ? null : `the correction markers of experiment ${experiment.id} in epic ${holder.epicId} do not carry one payload hash`
}

/** The SQL `LIKE` pattern of a bundle that may hold an experiment's markers (a superset: `_` matches any character). */
export function markerLikePattern(experimentId: string): string {
  return `%${CORRECTION_MARKER_PREFIX}%/${experimentId}/%`
}

// ---------------------------------------------------------------------------------------------------------------
// The tickets an experiment's work becomes

/** One generated ticket of an experiment's proposed work, before it is added. */
export interface CorrectiveItem {
  ref: string
  experimentId: string
  index: number
  title: string
  body: string
  size: TicketSize | undefined
  acceptanceCriteria: string[]
  tags: string[]
  repo: string | null
  dependsOn: CorrectionPrerequisite[]
}

/** The ref of `proposedWork[index]` of an experiment. */
function workRef(experimentId: string, index: number): string {
  return `${experimentId}#${index}`
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const end = flat.search(/[.!?](\s|$)/)
  const sentence = end === -1 ? flat : flat.slice(0, end + 1)
  return sentence.length > 400 ? `${sentence.slice(0, 399)}…` : sentence
}

function guardrailText(experiment: RetroExperiment): string {
  return experiment.guardrails.map((item) => `${item.measure} ${item.comparator.replace('_', ' ')} ${item.threshold} ${item.unit}`).join('; ')
}

function changeText(experiment: RetroExperiment): string {
  const { expectedChange: change, window } = experiment
  return `${change.direction} by ${change.amount} ${change.unit} over the next ${window.count} ${window.basis}`
}

/** What the experiment is, written under the work it asks for: where it came from, the hypothesis and how it is measured. */
export function experimentContext(experiment: RetroExperiment): string {
  const { source, baseline } = experiment
  const concern = experiment.concern === undefined ? '' : ` (concern: ${experiment.concern})`
  return [
    `## Corrective experiment \`${experiment.id}\`${concern}`,
    '',
    `Drawn from the ${source.subject.level} grade \`${source.assessmentId}\` of report \`${source.reportId}\` (revision ${source.reportRevision}).`,
    '',
    `- Issue: ${experiment.issue.summary}`,
    `- Hypothesis (not a proven cause): ${experiment.hypothesis}`,
    `- Baseline: ${baseline.measure} = ${baseline.value} ${baseline.unit} (${baseline.state})`,
    `- Expected change: ${changeText(experiment)}`,
    `- Guardrails: ${guardrailText(experiment)}`,
    '',
    'Planned for the person to review: a grade never starts, approves or retries this work. The experiment is measured against this baseline after the work lands.'
  ].join('\n')
}

/** The success criterion of a follow-up epic for one experiment: its change, measured against its baseline and held by its guardrails (at least one). */
export function experimentGoal(experiment: RetroExperiment): string {
  const { baseline } = experiment
  return `Experiment ${experiment.id}: ${baseline.measure} (baseline ${baseline.value} ${baseline.unit}) moves ${changeText(experiment)}, holding ${guardrailText(experiment)}.`
}

function defaultCriteria(title: string, body: string): string[] {
  return [
    `${title}: the change the body describes is in place. ${firstSentence(body)}`,
    "Tests or a recorded demonstration exercise the change, and the project's existing checks still pass."
  ]
}

/** Why an edited work item cannot be created as it is: a blank title, a body that does not say what changes, blank criteria. */
function editProblems(at: string, edit: CorrectionWorkEdit | undefined, item: { title: string; body: string; acceptanceCriteria: string[] }): string[] {
  const vague = edit?.body === undefined ? null : vagueness(item)
  return [
    ...(item.title === '' ? [`the edited title of ${at} is blank`] : []),
    ...(vague === null ? [] : [`the edited body of ${at} "${item.title}" does not say what changes (${vague})`]),
    ...(item.acceptanceCriteria.length === 0 || item.acceptanceCriteria.some((text) => text === '') ? [`${at} "${item.title}" needs non-blank acceptance criteria`] : [])
  ]
}

/**
 * The tickets of an experiment's proposed work with the person's edits applied, and why they cannot be created as they
 * are (an edited title that is blank, an edited body that does not say what changes, an edit of work that does not
 * exist). The size is the experiment's; the repository is its destination's.
 */
export function correctiveItems(experiment: RetroExperiment, edits: readonly CorrectionWorkEdit[]): { items: CorrectiveItem[]; problems: string[] } {
  const problems = edits
    .filter((item) => item.index >= experiment.proposedWork.length)
    .map((edit) => `an edit names proposedWork[${edit.index}], which experiment ${experiment.id} does not have`)
  const shared = {
    experimentId: experiment.id,
    tags: ['corrective', ...(experiment.concern === undefined ? [] : [experiment.concern])],
    repo: experiment.destination.kind === 'source_repository' ? experiment.destination.repository : null
  }
  const context = experimentContext(experiment)
  const items = experiment.proposedWork.map((work, index): CorrectiveItem => {
    const edit = edits.find((item) => item.index === index)
    const title = (edit?.title ?? work.title).trim()
    const body = (edit?.body ?? work.body).trim()
    const acceptanceCriteria = (edit?.acceptanceCriteria ?? defaultCriteria(title, body)).map((text) => text.trim())
    problems.push(...editProblems(`proposedWork[${index}]`, edit, { title, body, acceptanceCriteria }))
    return { ...shared, ref: workRef(experiment.id, index), index, title, body: `${body}\n\n${context}`, size: work.size, acceptanceCriteria, dependsOn: edit?.dependsOn ?? [] }
  })
  return { items, problems }
}

// ---------------------------------------------------------------------------------------------------------------
// Applying them to a draft

/** Where the work goes in the bundle: a sprint appended last, an existing sprint, or the first sprint of a new epic. */
export type CorrectionPlacement = { kind: 'append'; goal: string } | { kind: 'sprint'; sprintId: string; goal: string | null }

export interface CorrectionRequest {
  placement: CorrectionPlacement
  items: CorrectiveItem[]
  fireguard: boolean
  /** Per experiment of `items`: the key and payload hash its markers record. */
  markers: ReadonlyMap<string, { key: string; payloadHash: string }>
}

export interface AppliedCorrections {
  bundle: PlanBundle
  sprintId: string
  /** Generated refs (work, `fireguard` or `fireguard:<repo>`) mapped to the ticket ids they received. */
  refMap: Map<string, string>
  tickets: CorrectionTicketView[]
  dependencies: { from: string; to: string }[]
}

function marker(request: CorrectionRequest, experimentId: string): { key: string; payloadHash: string } {
  return request.markers.get(experimentId) ?? fail('internal', `No correction key for experiment ${experimentId}.`)
}

/** An existing ticket a prerequisite names, by id or key; an unknown one is refused. */
function existingTicket(bundle: PlanBundle, ref: string): TicketContent {
  const ticket = bundle.tickets.find((item) => item.id === ref) ?? bundle.tickets.find((item) => item.key === ref)
  if (ticket === undefined || isAcceptanceTicket(ticket)) {
    fail('invalid_input', `Invalid prerequisite "${ref}": name a work ticket of the target draft by id or key.`, { ticket: ref })
  }
  return ticket
}

function dependencyOps(bundle: PlanBundle, request: CorrectionRequest): DraftOp[] {
  const generated = new Set(request.items.map((item) => item.ref))
  const ops: DraftOp[] = []
  for (const item of request.items) {
    for (const prerequisite of item.dependsOn) {
      const from = 'work' in prerequisite ? workRef(prerequisite.work.experimentId, prerequisite.work.index) : existingTicket(bundle, prerequisite.ticket).id
      if ('work' in prerequisite && !generated.has(from)) {
        fail('invalid_input', `Invalid prerequisite of ${item.ref}: ${from} is not work this request creates.`, { ref: item.ref, prerequisite: from })
      }
      ops.push({ op: 'add_dependency', from, to: item.ref })
    }
    if (request.fireguard) ops.push({ op: 'add_dependency', from: item.ref, to: fireguardRef(item.repo) })
  }
  return ops
}

/** The repositories the corrective items target, in order (one null in a single-repository project). */
function fireguardRepos(request: CorrectionRequest): (string | null)[] {
  return request.fireguard ? [...new Set(request.items.map((item) => item.repo))] : []
}

/**
 * One Fireguard ticket per repository the corrective items target (a ticket of a folder of repositories names its
 * repository), grading the tests that repository's corrective tickets added or changed, and requiring each of them.
 */
function fireguardOps(sprintId: string, request: CorrectionRequest): DraftOp[] {
  return fireguardRepos(request).map((repo) => {
    const items = request.items.filter((item) => item.repo === repo)
    const titles = items.map((item) => `"${item.title}"`).join(', ')
    return {
      op: 'add_ticket' as const,
      ref: fireguardRef(repo),
      sprint: sprintId,
      ticket: {
        title: 'Grade the corrective tests with Fireguard',
        body:
          `Run Fireguard once on the tests the corrective tickets added or changed (${titles}), at the project's configured thresholds, ` +
          "and fix what it reports within those tickets' scope. It runs after every corrective ticket, which it requires.",
        size: 'small' as const,
        ...(repo === null ? {} : { repo }),
        tags: ['fireguard', 'corrective'],
        acceptanceCriteria: [
          "Fireguard grades the tests the corrective tickets added or changed, and they meet the project's thresholds.",
          "Each finding Fireguard reports is fixed within the corrective tickets' scope, or recorded with its reason."
        ]
      }
    }
  })
}

function workOps(sprintId: string, request: CorrectionRequest): DraftOp[] {
  return request.items.map((item) => ({
    op: 'add_ticket' as const,
    ref: item.ref,
    sprint: sprintId,
    ticket: {
      title: item.title,
      body: item.body,
      ...(item.size === undefined ? {} : { size: item.size }),
      ...(item.repo === null ? {} : { repo: item.repo }),
      tags: item.tags,
      acceptanceCriteria: item.acceptanceCriteria
    }
  }))
}

/**
 * The markers each generated ticket carries, by ref: one per work item, and on a repository's Fireguard ticket one per
 * experiment it grades. A new ticket never brings markers of its own (`buildTicket`), so they are attached here only.
 */
function markersByRef(request: CorrectionRequest): Map<string, TicketReference[]> {
  const markers = new Map<string, TicketReference[]>()
  for (const item of request.items) {
    markers.set(item.ref, [markerReference({ ...marker(request, item.experimentId), experimentId: item.experimentId }, { index: item.index })])
  }
  for (const repo of fireguardRepos(request)) {
    const experiments = [...new Set(request.items.filter((item) => item.repo === repo).map((item) => item.experimentId))]
    markers.set(fireguardRef(repo), experiments.map((id) => markerReference({ ...marker(request, id), experimentId: id }, { repo })))
  }
  return markers
}

/** The bundle with each generated ticket carrying its markers. */
function marked(bundle: PlanBundle, refMap: ReadonlyMap<string, string>, request: CorrectionRequest): PlanBundle {
  const byId = new Map([...markersByRef(request)].map(([ref, references]) => [refMap.get(ref) ?? '', references]))
  return { ...bundle, tickets: bundle.tickets.map((ticket) => (byId.has(ticket.id) ? { ...ticket, references: byId.get(ticket.id) ?? [] } : ticket)) }
}

/** The acceptance node keeps its criteria and gains one covering each generated ticket. */
function coverOps(bundle: PlanBundle, sprintId: string, request: CorrectionRequest): DraftOp[] {
  const node = acceptanceNodeOf(bundle, sprintId)
  if (node === undefined) return []
  const covered = [
    ...request.items.map((item) => ({ text: `${item.title} meets its acceptance criteria.`, covers: item.ref })),
    ...fireguardRepos(request).map((repo) => ({ text: `The corrective tests${repo === null ? '' : ` of ${repo}`} pass Fireguard.`, covers: fireguardRef(repo) }))
  ]
  return [
    {
      op: 'update_ticket',
      ticket: node.id,
      patch: { acceptanceCriteria: [...node.acceptanceCriteria.map(({ id, text }) => ({ id, text })), ...covered] }
    }
  ]
}

/** Appends the corrective sprint (with its acceptance node, human checkpoint) when the placement asks for one. */
function placed(bundle: PlanBundle, placement: CorrectionPlacement, deps: DraftDeps): { bundle: PlanBundle; sprintId: string } {
  if (placement.kind === 'sprint') {
    const sprint = bundle.sprints.find((item) => item.id === placement.sprintId) ?? fail('not_found', `Sprint ${placement.sprintId} is not in the draft.`, { sprintId: placement.sprintId })
    const goal: DraftOp[] = placement.goal === null ? [] : [{ op: 'update_sprint', sprint: sprint.id, patch: { goal: placement.goal } }]
    return { bundle: goal.length === 0 ? bundle : applyDraftOps(bundle, goal, deps).bundle, sprintId: sprint.id }
  }
  const position = sortedSprints(bundle).length + 1
  const result = applyDraftOps(bundle, [{ op: 'add_sprint', ref: 'corrective', sprint: { goal: placement.goal, checkpoint: { mode: 'human' } }, position }], deps)
  return { bundle: result.bundle, sprintId: result.refMap['corrective'] ?? fail('internal', 'The corrective sprint got no id.') }
}

function criteriaView(criteria: TicketContent['acceptanceCriteria'], label: (id: string) => string): CorrectionCriterionView[] {
  return criteria.map((item) => ({ id: item.id, text: item.text, covers: item.covers === undefined ? null : label(item.covers) }))
}

/** How a view names a ticket (by ref, else key), and whether its id is final. */
interface ViewContext {
  label: (id: string) => string
  requires: (id: string) => string[]
  known: boolean
}

function ticketView(ticket: TicketContent, fields: Pick<CorrectionTicketView, 'ref' | 'role' | 'experimentId' | 'workIndex' | 'existing'>, context: ViewContext): CorrectionTicketView {
  return {
    ...fields,
    key: ticket.key,
    ticketId: context.known || fields.existing ? ticket.id : null,
    title: ticket.title,
    body: ticket.body,
    size: ticket.size ?? null,
    tags: ticket.tags,
    repo: ticket.repo ?? null,
    acceptanceCriteria: criteriaView(ticket.acceptanceCriteria, context.label),
    dependsOn: context.requires(ticket.id)
  }
}

/**
 * Adds the corrective work to a copy of `input` through the draft ops: the sprint (appended after the last one, with a
 * human checkpoint, or the given one), a ticket per item carrying its marker, a Fireguard ticket per repository requiring
 * each of its corrective tickets, the requested prerequisites, and a covering criterion per new ticket on the sprint's
 * acceptance node. `ids` says whether the ticket ids are final (a creation) or only planned (a preview: refs and planned keys).
 */
export function applyCorrections(input: PlanBundle, request: CorrectionRequest, deps: DraftDeps, ids: { known: boolean }): AppliedCorrections {
  const start = placed(input, request.placement, deps)
  const ops = [
    ...workOps(start.sprintId, request),
    ...fireguardOps(start.sprintId, request),
    ...dependencyOps(start.bundle, request),
    ...coverOps(start.bundle, start.sprintId, request)
  ]
  const result = applyDraftOps(start.bundle, ops, deps)
  const refMap = new Map(Object.entries(result.refMap))
  const bundle = marked(result.bundle, refMap, request)
  const refOf = new Map([...refMap].map(([ref, id]) => [id, ref]))
  const byId = new Map(bundle.tickets.map((ticket) => [ticket.id, ticket]))
  const label = (id: string): string => refOf.get(id) ?? byId.get(id)?.key ?? id
  const context: ViewContext = { label, requires: (id) => bundle.edges.filter((edge) => edge.to === id).map((edge) => label(edge.from)), known: ids.known }
  const tickets: CorrectionTicketView[] = []
  for (const item of request.items) {
    const ticket = byId.get(refMap.get(item.ref) ?? '')
    if (ticket !== undefined) tickets.push(ticketView(ticket, { ref: item.ref, role: 'work', experimentId: item.experimentId, workIndex: item.index, existing: false }, context))
  }
  for (const repo of fireguardRepos(request)) {
    const fireguard = byId.get(refMap.get(fireguardRef(repo)) ?? '')
    if (fireguard !== undefined) tickets.push(ticketView(fireguard, { ref: fireguardRef(repo), role: 'fireguard', experimentId: null, workIndex: null, existing: false }, context))
  }
  const node = acceptanceNodeOf(bundle, start.sprintId)
  if (node !== undefined) {
    const existing = input.tickets.some((ticket) => ticket.id === node.id)
    tickets.push(ticketView(node, { ref: ACCEPTANCE_REF, role: 'acceptance', experimentId: null, workIndex: null, existing }, context))
  }
  const generated = new Set(refMap.values())
  const dependencies = bundle.edges.filter((edge) => generated.has(edge.to)).map((edge) => ({ from: label(edge.from), to: label(edge.to) }))
  return { bundle, sprintId: start.sprintId, refMap, tickets, dependencies }
}
