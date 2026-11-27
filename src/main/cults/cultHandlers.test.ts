/**
 * The `cults:*` IPC over the real pieces (`__mocks__/cultRig.ts`): each call goes through the registered channel, the
 * handlers validate it and drive the real supervisor, store and launcher, and every run change reaches the windows as a
 * `cults:event` snapshot. Magos commands go through the real control pipe, as a member's `dm` sends them.
 */
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDesktopClient } from '../../core/desktop/desktopClient'
import type { NamingOperation, NamingReply } from '../../shared/agents/chatNaming'
import { CULT_ARCHETYPES, STANDARD_WORKER_TYPES } from '../../shared/cults/archetypes'
import type { CultView } from '../../shared/cults/cult'
import { CULT_EVENT_CHANNEL, type CultPushEvent, type CultRunDetail } from '../../shared/cults/cultApi'
import type { CommandResult } from '../../shared/desktop/api'
import { createControlPipe, type ControlPipe } from '../naming/controlPipe'
import { eventually, FakeClock, settle } from '../terminals/__mocks__/terminalSessionsRig'
import { backstopMs } from '../../shared/cults/runState'
import { cultHarness, disposeCultHarness, folderCultInput, ptyOf, type CultHarness } from './__mocks__/cultRig'
import { createCultDispatcher, planTargetRevision } from './cultCommands'
import { cultControlPath } from './cultControl'
import { announcingDispatcher, createCultHandlers, forwardCultEvents, registerCultIpc } from './cultHandlers'
import { createCultLedger } from './cultLedger'
import { createCultSupervisor, type CultSupervisor } from './cultSupervisor'
import { parseOmpModels } from './ompModels'

const MODELS = parseOmpModels(readFileSync(new URL('./__fixtures__/omp-models.json', import.meta.url), 'utf8'), ['anthropic'])!
const BASE = Date.parse('2026-11-26T09:00:00.000Z')
const CHANNELS = ['list', 'get', 'create', 'update', 'delete', 'models', 'archetypes', 'start', 'pause', 'resume', 'stop', 'killNow',
  'raiseCap', 'decidePetition', 'dismissAcolyte', 'runs', 'pipeline']

interface Fixture {
  h: CultHarness
  supervisor: CultSupervisor
  /** Run time: a graceful stop ends only once it has moved past the backstop. */
  clock: FakeClock
  pipe: ControlPipe
  channels: Map<string, (event: unknown, ...args: unknown[]) => unknown>
  /** Every `cults:event` the window received. */
  pushed: CultPushEvent[]
  stopForwarding: () => void
  /** Whether the supervisor hears member exits: off, a relaunch looks to it like the same member launching again. */
  hearing: { exits: boolean }
}

let f: Fixture

function supervisorOver(h: CultHarness, clock: FakeClock, hearing: Fixture['hearing']): CultSupervisor {
  return createCultSupervisor({
    cults: h.cults, launcher: h.launcher, control: h.control, ledger: createCultLedger({ userData: h.rig.userData }),
    terminals: {
      isRunning: (chatId) => h.rig.sessions.isRunning(chatId),
      attachGrant: (chatId, grantId) => h.rig.sessions.attachGrant(chatId, grantId),
      detachGrant: (chatId, grantId) => h.rig.sessions.detachGrant(chatId, grantId),
      onExit: (listener) => h.rig.sessions.onExit((chatId) => hearing.exits && listener(chatId)),
      onLaunch: (listener) => h.rig.sessions.onLaunch(listener)
    },
    grants: h.grants, chatStore: h.rig.store,
    revokeGrantIn: async (folder, grantId) => {
      await h.pool.get(folder).revokeGrant({ grantId })
    },
    folders: { resolve: (path) => (h.rig.tracked.has(path) ? path : null) },
    leftovers: { commandLine: async () => null, killTree: async () => {} },
    userData: h.rig.userData,
    clock: { now: () => new Date(BASE + clock.now).toISOString(), after: (callback, ms) => clock.after(callback, ms) },
    onError: () => {}
  })
}

