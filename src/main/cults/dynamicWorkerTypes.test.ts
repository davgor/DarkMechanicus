/**
 * Run-scoped worker types (DM-739) through the real control pipe and desktop client, over real supervised runs on the
 * cult rig (`__mocks__/cultRig.ts`): the cult store on a real app database, real workspaces and grants, fake PTYs and
 * a fake run clock. Each caller holds the grant its member's launch bound; main derives its run and role from it alone.
 */
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDesktopClient } from '../../core/desktop/desktopClient'
import type { NamingOperation, NamingReply } from '../../shared/agents/chatNaming'
import { MAX_DYNAMIC_WORKER_TYPES, STANDARD_WORKER_TYPES } from '../../shared/cults/archetypes'
import type { CultInput, CultMemberView, CultRunView } from '../../shared/cults/cult'
import { createControlPipe, type ControlPipe } from '../naming/controlPipe'
import { eventually, FakeClock, settle } from '../terminals/__mocks__/terminalSessionsRig'
import { cultHarness, disposeCultHarness, folderCultInput, ptyOf, type CultHarness } from './__mocks__/cultRig'
import { createCultDispatcher, planTargetRevision } from './cultCommands'
import { cultControlPath } from './cultControl'
import { createCultLedger } from './cultLedger'
import { createCultSupervisor, type CultSupervisor } from './cultSupervisor'
import { cheapest, parseOmpModels } from './ompModels'

const MODELS = parseOmpModels(readFileSync(new URL('./__fixtures__/omp-models.json', import.meta.url), 'utf8'), ['anthropic'])!
const CHEAPEST = cheapest(MODELS)!
const PRICIER = MODELS.find((model) => model.tier !== CHEAPEST.tier)!
const BASE = Date.parse('2026-11-26T09:00:00.000Z')

interface Fixture {
  h: CultHarness
  clock: FakeClock
  supervisor: CultSupervisor
  pipe: ControlPipe
}

let f: Fixture

const runTime = (clock: FakeClock) => () => new Date(BASE + clock.now).toISOString()

function supervisorOver(h: CultHarness, clock: FakeClock): CultSupervisor {
  return createCultSupervisor({
    cults: h.cults, launcher: h.launcher, control: h.control, ledger: createCultLedger({ userData: h.rig.userData }),
    terminals: {
      isRunning: (chatId) => h.rig.sessions.isRunning(chatId),
      attachGrant: (chatId, grantId) => h.rig.sessions.attachGrant(chatId, grantId),
      detachGrant: (chatId, grantId) => h.rig.sessions.detachGrant(chatId, grantId),
      onExit: (listener) => h.rig.sessions.onExit(listener)
    },
    grants: h.grants, chatStore: h.rig.store,
    revokeGrantIn: async (folder, grantId) => {
      await h.pool.get(folder).revokeGrant({ grantId })
    },
    folders: { resolve: (path) => (h.rig.tracked.has(path) ? path : null) },
    leftovers: { commandLine: async () => null, killTree: async () => {} },
    userData: h.rig.userData,
    clock: { now: runTime(clock), after: (callback, ms) => clock.after(callback, ms) },
    onError: () => {}
  })
}

beforeEach(async () => {
  const clock = new FakeClock()
  const h = await cultHarness({ now: runTime(clock), exitOnKill: true })
  const supervisor = supervisorOver(h, clock)
  // The dispatcher main builds (`startCults` in `bootstrap.ts`), with the rig's Plan Forge council.
  const dispatch = createCultDispatcher({
    supervisor, cults: h.cults, council: h.council, models: async () => MODELS,
    sendOrder: (order) => h.pool.get(order.folder).call('sendCultOrder', order),
    targetRevision: planTargetRevision(h.cults, (folder, epicId) => h.pool.get(folder).getEpic({ epicId })),
    now: runTime(clock)
  })
  const pipe = await createControlPipe({ authorize: (token) => h.grants.authorizeNaming(token), dispatch })
  f = { h, clock, supervisor, pipe }
})

afterEach(async () => {
  await f.pipe.close()
  await f.supervisor.dispose()
  await settle()
  await disposeCultHarness(f.h)
})

