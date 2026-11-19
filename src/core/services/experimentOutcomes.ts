/**
 * What an experiment's outcome is read from (`plan/experimentOutcome.ts`): the epics that hold its corrective work
 * (its own epic, and any follow-up epic whose provenance names it and whose markers carry the experiment's key and one
 * payload hash: `correctionHolderProblem`), the tickets of that work with their accepted attempts, the frozen
 * scorecards of the experiment's epic and of those follow-ups (and where each scope starts), and the planned sizes of
 * tickets. Read-only and cheap: a stored scorecard is checked against its seal only (it was regraded when it was
 * frozen or imported), so a read never regrades; one that does not parse or match its seal is treated as not here.
 *
 * Work a cross-repository correction created in another project (the Dark Mechanicus source) is measured from what
 * its result events carry (`CrossRepoResultEvidence`): the cited scorecard, that epic's scope starts, its corrective
 * tickets and planned sizes, brought back by the source's receipt (`CarriedResults`) and copied into the event when
 * the result was recorded, so every machine reads the same outcome.
 */
import type { EpicProvenance, PlanBundle, TicketSize } from '../../shared/domain/bundle'
import type {
  CrossRepoResultEvidence,
  ExperimentCorrectionTicket,
  ExperimentEvent,
  ExperimentOutcome,
  ExperimentStatus,
  RetroExperiment,
  ExperimentView
} from '../../shared/domain/experiments'
import type { CrossRepoResultsView } from '../../shared/domain/crossRepoCorrections'
import type { ScorecardSnapshot } from '../../shared/domain/spaceGrades'
import type { Ctx } from '../context'
import { parseJson } from '../db/database'
import { correctionHolderProblem, correctionsOf, crossRepoEvidenceProblem, crossRepoSealOf, markerLikePattern } from '../plan/corrections'
import { experimentOutcome, type ScorecardStarts } from '../plan/experimentOutcome'
import type { ExperimentContext } from '../plan/experiments'
import { parseScorecardSnapshot, snapshotHashOf } from '../space/snapshot'

type Scorecard = ScorecardSnapshot | null | undefined

/** A scorecard as written when it still matches its seal; undefined when it does not (not here). */
function sealed(snapshot: ScorecardSnapshot): ScorecardSnapshot | undefined {
  try {
    return snapshotHashOf(snapshot) === snapshot.snapshotHash ? snapshot : undefined
  } catch {
    return undefined
  }
}

/** A stored scorecard as written when it still matches its seal; undefined when it does not parse or match (not here). */
function storedCard(json: string): ScorecardSnapshot | undefined {
  try {
    return sealed(JSON.parse(json) as ScorecardSnapshot)
  } catch {
    return undefined
  }
}

/**
 * The frozen scorecards of `epicIds` by report id, for a write (a report being submitted, an event being recorded):
 * read once each, checked against its seal and regraded, and refused when that fails. Undefined for a report of no
 * such epic, null for one submitted before scorecards.
 */
export function scorecardReader(ctx: Ctx, epicIds: readonly string[]): ExperimentContext['scorecard'] {
  const cache = new Map<string, Scorecard>()
  return (reportId) => {
    if (!cache.has(reportId)) {
      const row = ctx.db.get<{ scorecard_json: string | null; epic_id: string }>(
        'SELECT r.scorecard_json, runs.epic_id FROM sprint_reports r JOIN runs ON runs.id = r.run_id WHERE r.id = ?',
        reportId
      )
      const json = row === undefined || !epicIds.includes(row.epic_id) ? undefined : row.scorecard_json
      cache.set(reportId, json == null ? json : parseScorecardSnapshot(parseJson<unknown>(json, null)))
    }
    return cache.get(reportId)
  }
}

/** A draft or saved revision whose bundle may hold an experiment's correction markers. */
interface MarkedBundle {
  holder: 'draft' | 'revision'
  epic_id: string
  number: number | null
  bundle_json: string
}

/** Every draft (first) and saved revision (newest first) whose bundle may hold an experiment's correction markers. */
export function markedBundles(ctx: Ctx, experimentId: string): MarkedBundle[] {
  const pattern = markerLikePattern(experimentId)
  return ctx.db.all<MarkedBundle>(
    `SELECT 'draft' AS holder, epic_id, NULL AS number, bundle_json, 0 AS place FROM drafts WHERE bundle_json LIKE ?
     UNION ALL
     SELECT 'revision' AS holder, epic_id, number, bundle_json, 1 AS place FROM plan_revisions WHERE bundle_json LIKE ?
     ORDER BY place, number DESC`,
    pattern,
    pattern
  )
}

