/**
 * The cult dispatcher's own refusals and fallbacks (`cultCommands.ts`), over the real cult store on a real app database.
 * The supervisor is a small stand-in that resolves the caller from the store as the real one does from its live runs, so
 * a test can hold a caller whose run has just paused or ended; the pipe-level suite is `cultControl.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../../core/db/database'
import { DomainError } from '../../core/errors'
import type { NamingOperation } from '../../shared/agents/chatNaming'
import type { CultInput, CultMemberView, CultRunView } from '../../shared/cults/cult'
import type { NamingOperationContext } from '../naming/controlPipe'
import { openAppDatabase } from '../desktop/appDatabase'
import { createCultDispatcher, planTargetRevision, type CultCommandDeps } from './cultCommands'
import { createCultStore, type CultStore } from './cultStore'

const MIN = 60_000
const T0 = Date.parse('2026-03-01T00:00:00.000Z')
const WORK = '/work/order'

const GENERAL: CultInput = {
  name: 'Order of the Cog',
  charter: 'Polish the brass.',
  scope: 'sanctum',
  folderPath: null,
  archetype: 'general',
  magosName: 'Magos Vettius',
  magosModelId: null,
  defaultTimeLimitMs: 10 * MIN
}

interface Fixture {
  dir: string
  db: Db
  store: CultStore
  clock: { ms: number }
  /** Each `concludeMember` call, as `runId:chatId`. */
  concluded: string[]
}

let f: Fixture

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-cult-commands-'))
  const db = openAppDatabase(dir)
  const clock = { ms: T0 }
  f = { dir, db, store: createCultStore({ db, now: () => new Date(clock.ms).toISOString() }), clock, concluded: [] }
})

afterEach(() => {
  f.db.close()
  rmSync(f.dir, { recursive: true, force: true })
})

const isLive = (member: CultMemberView): boolean => member.state === 'joining' || member.state === 'active'

/** The caller as the supervisor resolves it: a live member of a run, with the run as the store holds it now. */
function supervisor(): CultCommandDeps['supervisor'] {
  const { store } = f
  return {
    memberOf: (chatId) => {
      for (const run of store.listRuns()) {
        const member = store.listMembers(run.id).find((candidate) => candidate.chatId === chatId && isLive(candidate))
        if (member !== undefined) return { run, member }
      }
      return null
    },
    summonAcolyte: () => Promise.reject(new Error('Not summoned here.')),
    dismissAcolyte: async (runId, chatId) => store.updateMember(runId, chatId, { state: 'dismissed' }),
    petition: (runId, input) => store.createPetition(runId, input),
    concludeRun: () => Promise.reject(new Error('The run must not be concluded.')),
    concludeMember: (runId, chatId) => {
      f.concluded.push(`${runId}:${chatId}`)
      return Promise.reject(new DomainError('not_found', `No live member ${chatId}.`))
    }
  }
}

function deps(overrides: Partial<CultCommandDeps> = {}): CultCommandDeps {
  return {
    supervisor: supervisor(), cults: f.store, models: async () => [],
    sendOrder: () => Promise.reject(new Error('No order is sent here.')),
    now: () => new Date(f.clock.ms).toISOString(),
    ...overrides
  }
}

function contextOf(chatId: string): NamingOperationContext {
  const signal = new AbortController().signal
  return {
    binding: { grantId: 'gr_1', folder: WORK, chatId, generation: 'g1', signal },
    signal, deadline: Number.MAX_SAFE_INTEGER, remainingMs: () => Number.MAX_SAFE_INTEGER, assertActive: () => {},
    publish: (publication) => publication()
  } as NamingOperationContext
}

async function send(chatId: string, op: string, args: object = {}, overrides: Partial<CultCommandDeps> = {}): Promise<unknown> {
  return createCultDispatcher(deps(overrides))({ op, args } as NamingOperation, contextOf(chatId))
}

/** A running run with its Magos `mg` and the named acolytes, each chat id `ac_<n>`. */
function running(acolytes: string[] = [], cult: CultInput = GENERAL): CultRunView {
  const run = f.store.startRun(f.store.createCult(cult).id, { workDir: WORK })
  f.store.transitionRun(run.id, { type: 'started' })
  f.store.addMember(run.id, { chatId: 'mg', role: 'magos', displayName: 'Magos Ferrum' })
  acolytes.forEach((displayName, index) => f.store.addMember(run.id, { chatId: `ac_${index + 1}`, role: 'acolyte', displayName }))
  return f.store.getRun(run.id)!
}