type Member = Pick<CultMemberView, 'chatId'>

const tokenOf = (member: Member): string => ptyOf(f.h, member).spec.env['DM_SESSION_TOKEN']!

function call(member: Member | string, op: string, args: object = {}): Promise<NamingReply> {
  const token = typeof member === 'string' ? member : tokenOf(member)
  return createDesktopClient({ env: { DM_DESKTOP_PIPE: f.pipe.address, DM_SESSION_TOKEN: token } }).request({ op, args } as NamingOperation)
}

async function data<T = Record<string, unknown>>(reply: Promise<NamingReply>): Promise<T> {
  const settled = await reply
  if (!settled.ok) throw new Error(`Refused with ${settled.error.code}.`)
  return settled.data as T
}

const refusal = (code: string, details?: object) => ({ ok: false, error: { code, ...(details === undefined ? {} : { details }) } })

async function startRun(overrides: Partial<CultInput> = {}) {
  const cult = f.h.cults.createCult(folderCultInput(f.h, overrides))
  const { run, members } = await f.supervisor.start(cult.id)
  return { cultId: cult.id, run, magos: members[0]! }
}

const memberNamed = (runId: string, name: string): CultMemberView => f.h.cults.listMembers(runId).find((member) => member.displayName === name)!

const TYPE = { displayName: 'Archivist', description: 'Keeps the records.', mission: 'Catalogue every finding.', rationale: 'The roster has no record keeper.', requiredForConclusion: false }

const create = (magos: Member, over: object = {}) => call(magos, 'cult_create_worker_type', { ...TYPE, ...over })

async function seat(run: CultRunView, magos: Member, name: string, seat: object = {}): Promise<CultMemberView> {
  await data(call(magos, 'cult_summon_acolyte', { name, mission: 'Do the work.', ...seat }))
  return memberNamed(run.id, name)
}

function actionsOf(member: Member): string[] {
  const path = cultControlPath(f.h.rig.userData, member.chatId)
  if (!existsSync(path)) return []
  return (JSON.parse(readFileSync(path, 'utf8')) as { actions: { action: string }[] }).actions.map((entry) => entry.action)
}

const eventKinds = (runId: string) => f.h.cults.pageEvents(runId).events.map((event) => event.kind)

interface Listed { workerTypes: { workerTypeId: string; displayName: string; state: string; requiredForConclusion: boolean; holders: string[] }[]; limit: number }

/** What an acolyte holds beyond its contract: its chat's role, Save right, model and folder, and its grant. */
async function authorityOf(run: CultRunView, member: CultMemberView) {
  const chat = f.h.rig.store.getChat({ folder: run.workDir, id: member.chatId })!
  const grants = (await f.h.pool.get(run.workDir).listGrants()).filter((grant) => chat.grantIds?.includes(grant.id))
  return {
    chat: { role: chat.role, allowSave: chat.allowSave, model: chat.model, folder: chat.folder, agent: chat.agent },
    grants: grants.map((grant) => ({ role: grant.role, allowSave: grant.allowSave, active: grant.active })),
    member: { tier: member.tier, tierReason: member.tierReason, model: member.model }
  }
}