/** An epic holding an experiment's corrective work: the latest saved revision holding it, else its draft. */
interface Holder {
  epicId: string
  epicTitle: string
  /** Null while only the draft holds it. */
  revisionNumber: number | null
  bundle: PlanBundle
}

interface EpicRow {
  id: string
  title: string
  provenance_json: string | null
}

/** The bundle that holds the experiment's markers in one epic: its newest saved revision holding them, else its draft. */
function markedIn(ctx: Ctx, epicId: string, experimentId: string): { revisionNumber: number | null; bundle: PlanBundle } | null {
  const pattern = markerLikePattern(experimentId)
  const saved = ctx.db.get<{ number: number; bundle_json: string }>(
    'SELECT number, bundle_json FROM plan_revisions WHERE epic_id = ? AND bundle_json LIKE ? ORDER BY number DESC LIMIT 1',
    epicId,
    pattern
  )
  if (saved !== undefined) return { revisionNumber: saved.number, bundle: JSON.parse(saved.bundle_json) as PlanBundle }
  const draft = ctx.db.get<{ bundle_json: string }>('SELECT bundle_json FROM drafts WHERE epic_id = ? AND bundle_json LIKE ?', epicId, pattern)
  return draft === undefined ? null : { revisionNumber: null, bundle: JSON.parse(draft.bundle_json) as PlanBundle }
}

/**
 * The epics holding an experiment's corrective work: its own epic, its follow-ups (provenance names the experiment's
 * epic) and this project's own cross-repository correction epic for it (the active repository chosen as its own Dark
 * Mechanicus target), each kept only when its markers pass `correctionHolderProblem`; a marker copied into an
 * unrelated epic, or under another key or payload, holds nothing. A holder whose markers are only in its draft is kept,
 * so its tickets are listed (and linked) before Save; the outcome never lets such a draft of another epic decide
 * anything: it holds no result (`resultEpics`) and no landing (`landingOf`).
 */
function correctionHolders(ctx: Ctx, experiment: RetroExperiment): Holder[] {
  const sourceEpicId = experiment.source.epicId
  const epics = ctx.db.all<EpicRow>(
    `SELECT id, title, provenance_json FROM epics
     WHERE id = ? OR json_extract(provenance_json, '$.sourceEpicId') = ?
       OR (json_extract(provenance_json, '$.kind') = 'cross_repo_correction' AND json_extract(provenance_json, '$.source.experimentId') = ?)
     ORDER BY id = ? DESC, id`,
    sourceEpicId,
    sourceEpicId,
    experiment.id,
    sourceEpicId
  )
  return epics.flatMap((epic) => {
    const marked = markedIn(ctx, epic.id, experiment.id)
    if (marked === null) return []
    const provenance = parseJson<EpicProvenance | null>(epic.provenance_json, null)
    const problem = correctionHolderProblem({ epicId: epic.id, provenance, bundles: [marked.bundle] }, experiment, ctx.projectId)
    return problem === null ? [{ epicId: epic.id, epicTitle: epic.title, ...marked }] : []
  })
}

/**
 * The epics whose frozen grades may be an experiment's result: its own, and each follow-up holding its corrective work
 * in a saved revision (only a saved plan is run, so only a saved plan's runs freeze grades of that work).
 */
export function resultEpics(ctx: Ctx, experiment: RetroExperiment, holders: Holder[] = correctionHolders(ctx, experiment)): string[] {
  const sourceEpicId = experiment.source.epicId
  return [sourceEpicId, ...holders.filter((holder) => holder.epicId !== sourceEpicId && holder.revisionNumber !== null).map((holder) => holder.epicId)]
}

