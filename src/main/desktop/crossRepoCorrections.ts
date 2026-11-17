/**
 * The cross-repository correction broker: the only way corrective work a retro asks of the Dark Mechanicus source is
 * written there (`src/shared/domain/crossRepoCorrections.ts`; core `src/core/services/crossRepoCorrections.ts`). It runs
 * in main, behind the `corrections:*CrossRepo` channels (`window.dm.crossRepoCorrections`); no MCP tool, CLI command or
 * grant reaches it, and its writes need the desktop's human-only `correction.cross_repo` capability on both sides.
 *
 * The source is a folder the renderer names, which must be tracked. The target is never named by the renderer: it is
 * the chosen Dark Mechanicus checkout, reached only through `requireAvailable()` right before the target is written,
 * opened at the path that returns, and checked again by project id once open. A request writes three batches, each its
 * own transaction: the source receipt (`pending`, holding the fully specified draft), the target epic, then the link in
 * the source. The target finds its epic again by the request's key, so a retry after any partial failure finishes the
 * request without a duplicate, and the result says exactly how far it got. Nothing here runs Git, switches a checkout,
 * or saves, starts, adopts or approves anything.
 */
import type { IpcMain } from 'electron'
import type { Ctx } from '../../core/context'
import { DomainError, fail, toErrorShape } from '../../core/errors'
import { createCrossRepoCorrectionInput, crossRepoWithdrawInput, parseInput } from '../../core/schemas'
import {
  type BegunCorrection,
  beginCrossRepoCorrection,
  closedRequestRefusal,
  crossRepoCorrectionLink,
  crossRepoResults,
  discardCrossRepoCorrection,
  heldCorrection,
  listCrossRepoCorrections,
  materializeCrossRepoCorrection,
  placeholderDeps,
  plannedTickets,
  previewCrossRepoSource,
  previewCrossRepoTarget,
  recordCrossRepoDelivery,
  recordCrossRepoFailure,
  recordCrossRepoResults,
  requestedCrossRepoCorrection,
  type SourcePreview,
  type TargetPreview
} from '../../core/services/crossRepoCorrections'
import type { CommandResult } from '../../shared/desktop/api'
import type { SourceCheckoutView } from '../../shared/desktop/sourceCheckout'
import type {
  CreateCrossRepoCorrectionInput,
  CrossRepoCorrectionInput,
  CrossRepoCorrectionLinkView,
  CrossRepoCorrectionPreview,
  CrossRepoCorrectionResult,
  CrossRepoCorrectionState,
  CrossRepoCorrectionStep,
  CrossRepoTargetAvailability,
  CrossRepoTargetEpicView,
  CrossRepoWithdrawalView
} from '../../shared/domain/crossRepoCorrections'
import type { FolderRegistry } from './folderRegistry'
import { requireTracked } from './handlers'
import type { SourceCheckouts } from './sourceCheckout'
import type { WorkspacePool } from './workspacePool'