describe('dynamic worker types: create, list and inject (c1)', () => {
  it('creates a type with a generated id, lists it with its contract, injects it by id and records every change as an event', async () => {
    const { run, magos } = await startRun()
    expect(await data(create(magos))).toEqual({ workerTypeId: 'dyn_1', displayName: 'Archivist', requiredForConclusion: false })
    expect(f.h.cults.listWorkerTypes(run.id)).toEqual([expect.objectContaining({
      id: 'dyn_1', ...TYPE, creatorMemberId: magos.chatId, retiredAt: null
    })])
    const keeper = await seat(run, magos, 'Acolyte Keeper', { workerTypeId: 'dyn_1' })
    expect(keeper).toMatchObject({ runWorkerTypeId: 'dyn_1', slotId: null, workerType: null })
    // The contract is resolved in main: the stored mission rides into the acolyte's first prompt.
    expect((ptyOf(f.h, keeper).spec.args as string[]).at(-1)).toContain('Catalogue every finding.')
    expect(await data<{ workerType: string }>(call(keeper, 'cult_status'))).toMatchObject({ role: 'acolyte', workerType: 'dyn_1', slotId: null })

    const listed = await data<Listed>(call(magos, 'cult_list_worker_types'))
    expect(listed).toEqual({
      limit: MAX_DYNAMIC_WORKER_TYPES,
      workerTypes: [{ workerTypeId: 'dyn_1', ...TYPE, state: 'active', holders: ['Acolyte Keeper'] }]
    })
    const events = f.h.cults.pageEvents(run.id).events.filter((event) => event.kind.startsWith('worker_type_'))
    expect(events.map((event) => [event.kind, event.memberName, event.summary])).toEqual([
      ['worker_type_created', 'Magos Ferrum', 'Magos Ferrum created worker type Archivist.'],
      ['worker_type_assigned', 'Acolyte Keeper', 'Acolyte Keeper holds Archivist.']
    ])
  })

  it('retires an optional unassigned type with its reason as an event, after which it is listed retired and cannot be summoned', async () => {
    const { run, magos } = await startRun()
    await data(create(magos))
    expect(await data(call(magos, 'cult_retire_worker_type', { workerTypeId: 'dyn_1', reason: 'The charter changed.' }))).toEqual({ retired: 'dyn_1' })
    expect(f.h.cults.pageEvents(run.id).events.at(-1)).toMatchObject({
      kind: 'worker_type_retired', memberName: 'Magos Ferrum', summary: 'Magos Ferrum retired worker type Archivist: The charter changed.'
    })
    expect((await data<Listed>(call(magos, 'cult_list_worker_types'))).workerTypes).toEqual([expect.objectContaining({ workerTypeId: 'dyn_1', state: 'retired', holders: [] })])
    expect(await call(magos, 'cult_summon_acolyte', { mission: 'Do it.', workerTypeId: 'dyn_1' })).toMatchObject(refusal('worker_type_unknown'))
    expect(await call(magos, 'cult_retire_worker_type', { workerTypeId: 'dyn_1', reason: 'Again.' })).toMatchObject(refusal('invalid_state'))
    expect(await call(magos, 'cult_retire_worker_type', { workerTypeId: 'dyn_7', reason: 'Never made.' })).toMatchObject(refusal('worker_type_unknown'))
    // The id is never handed out again in the run.
    expect(await data(create(magos, { displayName: 'Scribe' }))).toMatchObject({ workerTypeId: 'dyn_2' })
    expect(f.h.cults.listMembers(run.id)).toHaveLength(1)
  })
})

describe('dynamic worker types: boundaries (c2)', () => {
  it.each<[string, string]>([
    ...STANDARD_WORKER_TYPES.map((id): [string, string] => [id, id]),
    ['a built-in display name in other case and spacing', '  SECURITY '],
    ['a built-in display name with its punctuation', 'ui/ux'],
    ['the custom type', 'Custom']
  ])('refuses a name that shadows a built-in: %s', async (_label, displayName) => {
    const { run, magos } = await startRun()
    expect(await create(magos, { displayName })).toMatchObject(refusal('worker_type_name_taken'))
    expect(f.h.cults.listWorkerTypes(run.id)).toEqual([])
  })

  it('refuses a duplicate after normalization, and a retired name stays taken', async () => {
    const { run, magos } = await startRun()
    await data(create(magos))
    expect(await create(magos, { displayName: '  ARCHIVIST ' })).toMatchObject(refusal('worker_type_name_taken'))
    await data(call(magos, 'cult_retire_worker_type', { workerTypeId: 'dyn_1', reason: 'Unused.' }))
    expect(await create(magos, { displayName: 'archivist' })).toMatchObject(refusal('worker_type_name_taken'))
    expect(f.h.cults.listWorkerTypes(run.id).map((type) => type.id)).toEqual(['dyn_1'])
  })

  it('refuses blank, multi-line and oversized fields before main sees them', async () => {
    const { run, magos } = await startRun()
    for (const over of [
      { displayName: 'x'.repeat(81) }, { description: 'x'.repeat(501) }, { mission: 'x'.repeat(2001) }, { rationale: 'x'.repeat(1001) },
      { rationale: '   ' }, { displayName: 'Two\nlines' }, { requiredForConclusion: 'yes' }, { grants: ['planner'] }, { model: PRICIER.id }
    ]) expect(await create(magos, over), JSON.stringify(over).slice(0, 40)).toMatchObject(refusal('invalid_request'))
    expect(f.h.cults.listWorkerTypes(run.id)).toEqual([])
  })

  it(`creates at most ${MAX_DYNAMIC_WORKER_TYPES} types in a run, retired ones included`, async () => {
    const { run, magos } = await startRun()
    for (let n = 1; n <= MAX_DYNAMIC_WORKER_TYPES; n++) await data(create(magos, { displayName: `Specialist ${n}` }))
    await data(call(magos, 'cult_retire_worker_type', { workerTypeId: 'dyn_3', reason: 'Unused.' }))
    expect(await create(magos, { displayName: 'One too many' })).toMatchObject(refusal('worker_type_limit'))
    expect(f.h.cults.listWorkerTypes(run.id)).toHaveLength(MAX_DYNAMIC_WORKER_TYPES)
    expect(eventKinds(run.id).filter((kind) => kind === 'worker_type_created')).toHaveLength(MAX_DYNAMIC_WORKER_TYPES)
  })
})