/** A ticket's accepted attempt in the epic's runs that no adoption superseded; null when none. */
function acceptedAttempt(ctx: Ctx, epicId: string, ticketId: string): ExperimentCorrectionTicket['accepted'] {
  const row = ctx.db.get<{ id: string; run_id: string; decided_at: string | null }>(
    `SELECT a.id, a.run_id, a.decided_at FROM attempts a JOIN runs ON runs.id = a.run_id
     WHERE runs.epic_id = ? AND a.ticket_id = ? AND a.state = 'accepted' AND a.superseded_at IS NULL
     ORDER BY a.decided_at DESC, a.id DESC LIMIT 1`,
    epicId,
    ticketId
  )
  return row === undefined || row.decided_at === null ? null : { runId: row.run_id, attemptId: row.id, at: row.decided_at }
}

/** The tickets created as an experiment's corrective work in every epic holding it, each with its accepted attempt. */
function correctionTickets(ctx: Ctx, experiment: Pick<RetroExperiment, 'id'>, holders: Holder[], key: string | null = null): ExperimentCorrectionTicket[] {
  return holders.flatMap((holder) =>
    correctionsOf(holder.bundle, experiment.id)
      .filter(({ marker }) => key === null || marker.key === key)
      .map(({ ticket, marker }) => ({
        epicId: holder.epicId,
        epicTitle: holder.epicTitle,
        ticketId: ticket.id,
        key: ticket.key,
        title: ticket.title,
        role: marker.role,
        workIndex: marker.index,
        revisionNumber: holder.revisionNumber,
        accepted: acceptedAttempt(ctx, holder.epicId, ticket.id)
      }))
  )
}

/** Where the scopes of every frozen scorecard of an epic start, read from the stored snapshots without regrading. */
function scorecardStarts(ctx: Ctx, epicId: string): ScorecardStarts[] {
  return ctx.db
    .all<{ run_id: string; sprint_id: string; sprint: string | null; run: string | null; tickets: string | null }>(
      `SELECT r.run_id, r.sprint_id, json_extract(r.scorecard_json, '$.sprint.dispatchedAt') AS sprint,
              json_extract(r.scorecard_json, '$.run.dispatchedAt') AS run, json_extract(r.scorecard_json, '$.tickets') AS tickets
       FROM sprint_reports r JOIN runs ON runs.id = r.run_id
       WHERE runs.epic_id = ? AND r.scorecard_json IS NOT NULL ORDER BY r.created_at, r.id`,
      epicId
    )
    .map((row) => ({
      epicId,
      runId: row.run_id,
      sprintId: row.sprint_id,
      sprint: row.sprint,
      run: row.run,
      tickets: parseJson<{ subject: { id: string }; dispatchedAt: string | null }[]>(row.tickets ?? '[]', []).map((grade) => ({
        ticketId: grade.subject.id,
        dispatchedAt: grade.dispatchedAt
      }))
    }))
}

/**
 * What one read of outcomes shares across experiments: stored scorecards by report id, scope starts by epic and
 * planned sizes by plan revision, each read once.
 */
interface OutcomeReads {
  card(reportId: string): { epicId: string; card: Scorecard }
  starts(epicId: string): ScorecardStarts[]
  size(planRevisionId: string, ticketId: string): TicketSize | null
}

function memo<K, V>(read: (key: K) => V): (key: K) => V {
  const cache = new Map<K, V>()
  return (key) => {
    if (!cache.has(key)) cache.set(key, read(key))
    return cache.get(key) as V
  }
}

export function outcomeReads(ctx: Ctx): OutcomeReads {
  const card = memo((reportId: string) => {
    const row = ctx.db.get<{ scorecard_json: string | null; epic_id: string }>(
      'SELECT r.scorecard_json, runs.epic_id FROM sprint_reports r JOIN runs ON runs.id = r.run_id WHERE r.id = ?',
      reportId
    )
    return { epicId: row?.epic_id ?? '', card: row === undefined ? undefined : row.scorecard_json === null ? null : storedCard(row.scorecard_json) }
  })
  const sizes = memo((planRevisionId: string) => {
    const row = ctx.db.get<{ bundle_json: string }>('SELECT bundle_json FROM plan_revisions WHERE id = ?', planRevisionId)
    const bundle = row === undefined ? null : (JSON.parse(row.bundle_json) as PlanBundle)
    return new Map((bundle?.tickets ?? []).map((ticket) => [ticket.id, ticket.size ?? null]))
  })
  return { card, starts: memo((epicId: string) => scorecardStarts(ctx, epicId)), size: (planRevisionId, ticketId) => sizes(planRevisionId).get(ticketId) ?? null }
}

