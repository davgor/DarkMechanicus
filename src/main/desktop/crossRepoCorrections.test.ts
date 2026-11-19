import { mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { updatePlanDraft } from '../../core/services/drafts'
import { recordExperimentEvent } from '../../core/services/experiments'
import type { CommandResult } from '../../shared/desktop/api'
import type { CrossRepoCorrectionPreview, CrossRepoCorrectionResult } from '../../shared/domain/crossRepoCorrections'
import type { PlanBundle } from '../../shared/domain/bundle'
import { DM_PROJECT, correctionEpics, dmProject, historyOf, machine, markerCheckout, reportedSource, type Machine, type ReportedSource } from '../../test/crossRepoWorld'
import { seedRevision } from '../../test/execution'
import { withRole, type TestCtx } from '../../test/testContext'

const OTHER_PROJECT = 'pj_000000000000000000000000x1'

let m: Machine

beforeEach(() => {
  m = machine()
})

afterEach(() => {
  m.cleanup()
})

interface World {
  src: ReportedSource
  sourcePath: string
  dm: TestCtx
  dmPath: string
}

/** A tracked source project and a tracked, chosen Dark Mechanicus checkout, each with its own project. */
function world(name = 'shop'): World {
  const src = reportedSource()
  const folder = join(m.root, name)
  mkdirSync(folder)
  const sourcePath = m.registry.track(folder).folder.path
  m.projects.set(sourcePath, src.desktop)
  const dm = dmProject()
  const dmPath = m.registry.track(markerCheckout(join(m.root, 'dm'))).folder.path
  m.projects.set(dmPath, dm)
  expect(m.checkouts.associate(dmPath, false).outcome).toBe('associated')
  return { src, sourcePath, dm, dmPath }
}

function createInput(w: World, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { reportId: w.src.report.id, experimentId: w.src.xp.dm.id, expectedTargetProjectId: DM_PROJECT, ...patch }
}

function ok<T>(answer: CommandResult<T>): T {
  if (!answer.ok) throw new Error(`${answer.error.code}: ${answer.error.message}`)
  return answer.data
}

function codeOf(answer: CommandResult<unknown>): string {
  return answer.ok ? 'ok' : answer.error.code
}

/** Makes the source's link write fail like a disk error; `every` fails every receipt update (the failure record too). */
function breakLinkWrites(src: ReportedSource, every = false): void {
  const when = every ? '' : "WHEN NEW.state = 'linked'"
  src.ctx.db.exec(`CREATE TRIGGER fail_link BEFORE UPDATE ON correction_links ${when} BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END`)
}

function repairLinkWrites(src: ReportedSource): void {
  src.ctx.db.exec('DROP TRIGGER fail_link')
}

function receipts(src: ReportedSource): { key: string; state: string; attempts: number; target_json: string | null }[] {
  return src.ctx.db.all('SELECT key, state, attempts, target_json FROM correction_links')
}

describe('DM-270 c4 / DM-190 c2: a retry after a partial failure yields one target epic and unchanged source history', () => {
  it('target created, link failed: reports target_created, then the retry links the same epic with no duplicate', async () => {
    const w = world()
    const history = historyOf(w.src.ctx)
    breakLinkWrites(w.src)
    const first = ok(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w))) as CrossRepoCorrectionResult
    expect(first).toMatchObject({ progress: 'target_created', changed: true, failure: { step: 'link', retryable: true } })
    expect(first.target?.created).toBe(true)
    const epicId = first.target?.epicId
    expect(receipts(w.src)).toEqual([expect.objectContaining({ state: 'pending', attempts: 1 })])
    expect(first.link.target?.epicId).toBe(epicId)
    repairLinkWrites(w.src)
    const retried = ok(await m.broker.retryCrossRepoCorrection(w.sourcePath, first.link.key))
    expect(retried).toMatchObject({ progress: 'linked', changed: true, failure: null, target: { epicId, created: false } })
    const repeated = ok(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))
    expect(repeated).toMatchObject({ progress: 'linked', changed: false, target: { epicId, created: false } })
    expect(correctionEpics(w.dm).map((epic) => epic.id)).toEqual([epicId])
    expect(receipts(w.src)).toEqual([expect.objectContaining({ state: 'linked', attempts: 2 })])
    expect(historyOf(w.src.ctx)).toBe(history)
    expect(m.unexpected).toHaveLength(1)
  })

  it('no trace in the source (link and failure record both failed): the retry still finds the one epic', async () => {
    const w = world()
    const history = historyOf(w.src.ctx)
    breakLinkWrites(w.src, true)
    const first = ok(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))
    expect(first).toMatchObject({ progress: 'target_created', failure: { step: 'link' } })
    expect(receipts(w.src)).toEqual([expect.objectContaining({ state: 'pending', attempts: 0, target_json: null })])
    repairLinkWrites(w.src)
    const retried = ok(await m.broker.retryCrossRepoCorrection(w.sourcePath, first.link.key))
    expect(retried).toMatchObject({ progress: 'linked', target: { epicId: first.target?.epicId, created: false } })
    expect(correctionEpics(w.dm)).toHaveLength(1)
    expect(historyOf(w.src.ctx)).toBe(history)
  })
})

