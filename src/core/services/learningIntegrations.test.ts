/**
 * DM-950: machine-local execution authority over learning integrations, against real temporary repositories. Only the
 * person's preparation at the desktop creates an integration this machine may execute; an imported or externally
 * changed one is inert until the person re-prepares it, and startup recovery lists only this machine's open ones.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { KanbanPacket, LearningBranchManifest } from '../../shared/domain/kanban'
import type { LearningEvidenceItem, LearningIntegrationManifest, SprintLearningCardView } from '../../shared/domain/learnings'
import type { SessionRole } from '../../shared/domain/views'
import { captureError } from '../../test/authoring'
import { makeBundle, sid } from '../../test/bundles'
import { seedAttempt, seedRun, type SeededRun } from '../../test/checkpointSeed'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { contentHash } from '../canonical'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { kanbanCommands } from '../commands/kanban'
import { DomainError } from '../errors'
import { createGitAdapter } from '../repo/git'
import { approveKanbanCard, claimKanbanCard, playKanbanCard } from './kanban/attempts'
import { createKanbanCard } from './kanban/cards'
import { collectLearningEvidence } from './learningEvidence'
import { listLocalPendingLearningIntegrations, prepareLearningIntegration, requireLocalIntegrationAuthority } from './learningIntegrations'
import { getStagedLearningDrafts } from './learningPublication'

const EPIC = 'epic/x'
const THIS_MACHINE = 'mc_00000000000000000000000001'
const OTHER_MACHINE = 'mc_00000000000000000000000002'
const AGENT_ROLES: SessionRole[] = ['planner', 'orchestrator', 'worker', 'reviewer', 'reader']

const repos: GitRepo[] = []
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

interface Repo {
  name: string | null
  repo: GitRepo
  increment: string
}

interface World {
  desktop: TestCtx
  orchestrator: TestCtx
  worker: TestCtx
  run: SeededRun
  repos: Repo[]
}

function world(names: (string | null)[]): World {
  const built = names.map((name) => {
    const repo = createGitRepo()
    repos.push(repo)
    repo.branch(EPIC)
    return { name, repo, increment: repo.commit(`increment of ${name ?? 'root'}`) }
  })
  const gitFor = (repo: string | null) => createGitAdapter(((built.find((entry) => entry.name === repo) ?? built[0]) as Repo).repo.root)
  const desktop = createTestCtx({ role: 'desktop', gitFor, machineId: THIS_MACHINE, checkout: { branch: 'main', commit: null } })
  const run = seedRun(desktop, { bundle: makeBundle([[1, 2], [3]]) })
  const rejected = seedAttempt(desktop, run, { ticket: 1, state: 'rejected' })
  desktop.db.run(
    'UPDATE attempts SET decision_json = ? WHERE id = ?',
    JSON.stringify({ outcome: 'rejected', notes: '', reasons: ['Missing migration test'], decidedBy: 'reviewer' }),
    rejected
  )
  return { desktop, orchestrator: withRole(desktop, 'orchestrator'), worker: withRole(desktop, 'worker'), run, repos: built }
}

/** A learning card linked as DM-937 writes it, claimed, codified on its isolated branches, submitted and approved. */
async function approvedCard(w: World): Promise<{ packet: KanbanPacket; draftsHash: string; manifests: LearningBranchManifest[] }> {
  const card = createKanbanCard(w.desktop, { title: 'Sprint 1 learnings', acceptanceCriteria: ['Classified'] })
  const snapshot = collectLearningEvidence(w.desktop, { runId: w.run.runId, sprintId: sid(1) })
  const bases: SprintLearningCardView['bases'] = w.repos.map((entry) => ({ repo: entry.name, branch: EPIC, commit: entry.increment, attemptId: 'at_acceptance' }))
  w.desktop.db.run(
    `INSERT INTO sprint_learning_cards (card_id, epic_id, run_id, sprint_id, report_id, evidence_hash, created_at, checkpoint_id, revision_id, snapshot_json, bases_json)
     VALUES (?, ?, ?, ?, 'rp_report', ?, ?, 'ck_checkpoint', ?, ?, ?)`,
    card.id, w.run.epicId, w.run.runId, sid(1), snapshot.contentHash, w.desktop.clock.nowIso(), snapshot.revisionId, JSON.stringify(snapshot), JSON.stringify(bases)
  )
  playKanbanCard(w.desktop, { cardId: card.id })
  const packet = claimKanbanCard(w.orchestrator, { cardId: card.id })
  const manifests = (packet.learning?.branches ?? []).map((plan) => {
    const entry = w.repos.find((candidate) => candidate.name === plan.repo) as Repo
    entry.repo.git('branch', plan.branch, plan.base.commit)
    entry.repo.switchTo(plan.branch)
    const commit = entry.repo.commit(`guardrail for ${plan.repo ?? 'root'}`)
    entry.repo.switchTo(EPIC)
    return { repo: plan.repo, base: plan.base.commit, branch: plan.branch, commit }
  })
  const [first, ...rest] = packet.learning?.snapshot?.items ?? []
  const item = first as LearningEvidenceItem
  const learning = {
    dispositions: [
      { kind: item.kind, sourceId: item.sourceId, disposition: 'learning', reason: 'A reusable rule.' },
      ...rest.map((other) => ({ kind: other.kind, sourceId: other.sourceId, disposition: 'not_reusable', reason: 'One-off.' }))
    ],
    drafts: [
      {
        title: 'Run the migration tests',
        rule: 'Run the migration upgrade tests before submitting a schema change.',
        check: 'The attempt evidence lists the migration test run.',
        applicability: { roles: ['worker'], events: ['ticket.claimed'], paths: ['src/core/db/**'] },
        evidence: [{ kind: item.kind, sourceId: item.sourceId, contentHash: item.contentHash }],
        replaces: null
      }
    ],
    manifests
  }
  const input = COMMAND_SCHEMAS.submitKanbanCard.parse({ attemptId: packet.attemptId, claimToken: packet.claimToken, outputs: { summary: 'Codified.' }, learning })
  await kanbanCommands.submitKanbanCard.run({ ctx: () => w.worker } as never, input)
  approveKanbanCard(w.desktop, { cardId: packet.cardId })
  return { packet, draftsHash: getStagedLearningDrafts(w.desktop, { attemptId: packet.attemptId }).draftsHash, manifests }
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
  } catch (error: unknown) {
    if (error instanceof DomainError) return { code: error.code, message: error.message }
    throw error
  }
  return { code: 'ok', message: '' }
}