interface OutcomeSubject {
  experiment: RetroExperiment
  status: ExperimentStatus
  events: ExperimentEvent[]
}

/** What the result events of a cross-repository correction carry: scorecards by report id, the latest evidence per epic. */
interface Carried {
  cards: Map<string, ScorecardSnapshot>
  latest: CrossRepoResultEvidence[]
  sizes: Map<string, Record<string, TicketSize | null>>
}

/**
 * What the result events carry, each checked as on import but without regrading (`crossRepoEvidenceProblem`): bound to
 * this project's request, of an epic that is not this project's, matching its seals. Anything else is not here.
 */
function carriedIn(ctx: Ctx, experiment: RetroExperiment, events: ExperimentEvent[], own: readonly string[]): Carried {
  const cards = new Map<string, ScorecardSnapshot>()
  const latest = new Map<string, CrossRepoResultEvidence>()
  const sizes = new Map<string, Record<string, TicketSize | null>>()
  for (const event of events) {
    if (event.kind !== 'result' || event.result.crossRepo === undefined) continue
    const carried = event.result.crossRepo
    if (crossRepoEvidenceProblem(carried, experiment, { projectId: ctx.projectId, own, regrade: false }, event.result.assessment) !== null) continue
    cards.set(carried.scorecard.report.reportId, carried.scorecard)
    latest.set(carried.epicId, carried)
    sizes.set(carried.scorecard.planRevisionId, carried.sizes)
  }
  return { cards, latest: [...latest.values()], sizes }
}