/** Lets `setImmediate` work queued by a reply run, and the promise chains it starts settle. */
async function drain(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('cult dispatcher: operations it does not serve', () => {
  it('refuses a non-cult operation, and a Shrine publish without the run Shrines, with operation_unavailable', async () => {
    running()
    await expect(send('mg', 'name_chat', { title: 'Renamed' })).rejects.toMatchObject({ code: 'operation_unavailable' })
    await expect(send('mg', 'cult_publish_shrine', { path: 'shrine.html' })).rejects.toMatchObject({ code: 'operation_unavailable' })
  })
})

describe('cult dispatcher: status fallbacks', () => {
  it('names the cult\'s Magos once the live Magos has left, and no one once the cult itself is gone', async () => {
    const run = running(['Acolyte Brass'])
    f.store.updateMember(run.id, 'mg', { state: 'concluded' })
    expect(await send('ac_1', 'cult_status')).toMatchObject({ name: 'Acolyte Brass', magosName: 'Magos Vettius', liveAcolytes: 1 })
    const orphaned = { ...f.store, getCult: () => null }
    expect(await send('ac_1', 'cult_status', {}, { cults: orphaned })).toMatchObject({ magosName: '' })
  })

  it('reads the wall clock without a run clock: a paused run reports the time it banked', async () => {
    const run = running()
    f.clock.ms += 4 * MIN
    f.store.transitionRun(run.id, { type: 'pause' })
    expect(await send('mg', 'cult_status', {}, { now: undefined })).toMatchObject({ state: 'paused', remainingMs: 6 * MIN })
  })
})

describe('cult dispatcher: dismissing and listing acolytes', () => {
  it('refuses to dismiss a name that is no live acolyte with not_found, and dismisses nobody', async () => {
    const run = running(['Acolyte Brass', 'Acolyte Gear'])
    f.store.updateMember(run.id, 'ac_2', { state: 'concluded' })
    for (const name of ['Acolyte Nobody', 'Acolyte Gear', 'Magos Ferrum'])
      await expect(send('mg', 'cult_dismiss_acolyte', { name }), name).rejects.toMatchObject({ code: 'not_found' })
    expect(f.store.listMembers(run.id).map((member) => member.state)).toEqual(['joining', 'joining', 'concluded'])
    expect(await send('mg', 'cult_dismiss_acolyte', { name: ' acolyte BRASS ' })).toEqual({ dismissed: 'Acolyte Brass' })
  })

  it('lists live acolytes first, then those that left, the most recent to leave first', async () => {
    const run = running(['Acolyte First', 'Acolyte Second', 'Acolyte Live', 'Acolyte Third'])
    for (const chatId of ['ac_2', 'ac_1', 'ac_4']) {
      f.clock.ms += MIN
      f.store.updateMember(run.id, chatId, { state: 'left' })
    }
    const listed = (await send('mg', 'cult_list_acolytes')) as { acolytes: { name: string; state: string }[] }
    expect(listed.acolytes.map((acolyte) => [acolyte.name, acolyte.state])).toEqual([
      ['Acolyte Live', 'joining'], ['Acolyte Third', 'left'], ['Acolyte First', 'left'], ['Acolyte Second', 'left']
    ])
  })
})

describe('cult dispatcher: petitions past the pipe schema', () => {
  it('refuses an acolytes petition without a count and a folder petition without a folder, recording neither', async () => {
    const run = running()
    await expect(send('mg', 'cult_petition', { kind: 'acolytes', reason: 'More hands.' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(send('mg', 'cult_petition', { kind: 'folder_access', reason: 'Read it.' })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.store.listPetitions(run.id)).toEqual([])
  })
})

describe('cult dispatcher: concluding while the run is paused or ended', () => {
  it('refuses to conclude a run that has ended with run_ending, keeping its chronicle unset', async () => {
    const run = running()
    f.store.transitionRun(run.id, { type: 'abort', reason: 'failed' })
    await expect(send('mg', 'cult_conclude_run', { chronicle: 'It is done.' })).rejects.toMatchObject({ code: 'run_ending' })
    expect(f.store.getRun(run.id)?.chronicle).toBeNull()
  })

  it('refuses an acolyte\'s conclusion while paused (run_paused) and once ended (run_ending), storing no report', async () => {
    const run = running(['Acolyte Brass'])
    f.store.transitionRun(run.id, { type: 'pause' })
    await expect(send('ac_1', 'cult_conclude_service', { report: 'Done.' })).rejects.toMatchObject({ code: 'run_paused' })
    f.store.transitionRun(run.id, { type: 'abort', reason: 'failed' })
    await expect(send('ac_1', 'cult_conclude_service', { report: 'Done.' })).rejects.toMatchObject({ code: 'run_ending' })
    await drain()
    expect(f.store.listReports(run.id)).toEqual([])
    expect(f.concluded).toEqual([])
  })

  it('concludes a free-form acolyte without a report, and tells a failed conclusion to onError only when given', async () => {
    const run = running(['Acolyte Brass'])
    expect(await send('ac_1', 'cult_conclude_service', { report: 'Done.' })).toEqual({ concluding: 'service', reportStored: false })
    await drain()
    expect(f.concluded).toEqual([`${run.id}:ac_1`])
    const errors: unknown[] = []
    await send('ac_1', 'cult_conclude_service', { report: 'Done.' }, { onError: (error) => errors.push(error) })
    await drain()
    expect(errors).toEqual([expect.objectContaining({ code: 'not_found' })])
    expect(f.store.listReports(run.id)).toEqual([])
  })
})

describe('cult dispatcher: the target revision a specialist saw', () => {
  it('counts a target with no saved revision and no open draft as revision 0 of each', async () => {
    const forge: CultInput = { ...GENERAL, scope: 'folder', folderPath: WORK, archetype: 'plan_forge', targetEpicId: 'ep_target' }
    const run = running([], forge)
    const asked: string[] = []
    const revision = planTargetRevision(f.store, async (folder, epicId) => {
      asked.push(`${folder}:${epicId}`)
      return { currentRevisionNumber: null, draftRevision: null }
    })
    expect(await revision(run)).toBe('saved 0, draft 0')
    expect(asked).toEqual([`${WORK}:ep_target`])
  })
})