beforeEach(async () => {
  const clock = new FakeClock()
  const h = await cultHarness({ now: () => new Date(BASE + clock.now).toISOString(), exitOnKill: true })
  const hearing = { exits: true }
  const supervisor = supervisorOver(h, clock, hearing)
  const dispatch = announcingDispatcher(createCultDispatcher({
    supervisor, cults: h.cults, council: h.council, models: async () => MODELS,
    sendOrder: (order) => h.pool.get(order.folder).call('sendCultOrder', order),
    targetRevision: planTargetRevision(h.cults, (folder, epicId) => h.pool.get(folder).getEpic({ epicId }))
  }), supervisor)
  const pipe = await createControlPipe({ authorize: (token) => h.grants.authorizeNaming(token), dispatch })
  const services = {
    cults: h.cults, supervisor, launcher: h.launcher,
    models: { list: async () => ({ options: MODELS, reason: null }), refresh: async () => ({ options: MODELS.slice(0, 1), reason: null }) },
    // The Folders registry alone: never a sanctum.
    folders: { resolve: (path: string) => (h.rig.tracked.has(path) ? path : null) },
    epicIn: (folder: string, epicId: string) => h.pool.get(folder).getEpic({ epicId })
  }
  const channels: Fixture['channels'] = new Map()
  registerCultIpc({ handle: (channel, listener) => void channels.set(channel, listener as never) }, createCultHandlers(services))
  const pushed: CultPushEvent[] = []
  const window = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (channel: string, event: unknown) => channel === CULT_EVENT_CHANNEL && pushed.push(event as CultPushEvent) }
  }
  f = { h, supervisor, clock, pipe, channels, pushed, hearing, stopForwarding: forwardCultEvents(services, () => [window]) }
})

afterEach(async () => {
  f.stopForwarding()
  await f.pipe.close()
  await f.supervisor.dispose()
  await settle()
  await disposeCultHarness(f.h)
})

/** One request through its registered `cults:*` channel, as the preload sends it. */
async function invoke<T>(method: string, ...args: unknown[]): Promise<CommandResult<T>> {
  const listener = f.channels.get(`cults:${method}`)
  if (listener === undefined) throw new Error(`cults:${method} is not registered.`)
  return (await listener({}, ...args)) as CommandResult<T>
}

async function data<T>(reply: Promise<CommandResult<T>>): Promise<T> {
  const settled = await reply
  if (!settled.ok) throw new Error(`Refused with ${settled.error.code}: ${settled.error.message}`)
  return settled.data
}

const refused = (code: string) => ({ ok: false, error: expect.objectContaining({ code }) })

/** A Magos command through the control pipe, with the member's own launch token. */
async function command<T = Record<string, unknown>>(member: { chatId: string }, op: string, args: object = {}): Promise<T> {
  const token = ptyOf(f.h, member).spec.env['DM_SESSION_TOKEN']!
  const reply: NamingReply = await createDesktopClient({ env: { DM_DESKTOP_PIPE: f.pipe.address, DM_SESSION_TOKEN: token } }).request({ op, args } as NamingOperation)
  if (!reply.ok) throw new Error(`Refused with ${reply.error.code}.`)
  return reply.data as T
}

function actionsOf(member: { chatId: string }): string[] {
  const path = cultControlPath(f.h.rig.userData, member.chatId)
  if (!existsSync(path)) return []
  return (JSON.parse(readFileSync(path, 'utf8')) as { actions: { action: string }[] }).actions.map((entry) => entry.action)
}

/** The launch epoch the member's control file is stamped with; null without one. */
function controlEpoch(member: { chatId: string }): string | null {
  const path = cultControlPath(f.h.rig.userData, member.chatId)
  if (!existsSync(path)) return null
  const file: { epoch: string | null } = JSON.parse(readFileSync(path, 'utf8'))
  return file.epoch
}

const definition = (overrides: object = {}) => ({ ...folderCultInput(f.h), ...overrides })
const createdCult = (overrides: object = {}) => data(invoke<CultView>('create', definition(overrides)))
const desk = () => f.h.pool.get(f.h.rig.repo)
const lastSnapshot = (runId: string): CultRunDetail | undefined => f.pushed.filter((event) => event.snapshot.run.id === runId).at(-1)?.snapshot

/** Moves run time past the run's shutdown backstop (members that never exit on their own are killed), then waits for its end. */
async function pastBackstop(runId: string): Promise<void> {
  await settle()
  const run = f.h.cults.getRun(runId)!
  f.clock.advance(backstopMs(run.acolyteGraceMs, run.magosWindowMs))
  await eventually(() => lastSnapshot(runId)?.run.state === 'ended', 'the stopped run to end')
}

async function startedRun(overrides: object = {}) {
  const cult = await createdCult(overrides)
  const detail = await data(invoke<CultRunDetail>('start', cult.id, {}))
  return { cult, detail, run: detail.run, magos: detail.members[0]! }
}