/** An experiment's outcome as this machine's records show it now (`reads`: shared by the experiments of one read). */
export function readExperimentOutcome(ctx: Ctx, subject: OutcomeSubject, reads: OutcomeReads = outcomeReads(ctx)): ExperimentOutcome {
  const holders = correctionHolders(ctx, subject.experiment)
  const epics = resultEpics(ctx, subject.experiment, holders)
  const carried = carriedIn(ctx, subject.experiment, subject.events, epics)
  return experimentOutcome({
    experiment: subject.experiment,
    status: subject.status,
    events: subject.events,
    scorecard: (reportId) => {
      const read = reads.card(reportId)
      return epics.includes(read.epicId) ? read.card : carried.cards.get(reportId)
    },
    starts: [...epics.flatMap((epicId) => reads.starts(epicId)), ...carried.latest.flatMap((evidence) => evidence.starts)],
    corrections: [
      ...correctionTickets(ctx, subject.experiment, holders),
      ...carried.latest.flatMap((evidence) => evidence.corrections.map((ticket) => ({ ...ticket, projectId: evidence.projectId })))
    ],
    sizeOf: (planRevisionId, ticketId) => reads.size(planRevisionId, ticketId) ?? carried.sizes.get(planRevisionId)?.[ticketId] ?? null
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Cross-repository corrections: what the source's receipt brought back from the target epic

/** What a linked receipt brought back from the epic its correction created in the target (`correction_links.evidence_json`). */
export interface CarriedResults {
  readAt: string
  projectId: string
  key: string
  epicId: string
  epicTitle: string
  /** The epic's sealed scorecards, as the target holds them (checked against their seals and regraded when brought back). */
  scorecards: ScorecardSnapshot[]
  starts: ScorecardStarts[]
  corrections: ExperimentCorrectionTicket[]
  /** Planned sizes by plan revision id, then ticket id. */
  sizes: Record<string, Record<string, TicketSize | null>>
}

/**
 * Read in the target: what its epic `epicId` (the correction under `key`) holds for measuring the experiment: its
 * sealed scorecards, where their scopes start, its corrective tickets with their accepted attempts, and the planned
 * sizes of the scorecards' plan revisions. A scorecard that does not match its seal is left out.
 */
export function correctionEpicResults(ctx: Ctx, epic: { id: string; title: string }, experiment: Pick<RetroExperiment, 'id'>, key: string): Omit<CarriedResults, 'readAt'> {
  const rows = ctx.db.all<{ scorecard_json: string }>(
    `SELECT r.scorecard_json FROM sprint_reports r JOIN runs ON runs.id = r.run_id
     WHERE runs.epic_id = ? AND r.scorecard_json IS NOT NULL ORDER BY r.created_at, r.id`,
    epic.id
  )
  const scorecards = rows.flatMap((row) => storedCard(row.scorecard_json) ?? [])
  const marked = markedIn(ctx, epic.id, experiment.id)
  const holder = marked === null ? [] : [{ epicId: epic.id, epicTitle: epic.title, ...marked }]
  const sizes = Object.fromEntries(
    [...new Set(scorecards.map((card) => card.planRevisionId))].map((revisionId) => {
      const row = ctx.db.get<{ bundle_json: string }>('SELECT bundle_json FROM plan_revisions WHERE id = ?', revisionId)
      const tickets = row === undefined ? [] : (JSON.parse(row.bundle_json) as PlanBundle).tickets
      return [revisionId, Object.fromEntries(tickets.map((ticket) => [ticket.id, ticket.size ?? null]))]
    })
  )
  return {
    projectId: ctx.projectId,
    key,
    epicId: epic.id,
    epicTitle: epic.title,
    scorecards,
    starts: scorecardStarts(ctx, epic.id),
    corrections: correctionTickets(ctx, experiment, holder, key),
    sizes
  }
}

type Brought = CarriedResults & { view?: CrossRepoResultsView }

/**
 * In the source: what each linked receipt of the experiment kept, when it is of the receipt's own request, project and
 * the epic it links now (never one it linked before), newest link first.
 */
function linkedResults(ctx: Ctx, experimentId: string): { key: string; targetProjectId: string; carried: Brought }[] {
  const rows = ctx.db.all<{ key: string; target_project_id: string; target_json: string | null; evidence_json: string }>(
    "SELECT key, target_project_id, target_json, evidence_json FROM correction_links WHERE experiment_id = ? AND state = 'linked' AND evidence_json IS NOT NULL ORDER BY linked_at DESC, key",
    experimentId
  )
  return rows.flatMap((row) => {
    const carried = parseJson<Brought | null>(row.evidence_json, null)
    const linkedEpic = parseJson<{ epicId: string } | null>(row.target_json, null)?.epicId ?? null
    const bound = carried !== null && carried.key === row.key && carried.projectId === row.target_project_id && carried.epicId === linkedEpic
    return bound ? [{ key: row.key, targetProjectId: row.target_project_id, carried }] : []
  })
}

/**
 * In the source: what each linked receipt of the experiment last brought back from the epic it links now, as the
 * person and the orchestrator read it (the grades a result may cite). Empty until grades are brought back. A receipt
 * of this very project (its epic in another checkout) is left out: its grades are cited directly once that
 * checkout's records arrive through Git, never carried (`recordExperimentEvent` refuses them the same way).
 */
export function broughtBackResults(ctx: Ctx, experimentId: string): ExperimentView['crossRepoResults'] {
  return linkedResults(ctx, experimentId).flatMap(({ key, targetProjectId, carried }) =>
    carried.view === undefined || targetProjectId === ctx.projectId ? [] : [{ key, targetProjectId, results: carried.view }]
  )
}

/**
 * In the source: the evidence a result citing report `reportId` carries, when that report is a scorecard a linked
 * receipt of the experiment brought back from the epic it links now (`linkedResults`); null otherwise. Only an
 * experiment aimed at the Dark Mechanicus source has such receipts (`citedScorecards` asks for no other). The
 * scorecard is regraded here, and the evidence is sealed (`crossRepoSealOf`).
 */
export function carriedEvidence(ctx: Ctx, experiment: RetroExperiment, reportId: string): CrossRepoResultEvidence | null {
  for (const { carried } of linkedResults(ctx, experiment.id)) {
    const card = carried.scorecards.find((item) => item.report.reportId === reportId)
    if (card === undefined || sealed(card) === undefined) continue
    const evidence: Omit<CrossRepoResultEvidence, 'seal'> = {
      projectId: carried.projectId,
      key: carried.key,
      epicId: carried.epicId,
      epicTitle: carried.epicTitle,
      scorecard: parseScorecardSnapshot(card),
      starts: carried.starts,
      corrections: carried.corrections,
      sizes: carried.sizes[card.planRevisionId] ?? {},
      readAt: carried.readAt
    }
    return { ...evidence, seal: crossRepoSealOf(evidence) }
  }
  return null
}