describe('dynamic worker types: no authority, model or lifetime beyond the run (c2)', () => {
  it('gives an acolyte of a created type exactly the grant, Save right, folder, model default and tier of an ordinary acolyte', async () => {
    const { run, magos } = await startRun()
    await data(create(magos, { requiredForConclusion: true }))
    const plain = await seat(run, magos, 'Acolyte Plain')
    const typed = await seat(run, magos, 'Acolyte Typed', { workerTypeId: 'dyn_1' })
    const plainAuthority = await authorityOf(run, plain)
    expect(plainAuthority).toEqual({
      chat: { role: 'worker', allowSave: false, model: CHEAPEST.id, folder: run.workDir, agent: 'omp' },
      grants: [{ role: 'worker', allowSave: false, active: true }],
      member: { tier: CHEAPEST.tier, tierReason: null, model: CHEAPEST.id }
    })
    expect(await authorityOf(run, typed)).toEqual(plainAuthority)
    // A higher tier needs the same reason with or without a created type.
    expect(await call(magos, 'cult_summon_acolyte', { mission: 'Go.', workerTypeId: 'dyn_1', model: PRICIER.id })).toMatchObject(refusal('tier_reason_required'))
  })

  it('refuses a created-type summon at the cap like any other, and its petitions stay the Magos\'s', async () => {
    const { run, magos } = await startRun({ defaultCap: 1 })
    await data(create(magos))
    const keeper = await seat(run, magos, 'Acolyte Keeper', { workerTypeId: 'dyn_1' })
    expect(await call(magos, 'cult_summon_acolyte', { mission: 'Go.', workerTypeId: 'dyn_1' })).toMatchObject(refusal('cap_reached'))
    expect(await call(magos, 'cult_summon_acolyte', { mission: 'Go.' })).toMatchObject(refusal('cap_reached'))
    expect(await call(keeper, 'cult_petition', { kind: 'acolytes', additional: 2, reason: 'More.' })).toMatchObject(refusal('unauthorized'))
    expect(await call(keeper, 'cult_petition', { kind: 'allow_save', reason: 'Save.' })).toMatchObject(refusal('unauthorized'))
    expect(await data(call(magos, 'cult_petition', { kind: 'acolytes', additional: 1, reason: 'A second keeper.' }))).toMatchObject({ kind: 'acolytes', state: 'pending' })
    expect(f.h.cults.listMembers(run.id).filter((member) => member.role === 'acolyte')).toHaveLength(1)
  })
})