describe('cults IPC: channels and validation (c1)', () => {
  it('registers exactly one cults:* channel per CultsApi method', () => {
    expect([...f.channels.keys()].sort()).toEqual(CHANNELS.map((method) => `cults:${method}`).sort())
  })

  it.each<[string, string, unknown[]]>([
    ['a definition missing its name', 'create', [{ ...SHAPE, name: undefined }]],
    ['a definition with an unknown key', 'create', [{ ...SHAPE, workDir: '/elsewhere' }]],
    ['a definition that is not an object', 'create', ['cult']],
    ['a cult id with a path in it', 'get', ['../ct_1']],
    ['a cult id that is not a string', 'delete', [42]],
    ['run overrides naming a work folder', 'start', ['ct_1', { workDir: '/elsewhere' }]],
    ['a cap that is not a whole number', 'raiseCap', ['cr_1', 6.5]],
    ['a decision that is not a boolean', 'decidePetition', ['cp_1', 'yes']],
    ['a chat id with a separator', 'dismissAcolyte', ['cr_1', 'a/b']],
    ['a refresh that is not a boolean', 'models', ['yes']],
    ['a pipeline page with no limit', 'pipeline', ['cr_1', {}]]
  ])('refuses %s with invalid_input', async (_label, method, args) => {
    expect(await invoke(method, ...args)).toMatchObject(refused('invalid_input'))
    expect(f.h.cults.listCults()).toEqual([])
  })

  it('refuses a folder cult whose folder is not tracked, and a sanctum cult that names a folder (c2)', async () => {
    const outside = `${f.h.rig.root}/untracked`
    expect(await invoke('create', definition({ folderPath: outside }))).toMatchObject(refused('folder_not_tracked'))
    // A registered sanctum passes main's own gates, never the renderer's folder check.
    const sanctum = await f.h.sanctums.create('ct_01j0000000000000000000000a')
    expect(await invoke('create', definition({ folderPath: sanctum }))).toMatchObject(refused('folder_not_tracked'))
    expect(await invoke('create', definition({ scope: 'sanctum', folderPath: sanctum }))).toMatchObject(refused('invalid_input'))
    expect(f.h.cults.listCults()).toEqual([])
  })

  it('answers the model list, refreshed on request, the archetype catalog, and pipeline as unavailable until it is served', async () => {
    expect(await data(invoke('models'))).toEqual({ options: MODELS, reason: null })
    expect(await data(invoke('models', true))).toEqual({ options: MODELS.slice(0, 1), reason: null })
    const catalog = await data(invoke<{ archetypes: { id: string; preset: unknown[] }[]; standardWorkerTypes: { id: string; origin: string }[] }>('archetypes'))
    expect(catalog.archetypes.map((archetype) => archetype.id)).toEqual([...CULT_ARCHETYPES])
    expect(catalog.archetypes.find((archetype) => archetype.id === 'plan_forge')?.preset).toHaveLength(6)
    expect(catalog.standardWorkerTypes.map((type) => [type.id, type.origin])).toEqual(STANDARD_WORKER_TYPES.map((type) => [type, 'standard']))
    const { run } = await startedRun()
    expect(await invoke('pipeline', run.id, { limit: 50 })).toMatchObject(refused('operation_unavailable'))
  })
})

/** A definition's keys with a folder no test tracks: malformed variants are refused before the folder is looked at. */
const SHAPE = { name: 'Order of the Cog', charter: 'Polish the brass.', scope: 'folder', folderPath: '/repo', archetype: 'general', magosName: 'Magos Ferrum', magosModelId: null, defaultTimeLimitMs: null }