describe('DM-190 c2: failures are reported and conflicting payloads fail', () => {
  it('target unavailable: the request stays pending with a retryable target failure and nothing written there', async () => {
    const w = world()
    renameSync(w.dmPath, join(m.root, 'away'))
    const first = ok(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))
    expect(first).toMatchObject({ progress: 'pending', changed: true, target: null, failure: { step: 'target', retryable: true, error: { code: 'not_found' } } })
    expect(first.link.lastError).toMatchObject({ step: 'target', code: 'not_found', problem: 'missing' })
    expect(JSON.stringify(first.link)).not.toContain(m.root)
    expect(correctionEpics(w.dm)).toEqual([])
    renameSync(join(m.root, 'away'), w.dmPath)
    const retried = ok(await m.broker.retryCrossRepoCorrection(w.sourcePath, first.link.key))
    expect(retried).toMatchObject({ progress: 'linked', target: { created: true } })
    expect(correctionEpics(w.dm)).toHaveLength(1)
  })

  it('conflicting payload reuse fails: the target refuses it for good and the receipt this call wrote is removed', async () => {
    const w = world()
    ok(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))
    // Another machine (its own source records, no receipt) asks with another title.
    const other = reportedSource()
    const folder = join(m.root, 'other')
    mkdirSync(folder)
    const otherPath = m.registry.track(folder).folder.path
    m.projects.set(otherPath, other.desktop)
    const refused = await m.broker.createCrossRepoCorrection(otherPath, { ...createInput(w), title: 'Another title' })
    expect(codeOf(refused)).toBe('idempotency_mismatch')
    expect(receipts(other)).toEqual([])
    expect(correctionEpics(w.dm)).toHaveLength(1)
    const same = ok(await m.broker.createCrossRepoCorrection(otherPath, createInput(w)))
    expect(same).toMatchObject({ progress: 'linked', target: { created: false, epicId: correctionEpics(w.dm)[0]?.id } })
  })
})

describe('DM-189 c2 / DM-190 c1: the target is the revalidated chosen checkout, never a renderer path', () => {
  it('refuses a create when no checkout is chosen, and when the chosen project differs from the previewed one', async () => {
    const w = world()
    expect(codeOf(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w, { expectedTargetProjectId: 'pj_000000000000000000000000x1' })))).toBe('conflict')
    m.checkouts.clear()
    expect(codeOf(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))).toBe('not_found')
    expect(receipts(w.src)).toEqual([])
    expect(correctionEpics(w.dm)).toEqual([])
  })

  it('refuses an untracked source folder (unauthorized)', async () => {
    const w = world()
    expect(codeOf(await m.broker.createCrossRepoCorrection(join(m.root, 'untracked'), createInput(w)))).toBe('unauthorized')
  })

  it('refuses an experiment aimed at the source repository itself and keeps nothing', async () => {
    const w = world()
    const answer = await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w, { experimentId: w.src.xp.local.id }))
    expect(codeOf(answer)).toBe('conflict')
    expect(answer.ok ? '' : answer.error.message).toContain("its destination is this project's repository")
    expect(receipts(w.src)).toEqual([])
    expect(correctionEpics(w.dm)).toEqual([])
  })
})