const integrations = (ctx: TestCtx) =>
  ctx.db.all<{ id: string; state: string; owner_machine_id: string | null; superseded_by: string | null; failure_json: string | null; revision: number }>(
    'SELECT id, state, owner_machine_id, superseded_by, failure_json, revision FROM learning_integrations ORDER BY created_at, id'
  )

const queued = (ctx: TestCtx): string[] =>
  ctx.db.all<{ entity_id: string }>("SELECT entity_id FROM outbox WHERE kind = 'learning_integration' AND state = 'pending' ORDER BY id").map((row) => row.entity_id)

/** Stores an integration of the card as an import does: no local owner, its targets' progress as another machine saw it. */
function importedIntegration(w: World, packet: KanbanPacket, draftsHash: string, owner: string | null = null): string {
  const id = 'li_0000000000000000000000ff01'
  const manifest: LearningIntegrationManifest = {
    formatVersion: 1,
    cardId: packet.cardId,
    attemptId: packet.attemptId,
    runId: w.run.runId,
    sprintId: sid(1),
    draftsHash,
    targets: w.repos.map((entry, index) => ({
      repository: entry.name,
      branch: EPIC,
      baseCommit: entry.increment,
      resultCommit: index === 0 ? 'e'.repeat(40) : null,
      state: index === 0 ? ('integrated' as const) : ('integrating' as const)
    }))
  }
  w.desktop.db.run(
    `INSERT INTO learning_integrations (id, card_id, attempt_id, state, manifest_json, manifest_hash, failure_json, revision, created_at, updated_at, owner_machine_id)
     VALUES (?, ?, ?, 'integrating', ?, ?, NULL, 4, '2025-12-31T00:00:00.000Z', '2025-12-31T00:00:00.000Z', ?)`,
    id, packet.cardId, packet.attemptId, JSON.stringify(manifest), contentHash(manifest), owner
  )
  return id
}