describe('dynamic worker types: run scope and run state (c2)', () => {
  it('belongs to its run only: a new run of the same cult starts without it, and the cult definition never gains it', async () => {
    const { cultId, run, magos } = await startRun()
    const slots = f.h.cults.getCult(cultId)!.slots
    await data(create(magos))
    await f.supervisor.killNow(run.id)
    await eventually(() => f.h.cults.getRun(run.id)!.state === 'ended', 'the first run to end')
    expect(f.h.cults.getCult(cultId)!.slots).toEqual(slots)

    const next = await f.supervisor.start(cultId)
    const nextMagos = next.members[0]!
    expect(await data<Listed>(call(nextMagos, 'cult_list_worker_types'))).toEqual({ workerTypes: [], limit: MAX_DYNAMIC_WORKER_TYPES })
    expect(await call(nextMagos, 'cult_summon_acolyte', { mission: 'Go.', workerTypeId: 'dyn_1' })).toMatchObject(refusal('worker_type_unknown'))
    // Its id starts over in the new run; the ended run keeps its type in history.
    expect(await data(create(nextMagos))).toMatchObject({ workerTypeId: 'dyn_1' })
    expect(f.h.cults.listWorkerTypes(run.id)).toHaveLength(1)
  })

  it('changes nothing while the run is paused, and lists without changing', async () => {
    const { run, magos } = await startRun()
    await data(create(magos))
    await f.supervisor.pause(run.id)
    expect(await create(magos, { displayName: 'Scribe' })).toMatchObject(refusal('run_paused'))
    expect(await call(magos, 'cult_retire_worker_type', { workerTypeId: 'dyn_1', reason: 'Paused.' })).toMatchObject(refusal('run_paused'))
    expect((await data<Listed>(call(magos, 'cult_list_worker_types'))).workerTypes).toHaveLength(1)
    await f.supervisor.resume(run.id)
    await f.supervisor.stop(run.id)
    expect(await create(magos, { displayName: 'Scribe' })).toMatchObject(refusal('run_ending'))
    expect(f.h.cults.listWorkerTypes(run.id)).toHaveLength(1)
  })
})

describe('dynamic worker types: retirement and conclusion (c3)', () => {
  it('never retires a required type, nor an optional one once an acolyte has held it, even after it left', async () => {
    const { run, magos } = await startRun()
    await data(create(magos, { displayName: 'Gatekeeper', requiredForConclusion: true }))
    await data(create(magos))
    expect(await call(magos, 'cult_retire_worker_type', { workerTypeId: 'dyn_1', reason: 'Try.' })).toMatchObject(refusal('worker_type_required'))
    const keeper = await seat(run, magos, 'Acolyte Keeper', { workerTypeId: 'dyn_2' })
    expect(await call(magos, 'cult_retire_worker_type', { workerTypeId: 'dyn_2', reason: 'Try.' })).toMatchObject(refusal('worker_type_assigned'))
    const dismissing = call(magos, 'cult_dismiss_acolyte', { name: keeper.displayName })
    await eventually(() => actionsOf(keeper).includes('shutdown'), 'the dismissal')
    ptyOf(f.h, keeper).exit()
    expect(await data(dismissing)).toEqual({ dismissed: 'Acolyte Keeper' })
    expect(memberNamed(run.id, 'Acolyte Keeper').state).toBe('dismissed')
    expect(await call(magos, 'cult_retire_worker_type', { workerTypeId: 'dyn_2', reason: 'Try.' })).toMatchObject(refusal('worker_type_assigned'))
    expect(f.h.cults.listWorkerTypes(run.id).every((type) => type.retiredAt === null)).toBe(true)
    expect(eventKinds(run.id)).not.toContain('worker_type_retired')
  })

  it('blocks a Plan Forge conclusion until the acolyte of a required created type reports', async () => {
    const epic = await f.h.pool.get(f.h.rig.repo).createEpic({ title: 'Target plan' })
    const { run, magos } = await startRun({ archetype: 'plan_forge', targetEpicId: epic.id, defaultCap: 8 })
    for (const slotId of STANDARD_WORKER_TYPES) {
      f.h.cults.addMember(run.id, { chatId: `ch_${slotId}`, role: 'acolyte', displayName: `Acolyte ${slotId}`, slotId })
      f.h.cults.submitReport(run.id, { memberChatId: `ch_${slotId}`, slotId, text: `Findings of ${slotId}.`, targetRevision: 'saved 0, draft 1' })
    }
    expect(await data(create(magos, { displayName: 'Gatekeeper', requiredForConclusion: true }))).toMatchObject({ workerTypeId: 'dyn_1' })
    expect(await call(magos, 'cult_conclude_run', { chronicle: 'Done.' })).toMatchObject(refusal('reports_missing', { missingFixed: [], missingCreated: ['dyn_1'] }))
    const gatekeeper = await seat(run, magos, 'Acolyte Gatekeeper', { workerTypeId: 'dyn_1' })
    expect(await call(magos, 'cult_conclude_run', { chronicle: 'Done.' })).toMatchObject(refusal('reports_missing', { missingCreated: ['dyn_1'] }))
    expect(await call(magos, 'cult_retire_worker_type', { workerTypeId: 'dyn_1', reason: 'Skip it.' })).toMatchObject(refusal('worker_type_required'))

    expect(await data(call(gatekeeper, 'cult_conclude_service', { report: 'The gate holds.' }))).toEqual({ concluding: 'service', reportStored: true })
    expect(f.h.cults.listReports(run.id).find((report) => report.runWorkerTypeId === 'dyn_1')).toMatchObject({ memberChatId: gatekeeper.chatId, text: 'The gate holds.' })
    expect(await data<{ planForge: unknown }>(call(magos, 'cult_status'))).toMatchObject({ planForge: { missingFixed: [], missingCreated: [] } })
    // Coverage is complete; the next gate is the synthesis, not the created type.
    expect(await call(magos, 'cult_conclude_run', { chronicle: 'Done.' })).toMatchObject(refusal('synthesis_missing'))
  })
})