/** The chosen checkout moved away (unavailable) while `action` runs, then put back. */
async function whileAway<T>(w: World, action: () => Promise<T>): Promise<T> {
  renameSync(w.dmPath, join(m.root, 'away'))
  try {
    return await action()
  } finally {
    renameSync(join(m.root, 'away'), w.dmPath)
  }
}

/** A pending request the target never saw: created while the chosen checkout was unavailable. */
async function pendingRequest(w: World): Promise<string> {
  return ok(await whileAway(w, () => m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))).link.key
}

/** A request whose target epic was created but whose link failed (`recorded`: the failure, with that epic, is on the receipt). */
async function unlinkedRequest(w: World, recorded: boolean): Promise<CrossRepoCorrectionResult> {
  breakLinkWrites(w.src, !recorded)
  const first = ok(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))
  repairLinkWrites(w.src)
  return first
}

/** A tracked folder of another source project, requesting the same experiment id with no receipt of its own. */
function otherSource(): { src: ReportedSource; path: string } {
  const src = reportedSource()
  const folder = join(m.root, 'other')
  mkdirSync(folder)
  const path = m.registry.track(folder).folder.path
  m.projects.set(path, src.desktop)
  return { src, path }
}

function abandon(src: ReportedSource): void {
  recordExperimentEvent(withRole(src.ctx, 'orchestrator'), { experimentId: src.xp.dm.id, event: { kind: 'status', status: 'abandoned', note: 'Not worth it' } })
}

/** Chooses a tracked Dark Mechanicus checkout of another project instead. */
function chooseOtherProject(): void {
  const path = m.registry.track(markerCheckout(join(m.root, 'dm-other'), { projectId: OTHER_PROJECT })).folder.path
  m.projects.set(path, dmProject(OTHER_PROJECT))
  m.checkouts.associate(path, false)
}

describe('DM-273: withdrawing a pending request the target never accepted', () => {
  it('withdraws a request the chosen checkout holds nothing for, so the experiment can be requested again', async () => {
    const w = world()
    const key = await pendingRequest(w)
    expect(ok(await m.broker.withdrawCrossRepoCorrection(w.sourcePath, { key }))).toMatchObject({ withdrawn: { key, state: 'pending' }, verified: true })
    expect(receipts(w.src)).toEqual([])
    expect(ok(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))).toMatchObject({ progress: 'linked', target: { created: true } })
  })

  it('refuses withdrawing a linked request', async () => {
    const w = world()
    const created = ok(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))
    const answer = await m.broker.withdrawCrossRepoCorrection(w.sourcePath, { key: created.link.key })
    expect(answer.ok ? '' : answer.error.message).toBe(`The request ${created.link.key} cannot be withdrawn: it is linked. Epic ${created.target?.epicId} of project ${DM_PROJECT} holds its work.`)
    expect(receipts(w.src)).toEqual([expect.objectContaining({ state: 'linked' })])
  })

  it('refuses withdrawing a request whose key the checkout holds with the same payload', async () => {
    const w = world()
    const first = await unlinkedRequest(w, false)
    const answer = await m.broker.withdrawCrossRepoCorrection(w.sourcePath, { key: first.link.key })
    expect(answer.ok ? null : answer.error.details).toEqual({ key: first.link.key, epicId: first.target?.epicId })
    expect(answer.ok ? '' : answer.error.message).toContain(`holds it. Retry it to record the link.`)
    expect(receipts(w.src)).toHaveLength(1)
  })

  it('refuses withdrawing a request whose accepted epic the checkout still holds, or cannot be read to check', async () => {
    const w = world()
    const first = await unlinkedRequest(w, true)
    const epicId = first.target?.epicId
    const held = await m.broker.withdrawCrossRepoCorrection(w.sourcePath, { key: first.link.key })
    expect(held.ok ? '' : held.error.message).toContain(`only the link failed) and epic ${epicId} of project ${DM_PROJECT} holds its work.`)
    const unread = await whileAway(w, () => m.broker.withdrawCrossRepoCorrection(w.sourcePath, { key: first.link.key, confirmUnverified: true }))
    expect(unread.ok ? '' : unread.error.message).toContain(`the checkout of project ${DM_PROJECT} cannot be read to check that epic ${epicId} is gone`)
    expect(receipts(w.src)).toHaveLength(1)
  })
})