describe('cults IPC: archetypes, custom slots and Plan Forge targets (c7)', () => {
  it('founds, lists and reads back a cult of each of the six archetypes', async () => {
    const epic = await desk().createEpic({ title: 'Target plan' })
    const extra: Record<string, object> = {
      plan_forge: { targetEpicId: epic.id, defaultCap: 6 },
      custom: { slots: [{ id: 'scribe', workerType: 'custom', label: 'Scribe', mission: 'Record every rite.', required: true }] }
    }
    for (const archetype of CULT_ARCHETYPES) {
      const cult = await createdCult({ name: `Cult ${archetype}`, archetype, ...extra[archetype] })
      expect(await data(invoke<CultView>('get', cult.id))).toEqual(cult)
      expect(cult).toMatchObject({ archetype, folderPath: f.h.rig.repo })
    }
    expect((await data(invoke<CultView[]>('list'))).map((cult) => cult.archetype).sort()).toEqual([...CULT_ARCHETYPES].sort())
  })

  it('keeps a Custom cult\'s ordered slots with their stable ids, labels and missions, and edits them in order', async () => {
    const slots = [
      { id: 'herald', workerType: 'custom', label: 'Herald', mission: 'Announce each finding.', required: true },
      { id: 'warden', workerType: 'security', label: 'Warden', mission: 'Guard the gates.', required: true },
      { id: 'archivist', workerType: 'custom', label: 'Archivist', mission: 'Keep the scrolls.', required: false }
    ]
    const cult = await createdCult({ archetype: 'custom', slots })
    expect(cult.slots).toEqual(slots)
    const reordered = [slots[2]!, slots[0]!, slots[1]!]
    const updated = await data(invoke<CultView>('update', cult.id, definition({ archetype: 'custom', slots: reordered })))
    expect(updated.slots.map((slot) => slot.id)).toEqual(['archivist', 'herald', 'warden'])
    expect(await invoke('create', definition({ archetype: 'custom', slots: [{ ...slots[0], id: 'a b' }] }))).toMatchObject(refused('invalid_input'))
    expect(await invoke('create', definition({ archetype: 'custom', slots: [{ ...slots[0], label: ' ' }] }))).toMatchObject(refused('invalid_input'))
  })

  it('refuses a Plan Forge target outside its folder and a Plan Forge cap below six', async () => {
    const epic = await desk().createEpic({ title: 'Target plan' })
    const forge = (overrides: object) => invoke('create', definition({ archetype: 'plan_forge', targetEpicId: epic.id, ...overrides }))
    expect(await forge({ targetEpicId: 'ep_01j0000000000000000000000z' })).toMatchObject(refused('invalid_input'))
    expect(await forge({ targetEpicId: null })).toMatchObject(refused('invalid_input'))
    expect(await forge({ defaultCap: 5 })).toMatchObject(refused('invalid_input'))
    expect(f.h.cults.listCults()).toEqual([])
    const cult = await data(forge({ defaultCap: 6 }) as Promise<CommandResult<CultView>>)
    expect(await invoke('update', cult.id, definition({ archetype: 'plan_forge', targetEpicId: epic.id, defaultCap: 5 }))).toMatchObject(refused('invalid_input'))
  })

  it('shows a Plan Forge run\'s target and its live council coverage, every required specialist missing at first', async () => {
    const epic = await desk().createEpic({ title: 'Target plan' })
    const { detail } = await startedRun({ archetype: 'plan_forge', targetEpicId: epic.id, defaultCap: 6 })
    expect(detail.targetEpicId).toBe(epic.id)
    expect(detail.slots.map((slot) => [slot.slotId, slot.origin, slot.required, slot.reportCount])).toEqual(
      STANDARD_WORKER_TYPES.map((type) => [type, 'definition_slot', true, 0]))
    expect(detail.missing).toEqual({ slots: [...STANDARD_WORKER_TYPES], workerTypes: [] })
    expect(detail.synthesis).toBeNull()
    expect(detail.members).toEqual([expect.objectContaining({ role: 'magos', typeOrigin: null, reported: false })])
    expect(await invoke('dismissAcolyte', detail.run.id, 'nobody')).toMatchObject(refused('not_found'))
  })
})