describe('preparing a learning integration', () => {
  it('stores a new integration owned by this machine, every target pending at its base, its export queued, and replays it', async () => {
    const w = world(['api', 'web'])
    const { packet, draftsHash } = await approvedCard(w)
    const prepared = await prepareLearningIntegration(w.desktop, { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash })
    expect(prepared).toMatchObject({ cardId: packet.cardId, attemptId: packet.attemptId, state: 'prepared', local: true, supersededBy: null })
    expect(prepared.manifest).toEqual({
      formatVersion: 1,
      cardId: packet.cardId,
      attemptId: packet.attemptId,
      runId: w.run.runId,
      sprintId: sid(1),
      draftsHash,
      targets: w.repos.map((entry) => ({ repository: entry.name, branch: EPIC, baseCommit: entry.increment, resultCommit: null, state: 'pending' }))
    })
    expect(prepared.manifestHash).toBe(contentHash(prepared.manifest))
    expect(integrations(w.desktop)).toEqual([expect.objectContaining({ id: prepared.id, owner_machine_id: THIS_MACHINE })])
    expect(queued(w.desktop)).toEqual([prepared.id])
    expect(requireLocalIntegrationAuthority(w.desktop, prepared.id)).toEqual(prepared)

    // A replay of the same approval, recover or not, returns the same integration and writes nothing.
    const before = { rows: integrations(w.desktop), outbox: queued(w.desktop) }
    expect(await prepareLearningIntegration(w.desktop, { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash })).toEqual(prepared)
    expect(await prepareLearningIntegration(w.desktop, { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash, recover: true })).toEqual(prepared)
    expect({ rows: integrations(w.desktop), outbox: queued(w.desktop) }).toEqual(before)
  })

  it('binds the exact approval: other drafts, an unapproved card and a manifest Git no longer proves are refused', async () => {
    const w = world([null])
    const { packet, draftsHash, manifests } = await approvedCard(w)
    const other = await refusal(prepareLearningIntegration(w.desktop, { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash: `sha256:${'0'.repeat(64)}` }))
    expect(other).toMatchObject({ code: 'conflict', message: expect.stringContaining('not the drafts that were approved') })
    const unapproved = await refusal(prepareLearningIntegration(w.desktop, { cardId: packet.cardId, attemptId: 'ka_000000000000000000000000zz', draftsHash }))
    expect(unapproved.code).toBe('not_found')
    // The isolated branch moved after verification: the guardrail commit is no longer its tip.
    const root = w.repos[0] as Repo
    root.repo.switchTo((manifests[0] as LearningBranchManifest).branch)
    root.repo.commit('later change')
    root.repo.switchTo(EPIC)
    const moved = await refusal(prepareLearningIntegration(w.desktop, { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash }))
    expect(moved).toMatchObject({ code: 'conflict', message: expect.stringContaining('no longer verify') })
    expect(integrations(w.desktop)).toEqual([])
    expect(queued(w.desktop)).toEqual([])
  })

  it.each(AGENT_ROLES)('refuses a %s session: only the person prepares an integration', async (role) => {
    const w = world([null])
    const { packet, draftsHash } = await approvedCard(w)
    const error = await refusal(prepareLearningIntegration(withRole(w.desktop, role), { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash, recover: true }))
    expect(error.code).toBe('unauthorized')
    expect(integrations(w.desktop)).toEqual([])
  })
})

describe('inert imported integrations', () => {
  it('never run: the executor guard refuses an imported, foreign or closed integration', async () => {
    const w = world(['api', 'web'])
    const { packet, draftsHash } = await approvedCard(w)
    const imported = importedIntegration(w, packet, draftsHash)
    expect(captureError(() => requireLocalIntegrationAuthority(w.desktop, imported))).toMatchObject({ code: 'approval_required' })
    w.desktop.db.run('UPDATE learning_integrations SET owner_machine_id = ? WHERE id = ?', OTHER_MACHINE, imported)
    expect(captureError(() => requireLocalIntegrationAuthority(w.desktop, imported))).toMatchObject({ code: 'approval_required' })
    // The same row owned here runs, until its stored manifest stops matching its hash or it closes.
    w.desktop.db.run('UPDATE learning_integrations SET owner_machine_id = ? WHERE id = ?', THIS_MACHINE, imported)
    expect(requireLocalIntegrationAuthority(w.desktop, imported).local).toBe(true)
    w.desktop.db.run("UPDATE learning_integrations SET manifest_hash = 'sha256:00' WHERE id = ?", imported)
    expect(captureError(() => requireLocalIntegrationAuthority(w.desktop, imported)).code).toBe('conflict')
    w.desktop.db.run("UPDATE learning_integrations SET state = 'aborted', failure_json = '{}' WHERE id = ?", imported)
    expect(captureError(() => requireLocalIntegrationAuthority(w.desktop, imported)).code).toBe('invalid_state')
    expect(captureError(() => requireLocalIntegrationAuthority(w.desktop, 'li_000000000000000000000000zz')).code).toBe('not_found')
  })
})