describe('DM-273: withdrawing a request whose target epic is gone or cannot be checked', () => {
  it('withdraws a request whose accepted epic the checkout no longer holds', async () => {
    const w = world()
    const first = await unlinkedRequest(w, true)
    m.projects.set(w.dmPath, dmProject())
    expect(ok(await m.broker.withdrawCrossRepoCorrection(w.sourcePath, { key: first.link.key }))).toMatchObject({ withdrawn: { key: first.link.key }, verified: true })
    expect(receipts(w.src)).toEqual([])
  })

  it('asks to confirm withdrawing a request no chosen checkout can check, and withdraws it unverified once confirmed', async () => {
    const w = world()
    const key = await pendingRequest(w)
    m.projects.set(w.dmPath, dmProject(OTHER_PROJECT))
    expect(await m.broker.withdrawCrossRepoCorrection(w.sourcePath, { key })).toMatchObject({ ok: false, error: { code: 'conflict', details: { key, problem: 'unverified' } } })
    chooseOtherProject()
    expect(await m.broker.withdrawCrossRepoCorrection(w.sourcePath, { key })).toMatchObject({ ok: false, error: { details: { problem: 'unverified' } } })
    expect(ok(await m.broker.withdrawCrossRepoCorrection(w.sourcePath, { key, confirmUnverified: true }))).toMatchObject({ withdrawn: { key }, verified: false })
    expect(receipts(w.src)).toEqual([])
  })
})

describe('DM-273: a delivery that cannot finish says why and what to do next', () => {
  it('reports a linked request whose epic the chosen checkout cannot confirm, leaving its receipt as it was', async () => {
    const w = world()
    const created = ok(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))
    const retried = ok(await whileAway(w, () => m.broker.retryCrossRepoCorrection(w.sourcePath, created.link.key)))
    expect(retried).toMatchObject({ progress: 'linked', changed: false, failure: { step: 'target', error: { code: 'not_found' } } })
    expect(retried.nextSteps[0]).toContain(`Linked to epic ${created.target?.epicId} of project ${DM_PROJECT}, but the chosen checkout could not confirm it holds that epic: `)
    expect(receipts(w.src)).toEqual([expect.objectContaining({ state: 'linked', attempts: 1 })])
  })

  it('refuses a retry once the checkout lacks the epic the request reached, and recreate makes a new epic', async () => {
    const w = world()
    const first = await unlinkedRequest(w, true)
    const fresh = dmProject()
    m.projects.set(w.dmPath, fresh)
    const retried = ok(await m.broker.retryCrossRepoCorrection(w.sourcePath, first.link.key))
    expect(retried).toMatchObject({ progress: 'pending', failure: { retryable: false, error: { code: 'conflict', details: { problem: 'target_missing' } } } })
    expect(retried.nextSteps).toEqual([retried.failure?.error.message])
    const recreated = ok(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w, { recreate: true })))
    expect(recreated).toMatchObject({ progress: 'linked', target: { created: true } })
    expect(correctionEpics(fresh).map((epic) => epic.id)).toEqual([recreated.target?.epicId])
  })

  it('records a refusal for good on a retry of an earlier request and says to withdraw it', async () => {
    const w = world()
    const key = await pendingRequest(w)
    const other = otherSource()
    ok(await m.broker.createCrossRepoCorrection(other.path, createInput(w, { title: 'Another title' })))
    const retried = ok(await m.broker.retryCrossRepoCorrection(w.sourcePath, key))
    expect(retried).toMatchObject({ progress: 'pending', changed: false, failure: { retryable: false, error: { code: 'idempotency_mismatch' } } })
    expect(retried.nextSteps[0]).toBe('The Dark Mechanicus source refused this request for good (idempotency_mismatch); retrying cannot change that.')
    expect(receipts(w.src)).toEqual([expect.objectContaining({ state: 'pending', attempts: 2 })])
  })

  it('refuses a chosen checkout that is now another project, or whose database is (stale_target), keeping the request to retry', async () => {
    const w = world()
    const key = await pendingRequest(w)
    m.projects.set(w.dmPath, dmProject(OTHER_PROJECT))
    const database = ok(await m.broker.retryCrossRepoCorrection(w.sourcePath, key))
    expect(database.failure).toMatchObject({ retryable: true, error: { code: 'project_mismatch', details: { databaseProjectId: OTHER_PROJECT } } })
    expect(database.nextSteps).toHaveLength(2)
    chooseOtherProject()
    const chosen = ok(await m.broker.retryCrossRepoCorrection(w.sourcePath, key))
    expect(chosen.failure?.error.details).toEqual({ problem: 'stale_target', targetProjectId: DM_PROJECT, chosenProjectId: OTHER_PROJECT })
    expect(receipts(w.src)).toEqual([expect.objectContaining({ state: 'pending', attempts: 3 })])
  })
})