describe('cults IPC: run controls and events (c3)', () => {
  it('maps pause, resume and Stop to the supervisor and pushes each change as a cults:event snapshot', async () => {
    const { run, magos } = await startedRun()
    expect(lastSnapshot(run.id)?.run.state).toBe('running')

    const paused = await data(invoke<CultRunDetail>('pause', run.id))
    expect(paused.run.state).toBe('paused')
    await eventually(() => actionsOf(magos).includes('interrupt'), 'the interrupt')
    expect(lastSnapshot(run.id)?.run.state).toBe('paused')

    expect((await data(invoke<CultRunDetail>('resume', run.id))).run.state).toBe('running')
    expect(lastSnapshot(run.id)?.run.state).toBe('running')

    expect((await data(invoke<CultRunDetail>('stop', run.id))).run.state).toBe('shutting_down')
    await pastBackstop(run.id)
    expect(lastSnapshot(run.id)?.run.endReason).toBe('stopped')
  })

  it('maps raising the cap, a petition decision and a dismissal to the supervisor, each pushed live', async () => {
    const { run } = await startedRun()
    expect((await data(invoke<CultRunDetail>('raiseCap', run.id, run.cap + 2))).run.cap).toBe(run.cap + 2)
    expect(lastSnapshot(run.id)?.run.cap).toBe(run.cap + 2)
    expect(await invoke('raiseCap', run.id, run.cap)).toMatchObject(refused('invalid_input'))

    const petition = f.supervisor.petition(run.id, { kind: 'acolytes', additional: 2, reason: 'More hands.' })
    expect(await data(invoke('decidePetition', petition.id, true, 1))).toMatchObject({ id: petition.id, state: 'approved', granted: 1 })
    expect(lastSnapshot(run.id)?.run.cap).toBe(run.cap + 3)

    const acolyte = await f.supervisor.addAcolyte(run.id, { mission: 'Sweep the nave.', name: 'Acolyte Brass' })
    // A graceful dismissal asks the acolyte to exit, and it does.
    const dismissing = invoke('dismissAcolyte', run.id, acolyte.chatId)
    await eventually(() => actionsOf(acolyte).includes('shutdown'), 'the shutdown request')
    ptyOf(f.h, acolyte).exit()
    expect(await data(dismissing)).toMatchObject({ chatId: acolyte.chatId, state: 'dismissed' })
    expect(lastSnapshot(run.id)?.members.find((member) => member.chatId === acolyte.chatId)?.state).toBe('dismissed')
  })
})

describe('cults IPC: Kill now, run history, unsubscribe and delete (c3)', () => {
  it('kills a run at once and lists the cult\'s runs, newest first, as details', async () => {
    const { cult, run } = await startedRun()
    expect((await data(invoke<CultRunDetail>('killNow', run.id))).run).toMatchObject({ state: 'ended', endReason: 'killed' })
    const second = await data(invoke<CultRunDetail>('start', cult.id, { cap: 3 }))
    expect(second.run.cap).toBe(3)
    expect((await data(invoke<CultRunDetail[]>('runs', cult.id))).map((detail) => detail.run.id)).toEqual([second.run.id, run.id])
  })

  it('stops forwarding once unsubscribed', async () => {
    const { run } = await startedRun()
    f.stopForwarding()
    const before = f.pushed.length
    await data(invoke('pause', run.id))
    expect(f.pushed).toHaveLength(before)
  })

  it('ends an active run gracefully before deleting its cult, which the store alone refuses', async () => {
    const { cult, run } = await startedRun()
    expect(() => f.h.cults.deleteCult(cult.id)).toThrow(expect.objectContaining({ code: 'active_run_exists' }))
    const deleting = invoke('delete', cult.id)
    await pastBackstop(run.id)
    expect(await data(deleting)).toBeNull()
    expect(f.pushed.some((event) => event.snapshot.run.id === run.id && event.snapshot.run.state === 'ended' && event.snapshot.run.endReason === 'stopped')).toBe(true)
    expect(f.h.cults.getCult(cult.id)).toBeNull()
    expect(await invoke('get', cult.id)).toMatchObject(refused('not_found'))
  })
})

describe('cults IPC: a member launching while its run is paused', () => {
  it('re-sends the paused state to a member\'s new launch, whose control file starts afresh', async () => {
    const { run } = await startedRun()
    const acolyte = await f.supervisor.addAcolyte(run.id, { mission: 'Sweep the nave.', name: 'Acolyte Brass' })
    await data(invoke('pause', run.id))
    await eventually(() => actionsOf(acolyte).includes('interrupt'), 'the first interrupt')
    const first = f.h.rig.sessions.generationOf(acolyte.chatId)
    // Its terminal exits and relaunches (a person reattaches it) while it is still a member of the paused run.
    f.hearing.exits = false
    ptyOf(f.h, acolyte).exit({ exitCode: 1, signal: null })
    await settle()
    await f.h.rig.sessions.attach({ folder: run.workDir, id: acolyte.chatId })
    await eventually(() => f.h.rig.sessions.generationOf(acolyte.chatId) !== null, 'the relaunch')
    const second = f.h.rig.sessions.generationOf(acolyte.chatId)
    expect(second).not.toBe(first)
    // The paused state was sent to the new launch: a file stamped with its epoch holding the interrupt alone.
    await eventually(() => controlEpoch(acolyte) === second, 'the control file of the new launch')
    expect(actionsOf(acolyte)).toEqual(['interrupt'])
    f.hearing.exits = true
  })

  it('sends nothing to a relaunched member of a running run', async () => {
    const { run } = await startedRun()
    const acolyte = await f.supervisor.addAcolyte(run.id, { mission: 'Sweep the nave.', name: 'Acolyte Brass' })
    f.hearing.exits = false
    ptyOf(f.h, acolyte).exit({ exitCode: 1, signal: null })
    await settle()
    await f.h.rig.sessions.attach({ folder: run.workDir, id: acolyte.chatId })
    await eventually(() => f.h.rig.sessions.generationOf(acolyte.chatId) !== null, 'the relaunch')
    await settle()
    expect(actionsOf(acolyte)).toEqual([])
    f.hearing.exits = true
  })
})

