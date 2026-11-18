/**
 * Pure view model for a sprint report's Improvement tab: the retro read as one chain, from the measured result (the
 * scorecard frozen with the report revision) to the findings read from it (`getRetroFindings`), the experiments the
 * retro drew from them, and the corrective work each one produced (`getExperiment`'s outcome). Also the corrective
 * planner's request, its staleness and the core's refusals in words. Nothing here grades, plans or writes: previews and
 * creations are the core's, and creating corrective work only ever writes DRAFT work the person reviews and saves.
 */
import type {
  CorrectionPlanView,
  CorrectionPrerequisite,
  CorrectionsInput,
  CorrectionsResultView,
  CorrectionTicketView,
  CorrectionWorkEdit
} from '../../../shared/domain/corrections'
import { EXPERIMENT_MEASURES, FINAL_EXPERIMENT_STATUSES, type ExperimentView, type RetroExperiment } from '../../../shared/domain/experiments'
import type { FindingKind, FindingsStatus, ProposalWithheldReason, RetroFinding, RetroFindingsView } from '../../../shared/domain/retroFindings'
import { SPACE_COMPONENT_LABELS, type EvidenceRef, type GradeSubject } from '../../../shared/domain/space'
import type { SprintReportView } from '../../../shared/domain/views'
import type { Failure } from '../epic/runner'
import { percentText, shortHash } from '../scorecard/scorecardFormat'
import { SIZE_LABELS } from '../ticket/ticketView'
import { correctionRoute, routeText } from './correctionRoute'
import { CONCERN_LABELS, numberText, SUBJECT_LABELS, type RetroLookup, type TicketRef } from './retroView'

// ---------------------------------------------------------------------------------------------------------------
// 1. The measured result

interface AssessmentView {
  /** The sprint grade frozen with the revision; null for a report submitted before scorecards (nothing was measured). */
  headline: { letter: string; score: string; status: string; coverage: string } | null
  facts: { label: string; value: string }[]
  note: string
}