describe('DM-273: a delivery shows the target epic as it stands, and collects only once linked', () => {
  it('points at the saved plan of a target epic that was saved there', async () => {
    const w = world()
    const created = ok(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))
    const epicId = created.target?.epicId ?? ''
    const draft = w.dm.db.get<{ bundle_json: string }>('SELECT bundle_json FROM drafts WHERE epic_id = ?', epicId)
    seedRevision(w.dm, epicId, JSON.parse(draft?.bundle_json ?? 'null') as PlanBundle)
    w.dm.db.run('DELETE FROM drafts WHERE epic_id = ?', epicId)
    const retried = ok(await m.broker.retryCrossRepoCorrection(w.sourcePath, created.link.key))
    expect(retried).toMatchObject({ progress: 'linked', changed: false, target: { saved: true } })
    expect(retried.nextSteps[0]).toContain(`epic ${epicId} ("${created.target?.epicTitle}") holds ${created.target?.keys.join(', ')} in its saved plan (backlog).`)
  })

  it('refuses to bring back results of a request not linked yet, and lists receipts without a filter', async () => {
    const w = world()
    const key = await pendingRequest(w)
    const answer = await m.broker.collectCrossRepoResults(w.sourcePath, key)
    expect(answer.ok ? '' : answer.error.message).toBe(`The request ${key} is not linked to an epic yet: retry it to finish it before bringing back its results.`)
    expect(ok(await m.broker.listCrossRepoCorrections(w.sourcePath, undefined)).map((link) => link.key)).toEqual([key])
  })
})