describe('cults IPC: Magos-created types and reports (c8)', () => {
  const TYPE = { displayName: 'Archivist', description: 'Keeps the records.', mission: 'Catalogue every finding.', rationale: 'No record keeper.', requiredForConclusion: true }

  it('delivers a Magos-created type, its assignment and its report live, marked magos_created', async () => {
    const { run, magos } = await startedRun()
    await command(magos, 'cult_create_worker_type', TYPE)
    expect(lastSnapshot(run.id)?.workerTypes).toEqual([expect.objectContaining({
      id: 'dyn_1', ...TYPE, origin: 'magos_created', state: 'active', assignedChatIds: [], reportCount: 0, creatorMemberId: magos.chatId
    })])
    expect(lastSnapshot(run.id)?.missing.workerTypes).toEqual(['dyn_1'])

    await command(magos, 'cult_summon_acolyte', { name: 'Acolyte Keeper', mission: 'Keep it.', workerTypeId: 'dyn_1' })
    const keeper = lastSnapshot(run.id)!.members.find((member) => member.displayName === 'Acolyte Keeper')!
    expect(keeper).toMatchObject({ runWorkerTypeId: 'dyn_1', workerType: null, slotId: null, typeOrigin: 'magos_created', reported: false })
    expect(lastSnapshot(run.id)?.workerTypes[0]?.assignedChatIds).toEqual([keeper.chatId])

    await command(keeper, 'cult_conclude_service', { report: 'Every finding is catalogued.' })
    await eventually(() => lastSnapshot(run.id)?.workerTypes[0]?.reportCount === 1, 'the report to be pushed')
    expect(lastSnapshot(run.id)?.members.find((member) => member.chatId === keeper.chatId)?.reported).toBe(true)
    expect(lastSnapshot(run.id)?.missing.workerTypes).toEqual([])
  })

  it('refuses every renderer input that would create a run type or forge a member\'s resolved type', async () => {
    const { cult, run, magos } = await startedRun({ archetype: 'custom', slots: [{ id: 'scribe', workerType: 'custom', label: 'Scribe', mission: 'Write.', required: false }] })
    await command(magos, 'cult_create_worker_type', TYPE)
    const base = definition({ archetype: 'custom', slots: cult.slots })
    const forged: [string, unknown[]][] = [
      ['update', [cult.id, { ...base, workerTypes: [{ ...TYPE, id: 'dyn_9' }] }]],
      ['update', [cult.id, { ...base, slots: [{ ...cult.slots[0], runWorkerTypeId: 'dyn_1' }] }]],
      ['update', [cult.id, { ...base, slots: [{ ...cult.slots[0], workerType: 'dyn_1' }] }]],
      ['update', [cult.id, { ...base, slots: [{ ...cult.slots[0], origin: 'magos_created' }] }]],
      ['create', [{ ...base, members: [{ chatId: magos.chatId, workerType: 'security' }] }]],
      ['start', [cult.id, { workerTypes: [TYPE] }]],
      ['start', [cult.id, { runWorkerTypeId: 'dyn_1' }]]
    ]
    for (const [method, args] of forged) expect(await invoke(method, ...args), `${method} ${JSON.stringify(args[1])}`).toMatchObject(refused('invalid_input'))
    expect(f.h.cults.listWorkerTypes(run.id).map((type) => type.id)).toEqual(['dyn_1'])
    expect(f.h.cults.getCult(cult.id)?.slots).toEqual(cult.slots)
    expect(f.h.cults.listMembers(run.id).map((member) => [member.workerType, member.runWorkerTypeId])).toEqual([[null, null]])
  })
})