describe('recovering inert imported integrations', () => {
  it('are never adopted by an automatic replay of the approval or by any agent', async () => {
    const w = world(['api', 'web'])
    const { packet, draftsHash } = await approvedCard(w)
    importedIntegration(w, packet, draftsHash)
    const before = integrations(w.desktop)
    // An automatic replay of the approval (no explicit recovery) does not adopt or replace the imported integration.
    const automatic = await refusal(prepareLearningIntegration(w.desktop, { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash }))
    expect(automatic).toMatchObject({ code: 'approval_required', message: expect.stringContaining('inert') })
    for (const role of AGENT_ROLES) {
      const error = await refusal(prepareLearningIntegration(withRole(w.desktop, role), { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash, recover: true }))
      expect(error.code).toBe('unauthorized')
    }
    expect(integrations(w.desktop)).toEqual(before)
    expect(queued(w.desktop)).toEqual([])
  })

  it('are replaced by the person\'s explicit re-preparation with a fresh local integration, replay-safe', async () => {
    const w = world(['api', 'web'])
    const { packet, draftsHash } = await approvedCard(w)
    const imported = importedIntegration(w, packet, draftsHash)
    const fresh = await prepareLearningIntegration(w.desktop, { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash, recover: true })
    expect(fresh.id).not.toBe(imported)
    expect(fresh).toMatchObject({ state: 'prepared', local: true })
    // Nothing of the imported progress is carried over: every target starts again at its recorded base.
    expect(fresh.manifest.targets.map((target) => [target.state, target.resultCommit])).toEqual([['pending', null], ['pending', null]])
    expect(integrations(w.desktop)).toEqual([
      expect.objectContaining({ id: imported, state: 'aborted', owner_machine_id: null, superseded_by: fresh.id, revision: 5 }),
      expect.objectContaining({ id: fresh.id, state: 'prepared', owner_machine_id: THIS_MACHINE, superseded_by: null })
    ])
    expect(JSON.parse(integrations(w.desktop)[0]?.failure_json ?? '{}')).toMatchObject({ code: 'superseded_by_local_preparation' })
    expect(new Set(queued(w.desktop))).toEqual(new Set([imported, fresh.id]))
    expect(captureError(() => requireLocalIntegrationAuthority(w.desktop, imported)).code).toBe('invalid_state')
    expect(requireLocalIntegrationAuthority(w.desktop, fresh.id).id).toBe(fresh.id)

    // Replaying the recovery returns the fresh integration and writes nothing more.
    const after = integrations(w.desktop)
    expect(await prepareLearningIntegration(w.desktop, { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash, recover: true })).toEqual(fresh)
    expect(integrations(w.desktop)).toEqual(after)
  })

  it('re-preparation re-validates current local state: an inert integration of drafts that were not approved stays inert', async () => {
    const w = world([null])
    const { packet, draftsHash } = await approvedCard(w)
    const imported = importedIntegration(w, packet, draftsHash)
    const error = await refusal(
      prepareLearningIntegration(w.desktop, { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash: `sha256:${'1'.repeat(64)}`, recover: true })
    )
    expect(error.code).toBe('conflict')
    expect(integrations(w.desktop)).toEqual([expect.objectContaining({ id: imported, state: 'integrating', owner_machine_id: null, superseded_by: null })])
  })
})

describe('startup recovery enumeration', () => {
  it('lists only open integrations this machine prepared, for any session that reads', async () => {
    const w = world([null])
    const { packet, draftsHash } = await approvedCard(w)
    const imported = importedIntegration(w, packet, draftsHash)
    expect(listLocalPendingLearningIntegrations(w.desktop)).toEqual([])
    const fresh = await prepareLearningIntegration(w.desktop, { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash, recover: true })
    expect(listLocalPendingLearningIntegrations(w.desktop).map((entry) => entry.id)).toEqual([fresh.id])
    expect(listLocalPendingLearningIntegrations(withRole(w.desktop, 'reader')).map((entry) => entry.id)).toEqual([fresh.id])
    // Another machine sharing the records sees nothing to resume: the fresh integration is not its own.
    expect(listLocalPendingLearningIntegrations({ ...w.desktop, machineId: OTHER_MACHINE })).toEqual([])
    // A closed local integration is not pending.
    w.desktop.db.run("UPDATE learning_integrations SET state = 'published' WHERE id = ?", fresh.id)
    expect(listLocalPendingLearningIntegrations(w.desktop)).toEqual([])
    expect(integrations(w.desktop).map((row) => row.id)).toEqual([imported, fresh.id])
    expect(captureError(() => listLocalPendingLearningIntegrations(createTestCtx({ db: w.desktop.db, capabilities: [] }))).code).toBe('unauthorized')
  })
})