describe('DM-273: a delivery whose source cannot record its outcome still answers', () => {
  it('reports a target failure the receipt cannot record, with the receipt as it was read', async () => {
    const w = world()
    const key = await pendingRequest(w)
    breakLinkWrites(w.src, true)
    const retried = ok(await whileAway(w, () => m.broker.retryCrossRepoCorrection(w.sourcePath, key)))
    expect(retried).toMatchObject({ progress: 'pending', link: { key, attempts: 1 }, failure: { step: 'target', retryable: true } })
    expect(m.unexpected).toEqual([expect.objectContaining({ message: 'injected disk failure' })])
  })

  it('still refuses for good when the receipt this call wrote cannot be removed', async () => {
    const w = world()
    const other = otherSource()
    ok(await m.broker.createCrossRepoCorrection(other.path, createInput(w, { title: 'Another title' })))
    w.src.ctx.db.exec("CREATE TRIGGER keep_link BEFORE DELETE ON correction_links BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END")
    expect(codeOf(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))).toBe('idempotency_mismatch')
    expect(receipts(w.src)).toEqual([expect.objectContaining({ state: 'pending' })])
    expect(m.unexpected).toEqual([expect.objectContaining({ message: 'injected disk failure' })])
  })

  it("names the target epic's tickets generically once its draft no longer holds the corrective ones", async () => {
    const w = world()
    const created = ok(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))
    const target = created.target
    const ops = (target?.ticketIds ?? []).map((ticket) => ({ op: 'remove_ticket' as const, ticket }))
    updatePlanDraft(w.dm, { epicId: target?.epicId ?? '', expectedDraftRevision: target?.draftRevision ?? 0, ops })
    const retried = ok(await m.broker.retryCrossRepoCorrection(w.sourcePath, created.link.key))
    expect(retried.target).toMatchObject({ epicId: target?.epicId, keys: [] })
    expect(retried.nextSteps[0]).toContain('and review its draft: its tickets, their criteria')
  })
})

async function preview(w: World, path = w.sourcePath, patch: Record<string, unknown> = {}): Promise<CrossRepoCorrectionPreview> {
  return ok(await m.broker.previewCrossRepoCorrection(path, { reportId: w.src.report.id, experimentId: w.src.xp.dm.id, ...patch }))
}

const CREATE_STEP = 'Create it: the Dark Mechanicus source gets a new backlog epic holding this draft; nothing else changes in either project.'
const RETRY_STEP = 'Retry the request to finish it (the target epic is created once, and a retry finds it again), or withdraw it.'
const CHOOSE_STEP = 'Choose your Dark Mechanicus checkout (a Git clone of Dark Mechanicus on this machine) first.'

describe('DM-273: the preview reads the chosen checkout without writing to either project', () => {
  it('plans a ready request as the chosen checkout would hold it', async () => {
    const w = world()
    const shown = await preview(w)
    expect(shown).toMatchObject({ state: 'ready', experimentId: w.src.xp.dm.id, concern: 'plan_context', existing: null, needsRecreate: false, target: { status: 'available', projectId: DM_PROJECT }, validation: { errors: [] } })
    expect(shown.key).toBe(`${w.src.report.id}/${w.src.xp.dm.id}/from:${w.src.ctx.projectId}/to:${DM_PROJECT}`)
    expect(shown.nextSteps).toEqual([CREATE_STEP])
    expect(receipts(w.src)).toEqual([])
    expect(correctionEpics(w.dm)).toEqual([])
  })

  it('plans with placeholder keys while the chosen checkout is unavailable, saying how to make it available', async () => {
    const w = world()
    const shown = await whileAway(w, () => preview(w))
    expect(shown).toMatchObject({ state: 'ready', validation: null, target: { status: 'unavailable', problem: 'missing' } })
    expect(shown.tickets.map((ticket) => ticket.key)).toEqual(expect.arrayContaining(['NEW-2', 'NEW-3']))
    expect(shown.nextSteps).toEqual([shown.target.recovery, CREATE_STEP])
  })

  it('shows no draft without a chosen checkout, asking to choose one first', async () => {
    const w = world()
    m.checkouts.clear()
    const shown = await preview(w)
    expect(shown).toMatchObject({ key: null, payloadHash: null, provenance: null, tickets: [], dependencies: [], validation: null, target: { status: 'none', path: null } })
    expect(shown.nextSteps).toEqual(['Choose your Dark Mechanicus checkout (a Git clone of Dark Mechanicus on this machine).', CREATE_STEP])
  })

  it('shows a checkout that cannot be opened, or is another project, as unavailable', async () => {
    const w = world()
    m.projects.set(w.dmPath, dmProject(OTHER_PROJECT))
    const stale = await preview(w)
    expect(stale).toMatchObject({ state: 'ready', target: { status: 'unavailable', problem: 'stale_target', recovery: null } })
    expect(stale.nextSteps).toEqual([CHOOSE_STEP, CREATE_STEP])
    m.projects.delete(w.dmPath)
    expect((await preview(w)).target).toMatchObject({ status: 'unavailable', problem: 'internal', message: `No project is open at ${w.dmPath}.` })
    expect(m.unexpected).toHaveLength(1)
  })
})