/** The scorecard frozen with the report revision, at a glance: its sprint grade and what it was read under. */
export function assessmentView(report: SprintReportView): AssessmentView {
  const card = report.scorecard
  if (card === undefined) {
    return {
      headline: null,
      facts: [],
      note: 'This report was submitted before scorecards were frozen with reports: nothing was measured with it, so it has no findings. Its experiments are shown as written.'
    }
  }
  const sprint = card.grades.find((grade) => grade.subject.level === 'sprint' && grade.subject.id === report.sprintId) ?? null
  const rollups = card.grades
    .map((grade) => SUBJECT_LABELS[grade.subject.level].toLowerCase())
    .join(', ')
    .replace(/, ([^,]*)$/, ' and $1')
  return {
    headline:
      sprint === null
        ? null
        : {
            letter: sprint.letter ?? '—',
            score: sprint.displayScore === null ? 'No score' : `Score ${sprint.displayScore}`,
            status: sprint.status,
            coverage: `Coverage ${percentText(sprint.coverage)}`
          },
    facts: [
      { label: 'Frozen with', value: `Report revision ${report.reportRevision} (${report.id})` },
      { label: 'Records up to', value: card.cutoff },
      { label: 'Policy', value: `${card.policy.policyId} v${card.policy.version} · ${shortHash(card.policy.hash)}` },
      { label: 'Snapshot', value: `${card.snapshotId} · ${shortHash(card.snapshotHash)}` },
      { label: 'Graded', value: `${card.ticketCount} tickets, rolled up into the ${rollups} grades` }
    ],
    note:
      sprint === null
        ? 'The frozen scorecard holds no grade for this sprint.'
        : 'The grade is frozen with this revision and never changes. A low grade starts no work by itself: corrective work exists only once you create it below, as draft work you review.'
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Findings

const FINDING_KIND_LABELS: Record<FindingKind, string> = {
  failed_verification: 'Failed verification',
  delivery_gap: 'Delivery gap',
  coordination_problem: 'Coordination problem',
  corrective_concentration: 'Concentrated corrective effort',
  budget_overrun: 'Budget overrun',
  missing_instrumentation: 'Missing instrumentation'
}

const WITHHELD_LABELS: Record<ProposalWithheldReason, string> = {
  multiple_candidate_causes: 'No proposal: more than one cause could explain it, so the planner chooses after looking.',
  contradictory_signals: 'No proposal: another measure of the same subject points the other way.',
  sparse_data: 'No proposal: too little was measured to size a change.',
  no_baseline: 'No proposal: the measure a change would be read from has no value in the frozen grade.'
}

const STATUS_NOTES: Record<FindingsStatus, string | null> = {
  findings: null,
  no_meaningful_issue: 'The scorecard shows no gap past the thresholds: nothing to correct, and nothing is proposed.',
  insufficient_data: 'Too little was measured to size a change: the findings are listed, but only missing instrumentation carries a proposal outline.'
}

/** A link to an experiment of the retro, by its id and issue. */
interface ExperimentLink {
  experimentId: string
  label: string
}

export interface FindingRow {
  id: string
  /** "#1 · Delivery gap". */
  heading: string
  subject: string
  /** The ticket the finding is about, linked when the plan holds it. */
  subjectTicket: TicketRef | null
  component: string
  statement: string
  magnitude: string
  coverage: string
  hypotheses: string[]
  /** What a proposal would measure and where its work would go; null when withheld (`withheld` says why). */
  proposal: string[] | null
  withheld: string | null
  contradictedBy: string[]
  evidence: EvidenceRef[]
  /** The retro's experiments drawn from it. */
  experiments: ExperimentLink[]
}

interface FindingsView {
  status: string | null
  rows: FindingRow[]
  contradictions: string[]
  notes: string[]
}

function subjectText(subject: GradeSubject, lookup: RetroLookup): string {
  if (subject.level !== 'ticket') return `${SUBJECT_LABELS[subject.level]} grade`
  const ticket = lookup.ref(subject.id)
  return `Ticket grade · ${ticket.key === '' ? subject.id : `${ticket.key} ${ticket.title}`}`
}

/** A finding's statement with its ticket named by key, as the plan names it, rather than by id. */
export function findingStatement(finding: RetroFinding, lookup: RetroLookup): string {
  if (finding.subject.level !== 'ticket') return finding.statement
  const key = lookup.ref(finding.subject.id).key
  return key === '' ? finding.statement : finding.statement.replaceAll(finding.subject.id, key)
}

/**
 * The findings an experiment was drawn from: those of the very grade it cites whose gap shows in the measure it moves
 * (else in that measure's component; a whole-grade measure matches every finding of the grade). An experiment citing
 * an earlier revision's grade matches none of this revision's findings.
 */
export function drawnFrom(experiment: RetroExperiment, findings: readonly RetroFinding[]): RetroFinding[] {
  const sameGrade = findings.filter((finding) => finding.assessmentId === experiment.source.assessmentId)
  const measure = sameGrade.filter((finding) => finding.magnitude.measure === experiment.baseline.measure)
  if (measure.length > 0) return measure
  const component = EXPERIMENT_MEASURES[experiment.baseline.measure].component
  return component === null ? sameGrade : sameGrade.filter((finding) => finding.component === component)
}

function proposalLines(finding: RetroFinding): string[] | null {
  const proposal = finding.proposal
  if (proposal === null) return null
  const baseline = proposal.baseline === null ? 'nothing measured yet (a discovery)' : `${proposal.baseline.measure} ${numberText(proposal.baseline.value)} ${proposal.baseline.unit} (${proposal.baseline.state})`
  return [
    `${CONCERN_LABELS[proposal.concern]} · ${proposal.direction} · destination: ${routeText(correctionRoute(proposal.destination))}`,
    `Read against ${baseline}`,
    ...proposal.guardrails.map((item) => `Guardrail ${item.measure} ${item.comparator === 'at_least' ? 'at least' : 'at most'} ${numberText(item.threshold)} ${item.unit}`),
    ...proposal.needs.map((need) => `Still needs: ${need}`)
  ]
}

export function findingsView(view: RetroFindingsView, experiments: readonly RetroExperiment[], lookup: RetroLookup): FindingsView {
  const headings = new Map(view.findings.map((finding) => [finding.id, `#${finding.rank} ${FINDING_KIND_LABELS[finding.kind]}`]))
  const rows = view.findings.map(
    (finding): FindingRow => ({
      id: finding.id,
      heading: `#${finding.rank} · ${FINDING_KIND_LABELS[finding.kind]}`,
      subject: subjectText(finding.subject, lookup),
      subjectTicket: finding.subject.level === 'ticket' ? lookup.ref(finding.subject.id) : null,
      component: `${finding.component} · ${SPACE_COMPONENT_LABELS[finding.component]}`,
      statement: findingStatement(finding, lookup),
      magnitude: finding.magnitude.text,
      coverage:
        finding.coverage.items === null
          ? `Grade coverage ${percentText(finding.coverage.grade)}`
          : `Grade coverage ${percentText(finding.coverage.grade)} · ${finding.coverage.items.measured} of ${finding.coverage.items.total} items measured`,
      hypotheses: finding.hypotheses.map((item) => `${CONCERN_LABELS[item.concern]}: ${item.hypothesis}`),
      proposal: proposalLines(finding),
      withheld: finding.withheld === null ? null : WITHHELD_LABELS[finding.withheld],
      contradictedBy: finding.contradictedBy.map((id) => headings.get(id) ?? id),
      evidence: finding.evidence,
      experiments: experiments
        .filter((experiment) => drawnFrom(experiment, [finding]).length > 0)
        .map((experiment) => ({ experimentId: experiment.id, label: `${experiment.id} · ${experiment.issue.summary}` }))
    })
  )
  return {
    status: STATUS_NOTES[view.status],
    rows,
    contradictions: view.contradictions.map((item) => `${subjectText(item.subject, lookup)}: ${item.detail}`),
    notes: view.notes
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Experiments: whether one can be selected for corrective work here

export interface Selectability {
  selectable: boolean
  /** Why it cannot be selected, or what the preview will say about it; null when nothing. */
  note: string | null
}

const STATUS_LABELS: Record<ExperimentView['status'], string> = {
  proposed: 'Proposed',
  selected: 'Selected',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  abandoned: 'Abandoned'
}

export function experimentStatus(read: ExperimentView | null): string | null {
  if (read === null) return null
  return read.withdrawn ? `${STATUS_LABELS[read.status]} · withdrawn` : STATUS_LABELS[read.status]
}

/**
 * Whether an experiment can be selected for same-repository corrective work. Dark Mechanicus work goes to the chosen
 * Dark Mechanicus checkout instead (its own panel on the experiment), and a withdrawn or finished experiment takes no
 * new work; unsized or vague work can be selected, and its preview says what blocks it and how to restate it.
 */
export function selectability(experiment: RetroExperiment, read: ExperimentView | null): Selectability {
  if (correctionRoute(experiment.destination).kind === 'darkmechanicus_source') {
    return { selectable: false, note: 'Its destination is the Dark Mechanicus source: plan it in its Dark Mechanicus source panel below, not here.' }
  }
  if (read?.withdrawn === true) return { selectable: false, note: 'A later revision of the report left it out (withdrawn): it takes no new work.' }
  if (read !== null && FINAL_EXPERIMENT_STATUSES.includes(read.status)) return { selectable: false, note: `It is ${read.status}: it takes no new work.` }
  if (read !== null && read.executionProblems.length > 0) {
    return { selectable: true, note: `Not creatable as written: ${read.executionProblems.join('; ')}. The preview shows how to restate it.` }
  }
  return { selectable: true, note: null }
}

/** The other epics of this project (follow-up epics) holding an experiment's corrective work, to open them here. */
export function holdingEpics(read: ExperimentView | null, homeEpicId: string): { epicId: string; title: string }[] {
  const here = (read?.outcome.corrections.tickets ?? []).filter((ticket) => ticket.epicId !== homeEpicId && ticket.projectId === undefined)
  return [...new Map(here.map((ticket) => [ticket.epicId, ticket.epicTitle]))].map(([epicId, title]) => ({ epicId, title }))
}

// ---------------------------------------------------------------------------------------------------------------
// 4. The corrective planner

/** Where in the plan the work goes; null leaves it to the default (a new sprint, or a follow-up epic once completed). */
export type TargetChoice = { kind: 'new_sprint' } | { kind: 'sprint'; sprintId: string } | { kind: 'follow_up_epic'; title: string }

/** The person's edits to one generated work ticket; an absent field keeps what the experiment generates. */
export interface WorkEditState {
  title?: string
  body?: string
  /** One criterion per line. */
  criteria?: string
  /** Refs (`<experiment id>#<index>`) of other work of this request it requires. */
  requires?: string[]
  /** Keys or ids of draft tickets it requires, separated by commas or spaces. */
  requiresTickets?: string
}

/** What an edit was written against: the report revision and the work item's title and body as it read then. */
interface EditBasis {
  reportId: string
  title: string
  body: string
}

/** An edit as the planner keeps it, with what it was written against. */
export interface KeptEdit extends WorkEditState {
  against: EditBasis
}

export interface PlannerNotice {
  tone: 'error' | 'info'
  text: string
  /** What recovers: read the preview again, reload the workspace (a newer report), or nothing. */
  action: 'preview' | 'reload' | null
}

export interface PlannerState {
  selected: string[]
  target: TargetChoice | null
  fireguard: boolean
  /** By work ref (`<experiment id>#<index>`). */
  edits: Readonly<Record<string, KeptEdit>>
  /** The work ref whose edit form is open. */
  editing: string | null
  /** The last preview, with the request and report revision it was read for. */
  preview: { key: string; reportId: string; view: CorrectionPlanView } | null
  /** What the last creation did, for the report revision it was created from. */
  result: { reportId: string; view: CorrectionsResultView } | null
  /** The last refusal, with the report revision it was raised on (a reload past it clears a reload notice). */
  notice: (PlannerNotice & { reportId: string }) | null
  /** A preview or creation in flight: every further click is ignored until it settles. */
  pending: 'preview' | 'create' | null
}

export const EMPTY_PLANNER: PlannerState = {
  selected: [],
  target: null,
  fireguard: true,
  edits: {},
  editing: null,
  preview: null,
  result: null,
  notice: null,
  pending: null
}

export function workRef(experimentId: string, index: number): string {
  return `${experimentId}#${index}`
}

function parseWorkRef(ref: string): { experimentId: string; index: number } | null {
  const match = /^(.+)#(\d+)$/.exec(ref)
  return match === null ? null : { experimentId: match[1] ?? '', index: Number(match[2]) }
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * The prerequisites an edit asks for, as sent: work of another experiment that is not in the request (deselected, or
 * left out) cannot be required, so it is left out and named in `dropped`, never sent to refuse the whole request.
 */
function prerequisites(edit: WorkEditState, sent: readonly string[]): { dependsOn: CorrectionPrerequisite[] | undefined; dropped: string[] } {
  if (edit.requires === undefined && edit.requiresTickets === undefined) return { dependsOn: undefined, dropped: [] }
  const dropped: string[] = []
  const work = (edit.requires ?? []).flatMap((ref) => {
    const parsed = parseWorkRef(ref)
    if (parsed === null) return []
    if (!sent.includes(parsed.experimentId)) {
      dropped.push(ref)
      return []
    }
    return [{ work: parsed }]
  })
  const tickets = (edit.requiresTickets ?? '')
    .split(/[\s,]+/)
    .filter((key) => key !== '')
    .map((ticket) => ({ ticket }))
  return { dependsOn: [...work, ...tickets], dropped }
}

function workEdit(at: { experimentId: string; index: number }, edit: WorkEditState, sent: readonly string[]): { edit: CorrectionWorkEdit | null; dropped: string[] } {
  const { dependsOn, dropped } = prerequisites(edit, sent)
  // Blank criteria keep the generated ones (the form says so): an empty list would only be refused.
  const criteria = edit.criteria === undefined ? [] : lines(edit.criteria)
  const out: CorrectionWorkEdit = {
    ...at,
    ...(edit.title === undefined ? {} : { title: edit.title }),
    ...(edit.body === undefined ? {} : { body: edit.body }),
    ...(criteria.length === 0 ? {} : { acceptanceCriteria: criteria }),
    ...(dependsOn === undefined ? {} : { dependsOn })
  }
  return { edit: Object.keys(out).length > 2 ? out : null, dropped }
}

/** What the edit of a work item is written against in `reportId`: the experiment's work item as it reads there. */
export function editBasis(experiment: RetroExperiment, index: number, reportId: string): EditBasis {
  const work = experiment.proposedWork[index]
  return { reportId, title: work?.title ?? '', body: work?.body ?? '' }
}

/**
 * Whether a kept edit still fits the work item it was written for in this report revision: `current` when it was
 * written here or the item reads the same, `restated` when a newer revision restated the item (the person keeps or
 * discards it), `gone` when the revision's experiment has no such item.
 */
type EditStanding = 'current' | 'restated' | 'gone'

export function editStanding(edit: KeptEdit, experiment: RetroExperiment, index: number, reportId: string): EditStanding {
  const work = experiment.proposedWork[index]
  if (work === undefined) return 'gone'
  if (edit.against.reportId === reportId) return 'current'
  return work.title === edit.against.title && work.body === edit.against.body ? 'current' : 'restated'
}

/** What decides which kept choices a request can carry: the experiments that cannot be selected now and the plan. */
export interface RequestScope {
  /** Why each experiment of the retro that cannot be selected now is left out (its standing read, or failed to read). */
  unselectable: ReadonlyMap<string, string>
  epicCompleted: boolean
  /** The draft's sprints after the report's sprint: a kept sprint target outside them no longer fits. */
  laterSprints: readonly string[]
}

export const OPEN_SCOPE: RequestScope = { unselectable: new Map(), epicCompleted: false, laterSprints: [] }

/** A kept edit the request cannot carry as it is. */
export interface HeldEdit {
  ref: string
  experimentId: string
  index: number
  standing: 'restated' | 'gone'
}

/** A preview or creation request with what the planner left out of it, and why, so the person is told. */
export interface PlannerRequest {
  input: CorrectionsInput
  /** Selected experiments left out: no longer in this revision's retro, or not selectable now. */
  leftOut: { experimentId: string; why: string }[]
  /** Edits of selected experiments written against restated or missing work items: never sent until resolved. */
  held: HeldEdit[]
  /** The kept target, when it no longer fits the epic and the default is used instead; why, in words. */
  targetDropped: string | null
  /** Prerequisites of sent edits on work of experiments not in the request: left out of it, so the rest still previews. */
  prerequisitesDropped: { ref: string; requires: string }[]
  /** The target the request uses (null: the default). */
  target: TargetChoice | null
}

/** The selected experiments still in the report's retro and selectable now, in the retro's order. */
function selectedIn(state: PlannerState, experiments: readonly RetroExperiment[], unselectable: ReadonlyMap<string, string> = new Map()): string[] {
  return experiments.filter((experiment) => state.selected.includes(experiment.id) && !unselectable.has(experiment.id)).map((experiment) => experiment.id)
}

export function fittingTarget(target: TargetChoice | null, scope: RequestScope): { target: TargetChoice | null; dropped: string | null } {
  if (target === null) return { target, dropped: null }
  if (scope.epicCompleted && target.kind !== 'follow_up_epic') {
    return { target: null, dropped: 'The epic is completed: the sprint chosen earlier no longer applies, so the work goes into a follow-up epic.' }
  }
  if (!scope.epicCompleted && target.kind === 'follow_up_epic') return { target: null, dropped: 'The epic is not completed: the work goes into its draft, not a follow-up epic.' }
  if (target.kind === 'sprint' && !scope.laterSprints.includes(target.sprintId)) {
    return { target: null, dropped: 'The sprint chosen earlier is no longer a later sprint of the draft: a new sprint is appended instead.' }
  }
  return { target, dropped: null }
}

function requestTarget(target: TargetChoice | null): CorrectionsInput['target'] {
  if (target === null || target.kind !== 'follow_up_epic') return target ?? undefined
  return target.title.trim() === '' ? { kind: target.kind } : { kind: target.kind, title: target.title.trim() }
}

/**
 * What a preview or a creation asks for: the selectable selected experiments, the target if it still fits, the
 * Fireguard choice and the edits of selected work that still fit their work items; and what was left out, and why.
 */
export function plannerRequest(reportId: string, state: PlannerState, experiments: readonly RetroExperiment[], scope: RequestScope = OPEN_SCOPE): PlannerRequest {
  const experimentIds = selectedIn(state, experiments, scope.unselectable)
  const byId = new Map(experiments.map((experiment) => [experiment.id, experiment]))
  const leftOut = state.selected
    .filter((id) => !experimentIds.includes(id))
    .map((experimentId) => ({ experimentId, why: byId.has(experimentId) ? (scope.unselectable.get(experimentId) ?? 'It cannot be selected now.') : "It is no longer in this revision's retro." }))
  const held: HeldEdit[] = []
  const prerequisitesDropped: PlannerRequest['prerequisitesDropped'] = []
  const edits = Object.entries(state.edits).flatMap(([ref, edit]) => {
    const at = parseWorkRef(ref)
    const experiment = at === null ? undefined : byId.get(at.experimentId)
    if (at === null || experiment === undefined || !experimentIds.includes(at.experimentId)) return []
    const standing = editStanding(edit, experiment, at.index, reportId)
    if (standing !== 'current') {
      held.push({ ref, ...at, standing })
      return []
    }
    const out = workEdit(at, edit, experimentIds)
    prerequisitesDropped.push(...out.dropped.map((requires) => ({ ref, requires })))
    return out.edit === null ? [] : [out.edit]
  })
  const fit = fittingTarget(state.target, scope)
  const target = requestTarget(fit.target)
  return {
    input: { reportId, experimentIds, ...(target === undefined ? {} : { target }), ...(edits.length === 0 ? {} : { edits }), fireguard: state.fireguard },
    leftOut,
    held,
    targetDropped: fit.dropped,
    prerequisitesDropped,
    target: fit.target
  }
}

/** A stable key of a request: equal keys ask for the same work. */
export function requestKey(input: CorrectionsInput): string {
  return JSON.stringify(input)
}

export type PreviewStanding = 'none' | 'current' | 'changed' | 'report_revised'

export function previewStanding(state: PlannerState, reportId: string, input: CorrectionsInput): PreviewStanding {
  if (state.preview === null) return 'none'
  if (state.preview.reportId !== reportId) return 'report_revised'
  return state.preview.key === requestKey(input) ? 'current' : 'changed'
}

const PENDING_BLOCKS: Record<NonNullable<PlannerState['pending']>, string> = { create: 'Creating the draft work…', preview: 'Reading the preview…' }

const STANDING_BLOCKS: Record<PreviewStanding, string | null> = {
  none: 'Preview the corrective work first: nothing is created before you have seen it.',
  report_revised: 'The report was revised since the preview: preview again against the latest revision.',
  changed: 'Your choices changed since the preview: preview again to see what would be created.',
  current: null
}

/**
 * What the current preview says stands in the way: earlier work of another request, blocked work, nothing left to add.
 * Work blocked with the person's edits is theirs to fix or reset; work blocked as the experiment states it is the
 * orchestrator's to restate.
 */
function previewBlock(view: CorrectionPlanView, edited: ReadonlySet<string>): string | null {
  const ids = (state: CorrectionPlanView['experiments'][number]['state'], test: (id: string) => boolean = () => true): string =>
    view.experiments
      .filter((item) => item.state === state && test(item.experimentId))
      .map((item) => item.experimentId)
      .join(', ')
  const conflicts = ids('conflict')
  if (conflicts !== '') return `${conflicts} already has corrective work from a different request: deselect it, or open the draft holding it.`
  const yours = ids('blocked', (id) => edited.has(id))
  if (yours !== '') {
    return `${yours} cannot be created with your edits (see its problems in the preview): fix or reset your edits under Selected work, or deselect it. If it is blocked without your edits too, the orchestrator restates it.`
  }
  const blocked = ids('blocked')
  if (blocked !== '') return `${blocked} cannot be created as the experiment states it: deselect it, or ask the orchestrator to restate it with sized, specific work.`
  return view.experiments.every((item) => item.state === 'created') ? 'Already created: nothing to add. Open the draft holding it.' : null
}

/** Why Create draft work is not offered yet, or null when it is. */
export function createBlock(state: PlannerState, request: PlannerRequest, busy: boolean): string | null {
  const { input } = request
  if (state.pending !== null) return PENDING_BLOCKS[state.pending]
  if (input.experimentIds.length === 0) return 'Select at least one experiment.'
  const restated = request.held.filter((edit) => edit.standing === 'restated').map((edit) => edit.ref)
  if (restated.length > 0) {
    return `A newer report revision restated the work you edited (${restated.join(', ')}): keep or discard those edits under Selected work first.`
  }
  const standing = STANDING_BLOCKS[previewStanding(state, input.reportId, input)]
  if (standing !== null || state.preview === null) return standing
  const edited = new Set((input.edits ?? []).map((edit) => edit.experimentId))
  return previewBlock(state.preview.view, edited) ?? (busy ? 'The workspace is busy.' : null)
}

// Preview

const ROLE_LABELS: Record<CorrectionTicketView['role'], string> = { work: 'Corrective work', fireguard: 'Fireguard', acceptance: 'Acceptance node' }

const STATE_LOOKS: Record<CorrectionPlanView['experiments'][number]['state'], { label: string; tone: 'accepted' | 'neutral' | 'blocked' | 'attention' }> = {
  ready: { label: 'Ready to create', tone: 'accepted' },
  created: { label: 'Already created', tone: 'neutral' },
  conflict: { label: 'Created differently', tone: 'blocked' },
  blocked: { label: 'Blocked', tone: 'attention' }
}

export interface PreviewTicketRow {
  ref: string
  role: string
  key: string
  title: string
  size: string
  repository: string
  tags: string
  body: string
  criteria: { text: string; covers: string | null }[]
  requires: string[]
  existing: boolean
  /** The work item it comes from, so it can be edited; null for Fireguard and the acceptance node. */
  work: { experimentId: string; index: number } | null
}

interface PreviewExperimentRow {
  experimentId: string
  label: string
  tone: 'accepted' | 'neutral' | 'blocked' | 'attention'
  problems: string[]
  /** Where it already is: "DM-14, DM-15 in the draft of epic ep_…". */
  existing: string | null
  existingEpicId: string | null
  /** The restatement to resubmit, for unsized or vague work. */
  restatement: string | null
}

export interface PreviewView {
  target: string
  destination: string
  experiments: PreviewExperimentRow[]
  tickets: PreviewTicketRow[]
  dependencies: string[]
  validation: { valid: boolean; errors: string[]; warnings: string[] }
  nextSteps: string[]
  notes: string[]
}

/** "Sprint 3 of the draft of "Checkout revamp" (appended after Sprint 2) · goal …". */
function targetText(view: CorrectionPlanView): string {
  const { target } = view
  const goal = target.sprintGoal.trim() === '' ? '' : ` · goal: ${target.sprintGoal}`
  if (target.kind === 'follow_up_epic') {
    return `${target.epicId === null ? 'A new follow-up epic' : 'The open follow-up epic'} "${target.epicTitle}" · Sprint ${target.sprintOrdinal}${goal}`
  }
  const placement = target.sprintId === null ? `a new Sprint ${target.sprintOrdinal}, appended` : `Sprint ${target.sprintOrdinal}`
  const after = target.afterOrdinal === null ? '' : ` (after Sprint ${target.afterOrdinal}, which stays as it is)`
  return `The draft of "${target.epicTitle}": ${placement}${after}${goal}`
}

/** The ticket's own body without the experiment context the core appends under it. */
function ownBody(body: string): string {
  const at = body.indexOf('\n\n## Corrective experiment')
  return at === -1 ? body : body.slice(0, at)
}

export function previewView(view: CorrectionPlanView): PreviewView {
  const keys = new Map(view.tickets.map((ticket) => [ticket.ref, ticket.key]))
  const name = (ref: string): string => keys.get(ref) ?? ref
  const repositories = [...new Set(view.tickets.filter((ticket) => ticket.role === 'work').map((ticket) => ticket.repo))]
  return {
    target: targetText(view),
    destination: repositories.length === 0 ? 'This project' : repositories.map((repo) => (repo === null ? "This project's repository" : `Repository ${repo}`)).join(', '),
    experiments: view.experiments.map((item) => {
      const look = STATE_LOOKS[item.state]
      const existing = item.existing
      return {
        experimentId: item.experimentId,
        label: look.label,
        tone: look.tone,
        problems: item.problems,
        existing:
          existing === null
            ? null
            : `${existing.keys.join(', ')} in the ${existing.holder === 'draft' ? 'draft' : `saved revision ${existing.revisionNumber ?? ''}`} of epic ${existing.epicId}`,
        existingEpicId: existing?.epicId ?? null,
        restatement: item.restatement === null ? null : JSON.stringify(item.restatement, null, 2)
      }
    }),
    tickets: view.tickets.map((ticket) => ({
      ref: ticket.ref,
      role: ROLE_LABELS[ticket.role],
      key: ticket.key,
      title: ticket.title,
      size: ticket.size === null ? 'Unsized' : SIZE_LABELS[ticket.size],
      repository: ticket.repo === null ? "This project's repository" : `Repository ${ticket.repo}`,
      tags: ticket.tags.join(', '),
      body: ownBody(ticket.body),
      criteria: ticket.acceptanceCriteria.map((criterion) => ({ text: criterion.text, covers: criterion.covers === null ? null : name(criterion.covers) })),
      requires: ticket.dependsOn.map(name),
      existing: ticket.existing,
      work: ticket.role === 'work' && ticket.experimentId !== null && ticket.workIndex !== null ? { experimentId: ticket.experimentId, index: ticket.workIndex } : null
    })),
    dependencies: view.dependencies.map((edge) => `${name(edge.to)} requires ${name(edge.from)}`),
    validation: {
      valid: view.validation.valid,
      errors: view.validation.errors.map((issue) => issue.message),
      warnings: view.validation.warnings.map((issue) => issue.message)
    },
    nextSteps: view.nextSteps,
    notes: view.notes
  }
}

/** What the edit form of a work ticket starts from: the experiment's work and the generated ticket of the last preview. */
export function editDefaults(experiment: RetroExperiment, index: number, ticket: CorrectionTicketView | undefined): Required<WorkEditState> {
  const work = experiment.proposedWork[index] ?? { title: '', body: '' }
  const dependsOn = ticket?.dependsOn ?? []
  return {
    title: work.title,
    body: work.body,
    criteria: (ticket?.acceptanceCriteria ?? []).map((criterion) => criterion.text).join('\n'),
    requires: dependsOn.filter((ref) => parseWorkRef(ref) !== null),
    requiresTickets: dependsOn.filter((ref) => parseWorkRef(ref) === null && !ref.startsWith('fireguard')).join(', ')
  }
}

// Creation

interface ResultView {
  heading: string
  tone: 'accepted' | 'neutral'
  tickets: string[]
  epicId: string | null
  epicTitle: string
  sameEpic: boolean
  nextSteps: string[]
}

export function resultView(view: CorrectionsResultView): ResultView {
  const epicId = view.target.epicId ?? view.createdIn[0]?.epicId ?? null
  const added = view.tickets.filter((ticket) => !ticket.existing)
  const revision = view.draftRevision === null ? '' : ` (draft revision ${view.draftRevision})`
  return {
    heading: view.changed
      ? `Created as draft work in "${view.target.epicTitle}"${revision}. Nothing was saved, adopted, started or approved.`
      : 'Already created by the same request: nothing was added.',
    tone: view.changed ? 'accepted' : 'neutral',
    tickets: added.map((ticket) => `${ticket.key} ${ticket.title}`),
    epicId,
    epicTitle: view.target.epicTitle,
    sameEpic: epicId === view.source.epicId,
    nextSteps: view.nextSteps
  }
}

/**
 * Whether the last creation's result still describes what is shown: it was created from this report revision and,
 * when it went into this epic's draft, that draft is still the revision it wrote (a discarded, saved or further edited
 * draft is another context, so the result is no longer shown).
 */
export function resultStands(result: PlannerState['result'], reportId: string, draftRevision: number | null): result is NonNullable<PlannerState['result']> {
  if (result === null || result.reportId !== reportId) return false
  const view = result.view
  const epicId = view.target.epicId ?? view.createdIn[0]?.epicId ?? null
  return epicId !== view.source.epicId || view.draftRevision === draftRevision
}

/**
 * The refusal to show for the report revision on screen. A reload notice raised on an earlier revision has done its
 * work once a newer one is shown (the workspace reloads after a creation): it then says so and offers a new preview.
 */
export function shownNotice(notice: PlannerState['notice'], report: { id: string; reportRevision: number }): PlannerNotice | null {
  if (notice === null || notice.action !== 'reload' || notice.reportId === report.id) return notice
  return {
    tone: 'info',
    text: `The report was read again: its revision ${report.reportRevision} is shown now. ${KEPT} Preview again to see the work against this revision.`,
    action: 'preview'
  }
}

// Refusals

const KEPT = 'Nothing was created; your selection and edits are kept.'

/** The refusals the planner explains, in order: the first whose test holds says what happened and what recovers. */
const REFUSALS: { test(failure: Failure): boolean; notice(failure: Failure): PlannerNotice }[] = [
  {
    test: (failure) => failure.code === 'conflict' && failure.details?.currentDraftRevision !== undefined,
    notice: (failure) => ({
      tone: 'error',
      text: `The draft changed since your preview (it is now revision ${String(failure.details?.currentDraftRevision)}). ${KEPT} Preview again to see it as it is now.`,
      action: 'preview'
    })
  },
  {
    test: (failure) => failure.code === 'conflict' && failure.details?.latestReportId !== undefined,
    notice: () => ({
      tone: 'error',
      text: `A newer revision of this sprint's report replaced the one shown. ${KEPT} Reload to read the latest revision; the selection carries over to the experiments it restates.`,
      action: 'reload'
    })
  },
  {
    test: (failure) => failure.code === 'idempotency_mismatch',
    notice: () => ({
      tone: 'error',
      text: `Corrective work for a selected experiment was already created by a different request (other edits, target or Fireguard choice). ${KEPT} Deselect it, or open the draft holding it.`,
      action: 'preview'
    })
  },
  {
    test: (failure) => failure.code === 'invalid_graph' || failure.code === 'invalid_input',
    notice: (failure) => ({
      tone: 'error',
      text: `${failure.message} ${KEPT} Fix the edits (a prerequisite must be work of this request or a work ticket of the draft) and preview again.`,
      action: 'preview'
    })
  },
  {
    test: (failure) => failure.code === 'completed_epic',
    notice: () => ({
      tone: 'error',
      text: `The epic is completed, so its corrective work goes into a follow-up epic, not a sprint of its draft. ${KEPT} Reload to plan it as follow-up work.`,
      action: 'reload'
    })
  },
  {
    test: (failure) => failure.code === 'not_found',
    notice: (failure) => ({ tone: 'error', text: `${failure.message} ${KEPT} Reload to read the report as it is now.`, action: 'reload' })
  },
  {
    // Blocked experiments refuse the whole creation: the message names each one and how to restate it.
    test: (failure) => failure.code === 'conflict',
    notice: (failure) => ({ tone: 'error', text: `${failure.message} ${KEPT}`, action: 'preview' })
  }
]

/**
 * A refused preview or creation in words, with what recovers it. Nothing was created on a refusal, and the person's
 * selection and edits are kept as they are.
 */
export function plannerFailure(failure: Failure, phase: 'preview' | 'create'): PlannerNotice {
  const known = REFUSALS.find((refusal) => refusal.test(failure))
  if (known !== undefined) return known.notice(failure)
  const what = phase === 'preview' ? 'The preview could not be read' : 'The draft work was not created'
  return { tone: 'error', text: `${what}: ${failure.message} ${KEPT}`, action: phase === 'preview' ? 'preview' : null }
}