describe('dynamic worker types: authority (c4)', () => {
  const OPS: [string, object][] = [
    ['cult_create_worker_type', TYPE],
    ['cult_list_worker_types', {}],
    ['cult_retire_worker_type', { workerTypeId: 'dyn_1', reason: 'Mine now.' }]
  ]

  it('refuses every worker type command to an acolyte, including one holding a created type', async () => {
    const { run, magos } = await startRun()
    await data(create(magos))
    const keeper = await seat(run, magos, 'Acolyte Keeper', { workerTypeId: 'dyn_1' })
    const plain = await seat(run, magos, 'Acolyte Plain')
    for (const acolyte of [keeper, plain]) {
      for (const [op, args] of OPS) expect(await call(acolyte, op, args), op).toMatchObject(refusal('unauthorized'))
      expect(await call(acolyte, 'cult_summon_acolyte', { mission: 'Go.', workerTypeId: 'dyn_1' })).toMatchObject(refusal('unauthorized'))
    }
    expect(f.h.cults.listWorkerTypes(run.id)).toEqual([expect.objectContaining({ id: 'dyn_1', retiredAt: null })])
  })

  it('refuses a nonmember chat, a token no live grant holds and the Magos of another run', async () => {
    const { run, magos } = await startRun()
    await data(create(magos))
    const outsider = await f.h.grants.issueChatCli(run.workDir, { role: 'orchestrator', allowSave: false, label: 'Outsider' })
    await f.h.grants.bindChatGrant(outsider.grantId, { folder: run.workDir, chatId: 'ch_outsider', generation: 'outsider-1' })
    const token = outsider.cli.env['DM_SESSION_TOKEN']!
    for (const [op, args] of OPS) {
      expect(await call(token, op, args), op).toMatchObject(refusal('unauthorized'))
      expect(await call('dmg_foreign_token', op, args), op).toMatchObject(refusal('unauthorized'))
    }
    // Another run's Magos acts on its own run only: our dyn_1 is not its to retire or summon.
    const other = await startRun({ name: 'Order of the Gear', magosName: 'Magos Ostra' })
    expect(await call(other.magos, 'cult_retire_worker_type', { workerTypeId: 'dyn_1', reason: 'Not mine.' })).toMatchObject(refusal('worker_type_unknown'))
    expect(await call(other.magos, 'cult_summon_acolyte', { mission: 'Go.', workerTypeId: 'dyn_1' })).toMatchObject(refusal('worker_type_unknown'))
    expect(f.h.cults.listWorkerTypes(run.id)).toEqual([expect.objectContaining({ id: 'dyn_1', retiredAt: null })])
    expect(f.h.cults.listMembers(other.run.id)).toHaveLength(1)
  })
})