describe('DM-273: the preview states what a request needs next', () => {
  it('shows a linked request as held there, and the same request from a source without its receipt as created to link', async () => {
    const w = world()
    const created = ok(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))
    const linked = await preview(w)
    expect(linked).toMatchObject({ state: 'created', existing: { epicId: created.target?.epicId } })
    expect(linked.nextSteps[0]).toContain(`open epic ${created.target?.epicId}`)
    const other = otherSource()
    const lost = await preview(w, other.path)
    expect(lost).toMatchObject({ state: 'created', link: null })
    expect(lost.nextSteps[0]).toBe(`The Dark Mechanicus source already holds this request as epic ${created.target?.epicId}: create it to record the link here; nothing new is written there.`)
  })

  it('asks to retry a request whose link failed', async () => {
    const w = world()
    await unlinkedRequest(w, true)
    expect(await preview(w)).toMatchObject({ state: 'pending', needsRecreate: false, nextSteps: [RETRY_STEP] })
  })

  it('asks to recreate a request whose reached epic the chosen checkout lacks', async () => {
    const w = world()
    const created = ok(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))
    m.projects.set(w.dmPath, dmProject())
    const shown = await preview(w)
    expect(shown).toMatchObject({ state: 'ready', needsRecreate: true, existing: null })
    expect(shown.nextSteps).toEqual([expect.stringContaining(`The chosen checkout does not hold epic ${created.target?.epicId}, which this request reached before`)])
  })

  it('asks to recreate a pending request whose accepted epic the chosen checkout lacks', async () => {
    const w = world()
    await unlinkedRequest(w, true)
    m.projects.set(w.dmPath, dmProject())
    expect(await preview(w)).toMatchObject({ state: 'pending', needsRecreate: true, existing: null })
  })

  it('shows another payload under the key as a conflict, and an experiment aimed at its own repository as blocked', async () => {
    const w = world()
    const other = otherSource()
    ok(await m.broker.createCrossRepoCorrection(other.path, createInput(w)))
    const conflict = await preview(w, w.sourcePath, { title: 'Another title' })
    expect(conflict).toMatchObject({ state: 'conflict', nextSteps: ['Nothing can be created as it is: see the problems.'] })
    expect(conflict.problems).toEqual([expect.stringContaining('already holds the corrective work under key')])
    const blocked = await preview(w, w.sourcePath, { experimentId: w.src.xp.local.id })
    expect(blocked).toMatchObject({ state: 'blocked', nextSteps: ['Nothing can be created as it is: see the problems.'] })
  })
})

describe('DM-273: the preview of an experiment closed since its request', () => {
  it('asks to retry a pending request the target holds, its problems cleared', async () => {
    const w = world()
    await unlinkedRequest(w, false)
    abandon(w.src)
    expect(await preview(w)).toMatchObject({ state: 'pending', problems: [], nextSteps: [RETRY_STEP] })
  })

  it('shows a request the target holds and this source has no receipt of as created, to record the link', async () => {
    const w = world()
    const created = ok(await m.broker.createCrossRepoCorrection(w.sourcePath, createInput(w)))
    const other = otherSource()
    abandon(other.src)
    const shown = await preview(w, other.path)
    expect(shown).toMatchObject({ state: 'created', problems: [], link: null, existing: { epicId: created.target?.epicId } })
    expect(shown.nextSteps[0]).toContain('create it to record the link here')
  })

  it('blocks a pending request the target lacks, offering to withdraw it', async () => {
    const w = world()
    await pendingRequest(w)
    abandon(w.src)
    const shown = await preview(w)
    expect(shown).toMatchObject({ state: 'blocked', problems: ['it is abandoned'] })
    expect(shown.nextSteps).toEqual(['Nothing can be created as it is: see the problems.', 'Withdraw the pending request to request the experiment again.'])
  })
})
