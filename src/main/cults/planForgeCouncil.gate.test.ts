/**
 * The Plan Forge council's gate (`planForgeCouncil.ts`) over the real cult store, with the target read through a
 * stand-in workspace whose plan trace and validation each test sets: what a run without its binding, a save made
 * outside the run, and a synthesis asked of another archetype come to. The full flow is `planForgeCouncil.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../../core/db/database'
import type { PlanTrace } from '../../core/services/planTrace'
import { STANDARD_WORKER_TYPES } from '../../shared/cults/archetypes'
import type { CultInput, CultRunView } from '../../shared/cults/cult'
import { openAppDatabase } from '../desktop/appDatabase'
import { createCultStore, type CultStore } from './cultStore'
import { createPlanForgeCouncil, type PlanForgeCouncil } from './planForgeCouncil'

const FORGE: CultInput = {
  name: 'Forge', charter: 'Forge the plan.', scope: 'folder', folderPath: '/repo', archetype: 'plan_forge', targetEpicId: 'ep_target',
  magosName: 'Magos Ferrum', magosModelId: null, defaultTimeLimitMs: null
}
const MAGOS_GRANT = 'gr_magos'

interface Fixture {
  dir: string
  db: Db
  store: CultStore
  /** What the stand-in workspace's `cultPlanTrace` answers. */
  trace: PlanTrace
  council: PlanForgeCouncil
}

let f: Fixture

function councilOver(cults: Pick<CultStore, 'getCult'> & CultStore): PlanForgeCouncil {
  return createPlanForgeCouncil({
    cults,
    workspaceFor: () => ({
      call: async () => f.trace,
      validatePlan: async () => ({ valid: true, errors: [], warnings: [] })
    }) as never,
    grantIdsOf: (_run, chatId) => (chatId === 'mg' ? [MAGOS_GRANT] : [])
  })
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-forge-gate-'))
  const db = openAppDatabase(dir)
  const store = createCultStore({ db })
  f = { dir, db, store, trace: { savedRevision: 1, draftRevision: 2, eventSeq: 10, changes: [] }, council: null as never }
  f.council = councilOver(store)
})

afterEach(() => {
  f.db.close()
  rmSync(f.dir, { recursive: true, force: true })
})

/** A running run with its Magos `mg` and one tagged report per fixed type; bound unless `bound` is false. */
function forgeRun(cult: CultInput = FORGE, bound = true): CultRunView {
  const run = f.store.startRun(f.store.createCult(cult).id, { workDir: '/repo' })
  f.store.transitionRun(run.id, { type: 'started' })
  f.store.addMember(run.id, { chatId: 'mg', role: 'magos', displayName: 'Magos Ferrum' })
  if (bound) f.store.bindPlanTarget(run.id, { epicId: 'ep_target', savedRevision: 1, draftRevision: 2, eventSeq: 10 })
  for (const type of cult.archetype === 'plan_forge' ? STANDARD_WORKER_TYPES : []) {
    f.store.addMember(run.id, { chatId: `ch_${type}`, role: 'acolyte', displayName: `Acolyte ${type}`, slotId: type })
    f.store.submitReport(run.id, { memberChatId: `ch_${type}`, slotId: type, text: `Findings of ${type}.`, targetRevision: 'saved 1, draft 2' })
  }
  return f.store.getRun(run.id)!
}

describe('Plan Forge gate: the target as bound', () => {
  it('reads a governed run that was never bound as stale, and refuses its conclusion with target_stale', async () => {
    const run = forgeRun(FORGE, false)
    expect(await f.council.status(run)).toEqual({ state: 'stale', missingFixed: [], missingCreated: [] })
    await expect(f.council.assertConclusion(run)).rejects.toMatchObject({ code: 'target_stale' })
  })

  it('reads a saved revision that moved with no save request as stale, and one a Magos save request explains as not', async () => {
    const run = forgeRun()
    f.trace = { ...f.trace, savedRevision: 2 }
    expect((await f.council.status(run))?.state).toBe('stale')
    f.trace = { ...f.trace, changes: [{ kind: 'plan.save_requested', grantId: MAGOS_GRANT, draftRevision: null }] }
    expect((await f.council.status(run))?.state).toBe('resolving')
  })

  it('counts no roster when the run\'s cult is gone: no type is missing, and an unbound run is still stale', async () => {
    const run = forgeRun(FORGE, false)
    const council = councilOver({ ...f.store, getCult: () => null })
    await expect(council.assertConclusion(run)).rejects.toMatchObject({ code: 'target_stale' })
    expect(await council.status(run)).toBeNull()
  })
})

describe('Plan Forge gate: synthesis of another archetype', () => {
  it('refuses a synthesis for a run that is not a Plan Forge with invalid_state, recording nothing', () => {
    const run = forgeRun({ ...FORGE, archetype: 'general', targetEpicId: null }, false)
    const magos = f.store.listMembers(run.id)[0]!
    const args = { draftRevision: 1, recommendations: [{ workerType: 'security', recommendation: 'Hold.', decision: 'accepted' as const, reason: 'Sound.' }] }
    expect(() => f.council.recordSynthesis(run, magos, args)).toThrow(expect.objectContaining({ code: 'invalid_state' }))
    expect(f.store.latestSynthesis(run.id)).toBeNull()
  })
})