interface BrokerDeps {
  registry: Pick<FolderRegistry, 'resolve'>
  pool: Pick<WorkspacePool, 'get'>
  checkouts: Pick<SourceCheckouts, 'view' | 'requireAvailable'>
  /** Told about failures that are not DomainErrors (bugs, I/O), so main can log the stack. */
  onUnexpectedError?: (error: unknown) => void
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface CrossRepoCorrectionHandlers {
  previewCrossRepoCorrection(folder: unknown, input: unknown): Promise<CommandResult<CrossRepoCorrectionPreview>>
  createCrossRepoCorrection(folder: unknown, input: unknown): Promise<CommandResult<CrossRepoCorrectionResult>>
  retryCrossRepoCorrection(folder: unknown, key: unknown): Promise<CommandResult<CrossRepoCorrectionResult>>
  withdrawCrossRepoCorrection(folder: unknown, input: unknown): Promise<CommandResult<CrossRepoWithdrawalView>>
  listCrossRepoCorrections(folder: unknown, filter: unknown): Promise<CommandResult<CrossRepoCorrectionLinkView[]>>
  collectCrossRepoResults(folder: unknown, key: unknown): Promise<CommandResult<CrossRepoCorrectionLinkView>>
}

const CHOOSE_CHECKOUT = 'Choose your Dark Mechanicus checkout (a Git clone of Dark Mechanicus on this machine) first.'

/** The tracked source folder's open project; an untracked folder is `unauthorized`, one not set up `not_initialized`. */
function sourceCtx(deps: BrokerDeps, folder: unknown): Ctx {
  return deps.pool.get(requireTracked(deps.registry, folder)).ctx()
}

/**
 * The target's project, open: the chosen checkout revalidated now (`requireAvailable`), it must still be the project the
 * request was made for, and the workspace opened at its path must be that project too. Throws before any target write.
 */
function openTarget(deps: BrokerDeps, projectId: string): Ctx {
  const { path, target } = deps.checkouts.requireAvailable()
  if (target.projectId !== projectId) {
    fail(
      'project_mismatch',
      `The chosen Dark Mechanicus checkout is now project ${target.projectId} ("${target.projectName}"), not ${projectId}, which this request was made for. Choose a checkout of ${projectId} again; nothing was written to it.`,
      { problem: 'stale_target', targetProjectId: projectId, chosenProjectId: target.projectId }
    )
  }
  const ctx = deps.pool.get(path).ctx()
  if (ctx.projectId !== target.projectId) {
    fail(
      'project_mismatch',
      `The chosen checkout's Dark Mechanicus database belongs to project ${ctx.projectId}, not ${target.projectId}, which its project record names. Nothing was written to it.`,
      { problem: 'stale_target', targetProjectId: target.projectId, databaseProjectId: ctx.projectId }
    )
  }
  return ctx
}

function detail(error: unknown, name: string): string | null {
  const value = error instanceof DomainError ? error.details?.[name] : undefined
  return typeof value === 'string' ? value : null
}

function report(deps: BrokerDeps, error: unknown): void {
  if (!(error instanceof DomainError)) deps.onUnexpectedError?.(error)
}

/** One request on its way: the broker, the source project, and the receipt's key. */
interface Delivery {
  deps: BrokerDeps
  source: Ctx
  key: string
}

/** Refusals a repeat of the same request can never get past: another payload under the key, a draft the target refuses. */
const FINAL_CODES: readonly string[] = ['idempotency_mismatch', 'invalid_input', 'invalid_graph']

/** Problems a repeat cannot get past until the person changes something: the checkout, or the request (withdraw it). */
const FINAL_PROBLEMS: readonly string[] = ['target_missing', 'experiment_closed']

function problemOf(error: unknown): string | null {
  const problem = detail(error, 'problem')
  return problem !== null && FINAL_PROBLEMS.includes(problem) ? problem : null
}

function retryable(error: unknown): boolean {
  return !FINAL_CODES.includes(toErrorShape(error).code) && problemOf(error) === null
}

/** Records a failed step on the receipt (code and problem only: an error's message may name a local path). */
function failed(delivery: Delivery, step: CrossRepoCorrectionStep, error: unknown, target: CrossRepoTargetEpicView | null): CrossRepoCorrectionLinkView | null {
  report(delivery.deps, error)
  try {
    return recordCrossRepoFailure(delivery.source, delivery.key, { step, code: toErrorShape(error).code, problem: detail(error, 'problem'), target })
  } catch (recordError) {
    // The source cannot be written either (the failed step may be that write): the result still reports the first failure.
    report(delivery.deps, recordError)
    return null
  }
}

/**
 * Removes the receipt this very call wrote, once the target refused the request for good (or, for an experiment that
 * cannot be requested as it is, held no epic to link or could not be read), and throws that refusal.
 */
function refused(delivery: Delivery, error: unknown): never {
  try {
    discardCrossRepoCorrection(delivery.source, delivery.key, 'refused')
  } catch (discardError) {
    report(delivery.deps, discardError)
  }
  throw error
}

/** What to do next with the epic the target holds, as it stands there: an unsaved draft to review and Save, or a saved plan. */
function targetSteps(target: CrossRepoTargetEpicView): string[] {
  const keys = target.keys.join(', ') || 'its tickets'
  const steps = target.saved
    ? [
        `In the Dark Mechanicus source, epic ${target.epicId} ("${target.epicTitle}") holds ${keys} in its saved plan (${target.status.replace('_', ' ')}).`,
        "Follow its runs and checkpoints there with that project's own run controls; its approvals are that project's own. Bring back its grades here once its sprints are reported."
      ]
    : [
        `In the Dark Mechanicus source, open epic ${target.epicId} ("${target.epicTitle}") and review its draft: ${keys}, their criteria, the Fireguard ticket and the acceptance node.`,
        "Bind its branch and Save the draft there, then start a run of it with the normal run controls; its checkpoints and approvals are that project's own."
      ]
  return [...steps, "Nothing runs, is approved or is retried on its own, and this project's epic, runs, reports and scores stay as they are."]
}

function pendingSteps(step: CrossRepoCorrectionStep, error: unknown): string[] {
  if (step === 'link') {
    return ['The Dark Mechanicus source holds the epic, but this project could not record the link.', 'Retry the request: it finds that epic again and records the link.']
  }
  if (problemOf(error) !== null) return [toErrorShape(error).message]
  if (!retryable(error)) {
    return [
      `The Dark Mechanicus source refused this request for good (${toErrorShape(error).code}); retrying cannot change that.`,
      'Withdraw the request, then request the experiment again: a request whose payload matches what the target holds links to it.'
    ]
  }
  const recovery = detail(error, 'recovery')
  return [
    'The Dark Mechanicus source was not written; the request is kept here (pending).',
    ...(recovery === null ? [] : [recovery]),
    'Retry the request once that is fixed: the target epic is created once, and a retry finds it again. Or withdraw it.'
  ]
}

function failureOf(step: CrossRepoCorrectionStep, error: unknown): NonNullable<CrossRepoCorrectionResult['failure']> {
  return { step, error: toErrorShape(error), retryable: retryable(error) }
}

/** A linked request whose epic the chosen checkout could not confirm: the receipt stays as it was. */
function unconfirmed(link: CrossRepoCorrectionLinkView, error: unknown): CrossRepoCorrectionResult {
  const steps = [`Linked to epic ${link.target?.epicId ?? '?'} of project ${link.targetProjectId}, but the chosen checkout could not confirm it holds that epic: ${toErrorShape(error).message}`]
  return { progress: 'linked', changed: false, link, target: link.target, failure: failureOf('target', error), nextSteps: steps }
}

interface DeliveryOptions {
  /** The receipt was written by this very call (a final refusal removes it). */
  inserted: boolean
  /** Make a new epic even when the request reached one before that the chosen checkout does not hold. */
  recreate: boolean
}

/**
 * The target step failed: a request for an experiment that cannot be requested as it is wrote nothing here, so it is
 * refused with nothing kept; a final refusal of a receipt this call wrote removes it; else the failure is recorded.
 */
function targetFailed(delivery: Delivery, begun: Omit<BegunCorrection, 'inserted'>, options: DeliveryOptions, error: unknown): CrossRepoCorrectionResult {
  if (begun.unsaved !== null && begun.closed !== null) throw closedRequestRefusal(begun.packet.provenance.source.experimentId, begun.closed)
  if (options.inserted && !retryable(error)) refused(delivery, error)
  if (begun.link.state === 'linked') return unconfirmed(begun.link, error)
  const link = failed(delivery, 'target', error, null) ?? begun.link
  return { progress: 'pending', changed: options.inserted, link, target: null, failure: failureOf('target', error), nextSteps: pendingSteps('target', error) }
}

/**
 * The link step: nothing to write when a linked receipt already names the epic the target holds. A request that wrote
 * nothing here (`unsaved`) writes its receipt now, linked to the epic the target already held.
 */
function linked(delivery: Delivery, begun: Omit<BegunCorrection, 'inserted'>, target: CrossRepoTargetEpicView): CrossRepoCorrectionResult {
  const same = begun.link.state === 'linked' && !target.created && target.epicId === begun.link.target?.epicId
  if (same) return { progress: 'linked', changed: false, link: begun.link, target, failure: null, nextSteps: targetSteps(target) }
  try {
    const link = recordCrossRepoDelivery(delivery.source, delivery.key, target, begun.unsaved)
    return { progress: 'linked', changed: true, link, target, failure: null, nextSteps: targetSteps(target) }
  } catch (error) {
    const link = failed(delivery, 'link', error, target) ?? begun.link
    return { progress: 'target_created', changed: true, link, target, failure: failureOf('link', error), nextSteps: pendingSteps('link', error) }
  }
}

/**
 * Delivers a request to the target and records the link: each step's failure is reported, never hidden. A linked
 * request is checked against the target too (nothing is written when it still holds the same epic).
 */
function deliver(deps: BrokerDeps, source: Ctx, begun: Omit<BegunCorrection, 'inserted'>, options: DeliveryOptions): CrossRepoCorrectionResult {
  const delivery: Delivery = { deps, source, key: begun.link.key }
  const expected = options.recreate ? null : (begun.link.target?.epicId ?? null)
  let target: CrossRepoTargetEpicView
  try {
    target = materializeCrossRepoCorrection(openTarget(deps, begun.link.targetProjectId), begun.packet, { expected, closed: begun.closed })
  } catch (error) {
    return targetFailed(delivery, begun, options, error)
  }
  return linked(delivery, begun, target)
}

function create(deps: BrokerDeps, folder: unknown, raw: unknown): CrossRepoCorrectionResult {
  const source = sourceCtx(deps, folder)
  const input = parseInput(createCrossRepoCorrectionInput, raw, 'cross-repository correction') as CreateCrossRepoCorrectionInput
  const chosen = deps.checkouts.view().target ?? fail('not_found', 'No Dark Mechanicus checkout is chosen on this machine.', { recovery: CHOOSE_CHECKOUT })
  const expected = input.expectedTargetProjectId
  if (expected !== chosen.projectId) {
    fail('conflict', `The chosen Dark Mechanicus checkout is now project ${chosen.projectId}, not ${expected} as previewed. Preview it again; nothing was written.`, {
      problem: 'stale_target',
      expectedTargetProjectId: expected,
      chosenProjectId: chosen.projectId
    })
  }
  const begun = beginCrossRepoCorrection(source, input, chosen)
  return deliver(deps, source, begun, { inserted: begun.inserted, recreate: input.recreate === true })
}

function retry(deps: BrokerDeps, folder: unknown, key: unknown): CrossRepoCorrectionResult {
  const source = sourceCtx(deps, folder)
  return deliver(deps, source, requestedCrossRepoCorrection(source, { key: key as string }), { inserted: false, recreate: false })
}

/**
 * Withdraws a pending request the target never accepted, so the experiment can be requested again. Refused for a linked
 * request, and for one the chosen checkout of its project holds with the same payload (retry links it). A request whose
 * epic the target accepted before (only the link failed) is withdrawn only when that checkout can be read and no
 * longer holds that epic (it was deleted there): otherwise retry it. When the checkout cannot be read, nothing says
 * whether the target holds the work: the withdrawal needs `confirmUnverified` and answers `verified: false`; should the
 * target hold it after all, a request with the same payload links to that epic again, and another checkout could get a
 * second one.
 */
function withdraw(deps: BrokerDeps, folder: unknown, raw: unknown): CrossRepoWithdrawalView {
  const source = sourceCtx(deps, folder)
  const input = parseInput(crossRepoWithdrawInput, raw, 'withdrawal')
  const link = crossRepoCorrectionLink(source, { key: input.key })
  if (link.state === 'linked') {
    fail('conflict', `The request ${link.key} cannot be withdrawn: it is linked. Epic ${link.target?.epicId ?? '?'} of project ${link.targetProjectId} holds its work.`, { key: link.key })
  }
  const check = heldByChosen(deps, link, link.target?.epicId ?? null)
  refuseHeld(link, check)
  if (!check.verified && input.confirmUnverified !== true) {
    fail(
      'conflict',
      `The checkout of project ${link.targetProjectId} cannot be read now, so nothing shows whether it already holds this request. Choose and make it available to check, or withdraw anyway with confirmUnverified.`,
      { key: link.key, problem: 'unverified' }
    )
  }
  return { withdrawn: discardCrossRepoCorrection(source, link.key, 'withdrawn'), verified: check.verified }
}

/**
 * Refuses withdrawing a pending request whose work the target holds, or may hold: the epic it accepted before while
 * that is still there or cannot be checked, or an epic under its key with the same payload. Retry it instead.
 */
function refuseHeld(link: CrossRepoCorrectionLinkView, check: ChosenCheck): void {
  const reached = link.target?.epicId ?? null
  if (reached !== null && (!check.verified || check.holdsReached)) {
    const why = check.verified ? `epic ${reached} of project ${link.targetProjectId} holds its work` : `the checkout of project ${link.targetProjectId} cannot be read to check that epic ${reached} is gone`
    fail('conflict', `The request ${link.key} cannot be withdrawn: the target accepted it (only the link failed) and ${why}. Retry it to record the link.`, { key: link.key, epicId: reached })
  }
  if (check.held !== null && check.held.payloadHash === link.payloadHash) {
    fail('conflict', `The request ${link.key} cannot be withdrawn: epic ${check.held.epicId} of project ${link.targetProjectId} holds it. Retry it to record the link.`, { key: link.key, epicId: check.held.epicId })
  }
}

interface ChosenCheck {
  /** The chosen checkout is of the request's project and could be read. */
  verified: boolean
  /** The epic it holds under the request's key (any payload). */
  held: { epicId: string; payloadHash: string } | null
  /** It holds `reached` (the epic the request reached before) under the key. */
  holdsReached: boolean
}

/** What the chosen checkout holds under the request's key, and whether it could be checked (its project, readable). */
function heldByChosen(deps: BrokerDeps, link: CrossRepoCorrectionLinkView, reached: string | null): ChosenCheck {
  const unverified: ChosenCheck = { verified: false, held: null, holdsReached: false }
  const view = deps.checkouts.view()
  if (view.status !== 'available' || view.target?.projectId !== link.targetProjectId) return unverified
  try {
    return { verified: true, ...heldCorrection(openTarget(deps, link.targetProjectId), link.key, reached) }
  } catch (error) {
    report(deps, error)
    return unverified
  }
}

function availabilityOf(view: SourceCheckoutView): CrossRepoTargetAvailability {
  return {
    status: view.status,
    projectId: view.target?.projectId ?? null,
    projectName: view.target?.projectName ?? null,
    path: view.local?.path ?? null,
    displayPath: view.local?.displayPath ?? null,
    problem: view.problem,
    message: view.message,
    recovery: view.recovery
  }
}

type Verdict = Pick<CrossRepoCorrectionPreview, 'state' | 'problems' | 'existing' | 'needsRecreate'>

function heldSteps(held: CrossRepoTargetEpicView, link: CrossRepoCorrectionLinkView | null): string[] {
  const record = link?.state === 'linked' ? [] : [`The Dark Mechanicus source already holds this request as epic ${held.epicId}: create it to record the link here; nothing new is written there.`]
  return [...record, ...targetSteps(held)]
}

function actionSteps(state: CrossRepoCorrectionState, availability: CrossRepoTargetAvailability): string[] {
  const act =
    state === 'pending'
      ? 'Retry the request to finish it (the target epic is created once, and a retry finds it again), or withdraw it.'
      : 'Create it: the Dark Mechanicus source gets a new backlog epic holding this draft; nothing else changes in either project.'
  return availability.status === 'available' ? [act] : [availability.recovery ?? CHOOSE_CHECKOUT, act]
}

function recreateSteps(link: CrossRepoCorrectionLinkView | null): string[] {
  const epicId = link?.target?.epicId ?? '?'
  return [
    `The chosen checkout does not hold epic ${epicId}, which this request reached before (it was deleted there, or another checkout of the project holds it). Choose the checkout that holds it, or create the request again with recreate to make a new epic.`
  ]
}

function blockedSteps(link: CrossRepoCorrectionLinkView | null): string[] {
  const withdraw = link?.state === 'pending' ? ['Withdraw the pending request to request the experiment again.'] : []
  return ['Nothing can be created as it is: see the problems.', ...withdraw]
}

function previewSteps(verdict: Verdict, availability: CrossRepoTargetAvailability, link: CrossRepoCorrectionLinkView | null): string[] {
  const { state } = verdict
  if (verdict.needsRecreate) return recreateSteps(link)
  const held = verdict.existing ?? link?.target ?? null
  if (state === 'created' && held !== null) return heldSteps(held, link)
  if (state === 'blocked' || state === 'conflict') return blockedSteps(link)
  return actionSteps(state, availability)
}

/** The target's answer for the packet, or why the chosen checkout could not be read (as its availability). */
function readTarget(deps: BrokerDeps, side: SourcePreview, view: SourceCheckoutView): { read: TargetPreview | null; availability: CrossRepoTargetAvailability } {
  const availability = availabilityOf(view)
  if (side.packet === null || view.status !== 'available') return { read: null, availability }
  try {
    return { read: previewCrossRepoTarget(openTarget(deps, side.packet.provenance.target.projectId), side.packet), availability }
  } catch (error) {
    report(deps, error)
    const shape = toErrorShape(error)
    return { read: null, availability: { ...availability, status: 'unavailable', problem: detail(error, 'problem') ?? shape.code, message: shape.message, recovery: detail(error, 'recovery') } }
  }
}

/** Whether the request reached an epic before that the chosen checkout (which answered) does not hold. */
function missingEpic(side: SourcePreview, read: TargetPreview): boolean {
  const reached = side.link !== null && side.link.key === side.packet?.provenance.key ? side.link.target : null
  return reached !== null && read.existing === null && read.state !== 'conflict'
}

/**
 * A request the target holds although the experiment no longer takes new work: a pending receipt (a retry only
 * records the link), or no receipt at all (it was lost here; creating it records the link to that epic).
 */
function linkable(side: SourcePreview, read: TargetPreview): boolean {
  return (side.link === null || side.link.state === 'pending') && side.state === 'blocked' && read.state === 'created' && read.existing !== null
}

/**
 * The state, problems and existing epic once the target has answered: a conflict there is the request's; an epic the
 * request reached before but the checkout lacks needs `recreate`; a request the target already holds (its receipt was
 * lost here) is `created`, and creating it only records the link, even once the experiment closed.
 */
function verdictOf(side: SourcePreview, read: TargetPreview | null): Verdict {
  if (read === null) return { state: side.state, problems: side.problems, existing: null, needsRecreate: false }
  const base = { problems: [...side.problems, ...read.problems], existing: read.existing, needsRecreate: false }
  if (read.state === 'conflict' && side.state !== 'blocked') return { ...base, state: 'conflict' }
  if (linkable(side, read)) return { ...base, problems: [], state: side.link === null ? 'created' : 'pending' }
  if (missingEpic(side, read)) return { ...base, state: side.state === 'created' ? 'ready' : side.state, needsRecreate: true }
  return { ...base, state: side.state === 'ready' && read.existing !== null ? 'created' : side.state }
}

/** The draft the target would hold: as the target plans it, else with placeholder keys, else none (no target chosen). */
function draftOf(source: Ctx, side: SourcePreview, read: TargetPreview | null): Pick<CrossRepoCorrectionPreview, 'tickets' | 'dependencies' | 'validation'> {
  if (read !== null) return { tickets: read.tickets, dependencies: read.dependencies, validation: read.validation }
  if (side.packet === null) return { tickets: [], dependencies: [], validation: null }
  const planned = plannedTickets(side.packet, placeholderDeps(source))
  return { tickets: planned.tickets, dependencies: planned.dependencies, validation: null }
}

function requestOf(side: SourcePreview): Pick<CrossRepoCorrectionPreview, 'key' | 'payloadHash' | 'provenance'> {
  if (side.packet === null) return { key: null, payloadHash: null, provenance: null }
  const { provenance } = side.packet
  return { key: provenance.key, payloadHash: provenance.payloadHash, provenance }
}

function sourceSummary(from: SourcePreview['source']): CrossRepoCorrectionPreview['source'] {
  return {
    projectId: from.projectId,
    projectName: from.projectName,
    epicId: from.epic.id,
    epicTitle: from.epic.title,
    epicStatus: from.epic.status,
    runId: from.runId,
    sprintId: from.sprintId,
    sprintOrdinal: from.sprintOrdinal,
    reportId: from.reportId,
    reportRevision: from.reportRevision
  }
}

/** Read only in both projects. Opening the target's workspace is the only effect, as for any tracked folder. */
function preview(deps: BrokerDeps, folder: unknown, raw: unknown): CrossRepoCorrectionPreview {
  const source = sourceCtx(deps, folder)
  const view = deps.checkouts.view()
  const side = previewCrossRepoSource(source, raw as CrossRepoCorrectionInput, view.target)
  const { read, availability } = readTarget(deps, side, view)
  const verdict = verdictOf(side, read)
  return {
    source: sourceSummary(side.source),
    experimentId: side.experiment.id,
    concern: side.experiment.concern ?? null,
    ...verdict,
    target: availability,
    ...requestOf(side),
    epic: side.epic,
    ...draftOf(source, side, read),
    link: side.link,
    nextSteps: previewSteps(verdict, availability, side.link)
  }
}

/**
 * Brings back what the target epic of a linked request holds for measuring the experiment: read through the chosen
 * checkout (`requireAvailable`, the same project), kept on the source's receipt. Nothing is written to the target.
 */
function collect(deps: BrokerDeps, folder: unknown, key: unknown): CrossRepoCorrectionLinkView {
  const source = sourceCtx(deps, folder)
  const link = crossRepoCorrectionLink(source, { key: key as string })
  if (link.state !== 'linked' || link.target === null) {
    fail('conflict', `The request ${link.key} is not linked to an epic yet: retry it to finish it before bringing back its results.`, { key: link.key })
  }
  const read = crossRepoResults(openTarget(deps, link.targetProjectId), { key: link.key, epicId: link.target.epicId, experimentId: link.experimentId })
  return recordCrossRepoResults(source, link.key, { ...read, readAt: source.clock.nowIso() })
}

/** Runs one request synchronously (so two clicks never interleave) and answers like `dm:command`. */
function answer<T>(deps: BrokerDeps, run: () => T): CommandResult<T> {
  try {
    return { ok: true, data: run() }
  } catch (error) {
    report(deps, error)
    return { ok: false, error: toErrorShape(error) }
  }
}

export function createCrossRepoCorrectionHandlers(deps: BrokerDeps): CrossRepoCorrectionHandlers {
  return {
    previewCrossRepoCorrection: async (folder, input) => answer(deps, () => preview(deps, folder, input)),
    createCrossRepoCorrection: async (folder, input) => answer(deps, () => create(deps, folder, input)),
    retryCrossRepoCorrection: async (folder, key) => answer(deps, () => retry(deps, folder, key)),
    withdrawCrossRepoCorrection: async (folder, input) => answer(deps, () => withdraw(deps, folder, input)),
    listCrossRepoCorrections: async (folder, filter) => answer(deps, () => listCrossRepoCorrections(sourceCtx(deps, folder), (filter ?? {}) as { reportId?: string })),
    collectCrossRepoResults: async (folder, key) => answer(deps, () => collect(deps, folder, key))
  }
}

/** Each channel forwards only its payload arguments. */
export function registerCrossRepoCorrectionIpc(ipcMain: Pick<IpcMain, 'handle'>, handlers: CrossRepoCorrectionHandlers): void {
  ipcMain.handle('corrections:previewCrossRepo', (_event, folder: unknown, input: unknown) => handlers.previewCrossRepoCorrection(folder, input))
  ipcMain.handle('corrections:createCrossRepo', (_event, folder: unknown, input: unknown) => handlers.createCrossRepoCorrection(folder, input))
  ipcMain.handle('corrections:retryCrossRepo', (_event, folder: unknown, key: unknown) => handlers.retryCrossRepoCorrection(folder, key))
  ipcMain.handle('corrections:withdrawCrossRepo', (_event, folder: unknown, input: unknown) => handlers.withdrawCrossRepoCorrection(folder, input))
  ipcMain.handle('corrections:listCrossRepo', (_event, folder: unknown, filter: unknown) => handlers.listCrossRepoCorrections(folder, filter))
  ipcMain.handle('corrections:collectCrossRepo', (_event, folder: unknown, key: unknown) => handlers.collectCrossRepoResults(folder, key))
}
