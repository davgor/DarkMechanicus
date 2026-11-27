/**
 * The cult supervisor over the real pieces (`__mocks__/cultRig.ts`): the cult store on a real app database, real chat
 * grants in real workspaces, the members' control files on disk and the terminal session manager on the fake PTY host.
 * Run time is a fake clock (`FakeClock`), shared by the supervisor and the store; nothing waits on wall time.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import type { CultMemberView, CultRunView } from '../../shared/cults/cult'
import { DEFAULT_ACOLYTE_GRACE_MS, DEFAULT_MAGOS_WINDOW_MS, remainingMs, type RunState } from '../../shared/cults/runState'
import { eventually, FakeClock, settle } from '../terminals/__mocks__/terminalSessionsRig'
import { ompFilePaths } from '../terminals/ompSession'
import { cultHarness, disposeCultHarness, folderCultInput, ptyOf, type CultHarness } from './__mocks__/cultRig'
import { cultControlPath } from './cultControl'
import { createCultLedger, type CultLedger, type LeftoverProcesses } from './cultLedger'
import { createCultSupervisor, CULT_CHANGED, requireRunningRun, type CultRunSnapshot, type CultSupervisor } from './cultSupervisor'
import { MAX_TIMEOUT_MS, type SupervisorClock } from './runTimer'

const BASE = Date.parse('2026-11-26T09:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const DAY = 24 * 60 * MINUTE

interface Fixture {
  h: CultHarness
  /** Run time: what the supervisor's timers and the store's stamps read. */
  clock: FakeClock
  supervisorClock: SupervisorClock & { longest: number }
  /** The member activity poll's own clock, apart from run time so run timers count alone. */
  activityClock: FakeClock
  ledger: CultLedger
  supervisor: CultSupervisor
  errors: unknown[]
  /** Every pid a startup's leftover lookup ended. */
  reaped: number[]
  snapshots: CultRunSnapshot[]
  /** Whether the supervisor still hears its members' exits: a crashed app hears nothing more. */
  hearing: { on: boolean }
}

let f: Fixture

function clockOver(clock: FakeClock): Fixture['supervisorClock'] {
  const supervisorClock = {
    longest: 0,
    now: () => new Date(BASE + clock.now).toISOString(),
    after: (callback: () => void, ms: number) => {
      supervisorClock.longest = Math.max(supervisorClock.longest, ms)
      return clock.after(callback, ms)
    }
  }
  return supervisorClock
}

/** The leftovers a startup finds: a process runs only as a fake PTY of the rig that has not exited. */
function rigLeftovers(h: CultHarness, reaped: number[]): LeftoverProcesses {
  const running = (pid: number) => h.rig.host.spawns.find((pty) => pty.pid === pid && !pty.exited)
  return {
    commandLine: async (pid) => (running(pid)?.spec.args as string[] | undefined)?.join(' ') ?? null,
    killTree: async (pid) => {
      reaped.push(pid)
      running(pid)?.exit({ exitCode: 137, signal: 9 })
    }
  }
}

type SupervisorDeps = Parameters<typeof createCultSupervisor>[0]

function supervisorOver(fixture: Omit<Fixture, 'supervisor' | 'snapshots'>, overrides: Partial<SupervisorDeps> = {}): CultSupervisor {
  const { h } = fixture
  return createCultSupervisor({
    cults: h.cults, launcher: h.launcher, control: h.control, ledger: fixture.ledger,
    terminals: {
      isRunning: (chatId) => h.rig.sessions.isRunning(chatId),
      attachGrant: (chatId, grantId) => h.rig.sessions.attachGrant(chatId, grantId),
      detachGrant: (chatId, grantId) => h.rig.sessions.detachGrant(chatId, grantId),
      onExit: (listener) => h.rig.sessions.onExit((chatId) => fixture.hearing.on && listener(chatId))
    },
    grants: h.grants, chatStore: h.rig.store,
    revokeGrantIn: async (folder, grantId) => {
      await h.pool.get(folder).revokeGrant({ grantId })
    },
    folders: { resolve: (path) => (h.rig.tracked.has(path) ? path : null) },
    leftovers: rigLeftovers(h, fixture.reaped),
    userData: h.rig.userData,
    clock: fixture.supervisorClock,
    activityClock: { now: () => new Date(BASE + fixture.activityClock.now).toISOString(), after: (callback, ms) => fixture.activityClock.after(callback, ms) },
    onError: (error) => fixture.errors.push(error),
    ...overrides
  })
}

beforeEach(async () => {
  const clock = new FakeClock()
  const supervisorClock = clockOver(clock)
  const h = await cultHarness({ now: supervisorClock.now, exitOnKill: true })
  const ledger = createCultLedger({ userData: h.rig.userData })
  const base = { h, clock, supervisorClock, activityClock: new FakeClock(), ledger, errors: [], reaped: [], hearing: { on: true } }
  const supervisor = supervisorOver(base)
  const snapshots: CultRunSnapshot[] = []
  supervisor.on(CULT_CHANGED, (snapshot) => snapshots.push(snapshot))
  f = { ...base, supervisor, snapshots }
})

afterEach(async () => {
  await f.supervisor.dispose()
  await settle()
  await disposeCultHarness(f.h)
})

/** Replaces the fixture's supervisor with one over `overrides`; the fixture's teardown disposes it. */
async function superviseWith(overrides: Partial<SupervisorDeps>): Promise<void> {
  await f.supervisor.dispose()
  f.supervisor = supervisorOver(f, overrides)
}

/** Moves run time on by `ms`, then lets the work the timers started settle. */
async function advance(ms: number): Promise<void> {
  f.clock.advance(ms)
  await settle()
}

async function startRun(overrides: Parameters<typeof folderCultInput>[1] = {}, options: Parameters<CultSupervisor['start']>[1] = {}) {
  const cult = f.h.cults.createCult(folderCultInput(f.h, overrides))
  const { run, members } = await f.supervisor.start(cult.id, options)
  return { run, magos: members[0]! }
}

function runOf(runId: string): CultRunView {
  return f.h.cults.getRun(runId)!
}

function actionsOf(member: Pick<CultMemberView, 'chatId'>): string[] {
  const path = cultControlPath(f.h.rig.userData, member.chatId)
  if (!existsSync(path)) return []
  return (JSON.parse(readFileSync(path, 'utf8')) as { actions: { action: string }[] }).actions.map((entry) => entry.action)
}

async function controlled(member: Pick<CultMemberView, 'chatId'>, action: string): Promise<void> {
  await eventually(() => actionsOf(member).includes(action), `${action} for ${member.chatId}`)
}

function running(member: Pick<CultMemberView, 'chatId'>): boolean {
  return f.h.rig.sessions.isRunning(member.chatId)
}

async function summon(runId: string, name?: string) {
  return f.supervisor.addAcolyte(runId, { mission: 'Sweep the nave.', ...(name === undefined ? {} : { name }) })
}

describe('cult supervisor: the running-time timer', () => {
  it('expires a run exactly at its limit, and starts its graceful shutdown', async () => {
    const { run } = await startRun({ defaultTimeLimitMs: 60 * MINUTE })

    expect(run.state).toBe('running')
    await advance(60 * MINUTE - 1)
    expect(runOf(run.id).state).toBe('running')
    await advance(1)
    expect(runOf(run.id)).toMatchObject({ state: 'shutting_down', endReason: 'expired', accumulatedRunningMs: 60 * MINUTE })
  })

  it('does not count paused time: pause and resume keep the remaining time exact', async () => {
    const { run, magos } = await startRun({ defaultTimeLimitMs: 60 * MINUTE })
    await advance(20 * MINUTE)
    await f.supervisor.pause(run.id)

    expect(f.clock.pending).toBe(0)
    await advance(7 * DAY)
    expect(runOf(run.id)).toMatchObject({ state: 'paused', accumulatedRunningMs: 20 * MINUTE })
    await f.supervisor.resume(run.id)
    expect(remainingMs(runOf(run.id), f.supervisorClock.now())).toBe(40 * MINUTE)
    await advance(40 * MINUTE - 1)
    expect(runOf(run.id).state).toBe('running')
    await advance(1)
    expect(runOf(run.id)).toMatchObject({ state: 'shutting_down', endReason: 'expired' })
    // The expiry starts the shutdown from its timer; the wind-down reaches the Magos's control file on the real disk.
    await controlled(magos, 'wind_down')
    expect(actionsOf(magos)).toEqual(['interrupt', 'resume', 'wind_down'])
  })

  it('never expires an unlimited run: it has no timer', async () => {
    const { run } = await startRun({ defaultTimeLimitMs: null })

    expect(f.clock.pending).toBe(0)
    await advance(365 * DAY)
    expect(runOf(run.id).state).toBe('running')
  })

  it('re-arms a 30-day limit in chunks the platform timer takes, and fires once at the limit', async () => {
    const { run } = await startRun({ defaultTimeLimitMs: 30 * DAY })

    await advance(30 * DAY - 1)
    expect(runOf(run.id).state).toBe('running')
    expect(f.supervisorClock.longest).toBe(MAX_TIMEOUT_MS)
    await advance(1)
    expect(runOf(run.id)).toMatchObject({ state: 'shutting_down', endReason: 'expired' })
    const started = f.h.cults.pageEvents(run.id).events.filter((event) => event.kind === 'shutdown_started')
    expect(started).toHaveLength(1)
  })
})

describe('cult supervisor: pause and resume', () => {
  it('interrupts every member, closes the standing wake, and resume reopens it with the resumed reminder', async () => {
    const { run, magos } = await startRun()
    const acolyte = await summon(run.id, 'Acolyte Tests')
    expect(f.supervisor.isWakeOpen(run.id)).toBe(true)

    await f.supervisor.pause(run.id)
    expect(f.supervisor.isWakeOpen(run.id)).toBe(false)
    expect([actionsOf(magos), actionsOf(acolyte)]).toEqual([['interrupt'], ['interrupt']])
    // No restart: the same processes run on.
    expect([running(magos), running(acolyte)]).toEqual([true, true])
    expect(f.h.rig.host.spawns).toHaveLength(2)

    await f.supervisor.resume(run.id)
    expect(f.supervisor.isWakeOpen(run.id)).toBe(true)
    expect([actionsOf(magos), actionsOf(acolyte)]).toEqual([['interrupt', 'resume'], ['interrupt', 'resume']])
    expect(f.snapshots.map((snapshot) => snapshot.run.state)).toEqual(expect.arrayContaining(['running', 'paused']))
  })
})

describe('cult supervisor: graceful shutdown', () => {
  it.each([
    ['the default timings', {}, DEFAULT_ACOLYTE_GRACE_MS, DEFAULT_MAGOS_WINDOW_MS],
    ['custom timings', { acolyteGraceMs: 30 * SECOND, magosWindowMs: 45 * SECOND }, 30 * SECOND, 45 * SECOND]
  ])('runs grace, then the Magos window, then the backstop at grace + window + 1 min with %s', async (_name, timings, grace, window) => {
    const { run, magos } = await startRun({}, timings)
    const concluding = await summon(run.id, 'Acolyte Swift')
    const stubborn = await summon(run.id, 'Acolyte Stubborn')

    await f.supervisor.stop(run.id)
    expect(runOf(run.id)).toMatchObject({ state: 'shutting_down', endReason: 'stopped' })
    expect([actionsOf(magos), actionsOf(concluding), actionsOf(stubborn)]).toEqual([['wind_down'], ['conclude'], ['conclude']])
    expect(f.supervisor.isWakeOpen(run.id)).toBe(false)

    // An acolyte that concludes in the grace is ended gracefully: asked to exit, and it does.
    const concluded = f.supervisor.concludeMember(run.id, concluding.chatId)
    await controlled(concluding, 'shutdown')
    ptyOf(f.h, concluding).exit()
    await concluded
    expect(ptyOf(f.h, concluding).kills).toBe(0)

    await advance(grace - 1)
    expect(actionsOf(stubborn)).toEqual(['conclude'])
    await advance(1)
    await controlled(stubborn, 'shutdown')
    expect(actionsOf(magos)).toEqual(['wind_down'])

    await advance(window)
    await controlled(magos, 'shutdown')
    expect([running(magos), running(stubborn)]).toEqual([true, true])

    await advance(60 * SECOND - 1)
    expect(runOf(run.id).state).toBe('shutting_down')
    await advance(1)
    await eventually(() => runOf(run.id).state === 'ended', 'the run to end')

    expect(runOf(run.id)).toMatchObject({ state: 'ended', endReason: 'stopped' })
    expect(f.h.rig.host.spawns.every((pty) => pty.exited)).toBe(true)
    expect(f.h.rig.sessions.activeChats()).toEqual([])
    expect([ptyOf(f.h, magos).kills, ptyOf(f.h, stubborn).kills]).toEqual([1, 1])
    expect(f.h.cults.listMembers(run.id).map((member) => [member.displayName, member.state])).toEqual([
      ['Magos Ferrum', 'left'], ['Acolyte Swift', 'concluded'], ['Acolyte Stubborn', 'left']
    ])
    expect(f.clock.pending).toBe(0)
  })

  it('ends the run as soon as its last member has exited, before the backstop', async () => {
    const { run, magos } = await startRun()
    await f.supervisor.stop(run.id)
    ptyOf(f.h, magos).exit()

    await eventually(() => runOf(run.id).state === 'ended', 'the run to end')
    expect(runOf(run.id).endReason).toBe('stopped')
    expect(f.clock.pending).toBe(0)
  })
})

describe('cult supervisor: Kill now and the Magos dying', () => {
  it('Kill now ends every member at once', async () => {
    const { run, magos } = await startRun()
    const acolytes = [await summon(run.id), await summon(run.id)]

    await f.supervisor.killNow(run.id)
    expect(runOf(run.id)).toMatchObject({ state: 'ended', endReason: 'killed' })
    expect([magos, ...acolytes].map((member) => [running(member), ptyOf(f.h, member).kills])).toEqual([[false, 1], [false, 1], [false, 1]])
    expect(f.h.cults.listMembers(run.id).every((member) => member.state === 'left')).toBe(true)
    expect(f.clock.pending).toBe(0)
  })

  it('records a member that exits unexpectedly as left, and fails the run when the Magos dies', async () => {
    const { run, magos } = await startRun()
    const lost = await summon(run.id, 'Acolyte Lost')
    const other = await summon(run.id, 'Acolyte Other')

    ptyOf(f.h, lost).exit({ exitCode: 1, signal: null })
    await eventually(() => f.h.cults.listMembers(run.id).some((member) => member.displayName === 'Acolyte Lost' && member.state === 'left'), 'the departure')
    expect(runOf(run.id).state).toBe('running')

    ptyOf(f.h, magos).exit({ exitCode: 1, signal: null })
    await eventually(() => runOf(run.id).state === 'ended', 'the run to fail')
    expect(runOf(run.id).endReason).toBe('failed')
    expect([running(other), ptyOf(f.h, other).kills]).toEqual([false, 1])
    const left = f.h.cults.pageEvents(run.id).events.filter((event) => event.kind === 'left').map((event) => event.memberName)
    expect(left).toEqual(['Acolyte Lost', 'Magos Ferrum', 'Acolyte Other'])
  })
})

describe('cult supervisor: acolytes', () => {
  it('refuses a summon past the cap and while paused, and names a missing or taken name uniquely', async () => {
    const { run } = await startRun({ defaultCap: 2 })
    const unnamed = await summon(run.id)
    const taken = await summon(run.id, 'Magos Ferrum')

    expect(unnamed.displayName).toMatch(/^Acolyte /)
    expect(taken.displayName).toMatch(/^Acolyte /)
    expect(new Set(f.h.cults.listMembers(run.id).map((member) => member.displayName.toLowerCase())).size).toBe(3)
    await expect(summon(run.id)).rejects.toMatchObject({ code: 'capacity_exceeded' })
    await f.supervisor.pause(run.id)
    await expect(summon(run.id)).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(f.supervisor.dismissAcolyte(run.id, taken.chatId)).rejects.toMatchObject({ code: 'invalid_state' })
  })

  it('dismisses an acolyte gracefully through its control file', async () => {
    const { run } = await startRun()
    const acolyte = await summon(run.id, 'Acolyte Leaving')
    const dismissing = f.supervisor.dismissAcolyte(run.id, acolyte.chatId)
    await controlled(acolyte, 'shutdown')
    ptyOf(f.h, acolyte).exit()

    expect(await dismissing).toMatchObject({ state: 'dismissed' })
    expect(ptyOf(f.h, acolyte).kills).toBe(0)
  })
})

/** A second tracked folder, set up for Dark Mechanicus: what a folder-access petition may name. */
async function otherFolder(): Promise<string> {
  const other = join(f.h.rig.root, 'other')
  mkdirSync(other)
  f.h.rig.tracked.add(other)
  await f.h.pool.get(other).initializeRepository({ name: 'other', mode: 'db' })
  return other
}

async function grantOf(folder: string, grantId: string) {
  return (await f.h.pool.get(folder).listGrants()).find((grant) => grant.id === grantId)
}

/** Approves folder access for the Magos: an orchestrator grant there, its token file, and the live terminal renewing it. */
async function approveFolderAccess(run: CultRunView, magos: CultMemberView, other: string) {
  const access = f.supervisor.petition(run.id, { kind: 'folder_access', folderPath: other, reason: 'Read the other plan.' }, magos.chatId)
  await f.supervisor.decidePetition(access.id, true)
  const [folderGrant] = f.ledger.grants().filter((grant) => grant.kind === 'folder_access')
  expect(await grantOf(other, folderGrant!.grantId)).toMatchObject({ role: 'orchestrator', allowSave: false, active: true })
  expect(readFileSync(folderGrant!.tokenFile!, 'utf8')).toMatch(/\S/)
  // Live: the same Magos process runs on, and its terminal renews the new grant with its own.
  expect(f.h.rig.host.spawns).toHaveLength(1)
  f.h.rig.clock.advance(60 * MINUTE)
  await eventually(() => f.h.rig.renewed.includes(folderGrant!.grantId), 'the renewal')
  return folderGrant!
}

describe('cult supervisor: petitions', () => {
  it('raises the cap, turns on Allow save and grants folder access to the running Magos, then revokes all of it at the end', async () => {
    const other = await otherFolder()
    const { run, magos } = await startRun({ defaultCap: 1 })
    const magosGrant = f.h.rig.store.getChat({ folder: run.workDir, id: magos.chatId })!.grantIds![0]!

    const cap = f.supervisor.petition(run.id, { kind: 'acolytes', additional: 3, reason: 'More hands.' }, magos.chatId)
    expect((await f.supervisor.decidePetition(cap.id, true, 2)).granted).toBe(2)
    expect(runOf(run.id).cap).toBe(3)

    const save = f.supervisor.petition(run.id, { kind: 'allow_save', reason: 'Save the plan.' }, magos.chatId)
    await f.supervisor.decidePetition(save.id, true)
    expect(await grantOf(run.workDir, magosGrant)).toMatchObject({ allowSave: true, active: true })
    expect(f.h.rig.store.getChat({ folder: run.workDir, id: magos.chatId })!.allowSave).toBe(true)

    const folderGrant = await approveFolderAccess(run, magos, other)
    await controlled(magos, 'petition')
    const told = JSON.parse(readFileSync(cultControlPath(f.h.rig.userData, magos.chatId), 'utf8')).actions.map((entry: { petition?: unknown }) => entry.petition)
    expect(told).toEqual([
      { kind: 'acolytes', approved: true, granted: 2 },
      { kind: 'allow_save', approved: true },
      { kind: 'folder_access', approved: true, folder: other, tokenFile: folderGrant.tokenFile }
    ])

    await f.supervisor.killNow(run.id)
    expect(await grantOf(run.workDir, magosGrant)).toMatchObject({ allowSave: false })
    expect(f.h.rig.store.getChat({ folder: run.workDir, id: magos.chatId })!.allowSave).toBe(false)
    expect(await grantOf(other, folderGrant.grantId)).toMatchObject({ active: false })
    expect(existsSync(folderGrant.tokenFile!)).toBe(false)
    expect(f.ledger.grants()).toEqual([])
  })

  it('denies each kind without changing anything, tells the Magos, and refuses an untracked folder', async () => {
    const other = await otherFolder()
    const { run, magos } = await startRun({ defaultCap: 1 })
    const magosGrant = f.h.rig.store.getChat({ folder: run.workDir, id: magos.chatId })!.grantIds![0]!
    const asked = [
      f.supervisor.petition(run.id, { kind: 'acolytes', additional: 3, reason: 'More hands.' }, magos.chatId),
      f.supervisor.petition(run.id, { kind: 'allow_save', reason: 'Save.' }, magos.chatId),
      f.supervisor.petition(run.id, { kind: 'folder_access', folderPath: other, reason: 'Read.' }, magos.chatId)
    ]
    for (const petition of asked) await f.supervisor.decidePetition(petition.id, false)

    expect(runOf(run.id).cap).toBe(1)
    expect(await grantOf(run.workDir, magosGrant)).toMatchObject({ allowSave: false })
    expect(f.ledger.grants()).toEqual([])
    expect(actionsOf(magos)).toEqual(['petition', 'petition', 'petition'])
    expect(() => f.supervisor.petition(run.id, { kind: 'folder_access', folderPath: join(f.h.rig.root, 'nowhere'), reason: 'x' })).toThrow(/not tracked/)
  })

  it('denies a pending petition when the run ends', async () => {
    const { run, magos } = await startRun()
    const pending = f.supervisor.petition(run.id, { kind: 'allow_save', reason: 'Save.' }, magos.chatId)
    await f.supervisor.killNow(run.id)

    expect(f.h.cults.getPetition(pending.id)).toMatchObject({ state: 'denied' })
  })
})

describe('cult supervisor: the event log', () => {
  it('appends a named event for every summon, dismissal, conclusion, departure, petition and decision, and each run step', async () => {
    const { run, magos } = await startRun({}, { acolyteGraceMs: 30 * SECOND, magosWindowMs: 30 * SECOND })
    const dismissed = await summon(run.id, 'Acolyte Dismissed')
    const concluding = await summon(run.id, 'Acolyte Concluding')
    const dismissing = f.supervisor.dismissAcolyte(run.id, dismissed.chatId)
    await controlled(dismissed, 'shutdown')
    ptyOf(f.h, dismissed).exit()
    await dismissing
    const petition = f.supervisor.petition(run.id, { kind: 'acolytes', additional: 1, reason: 'One more.' }, magos.chatId)
    await f.supervisor.decidePetition(petition.id, false)
    await f.supervisor.pause(run.id)
    await f.supervisor.resume(run.id)
    await f.supervisor.stop(run.id)
    const concluded = f.supervisor.concludeMember(run.id, concluding.chatId)
    await controlled(concluding, 'shutdown')
    ptyOf(f.h, concluding).exit()
    await concluded
    await advance(30 * SECOND)
    ptyOf(f.h, magos).exit()
    await eventually(() => runOf(run.id).state === 'ended', 'the run to end')

    const events = f.h.cults.pageEvents(run.id).events.map((event) => [event.kind, event.memberName])
    expect(events).toEqual([
      ['summoned', 'Magos Ferrum'],
      ['summoned', 'Acolyte Dismissed'],
      ['summoned', 'Acolyte Concluding'],
      ['dismissed', 'Acolyte Dismissed'],
      ['petition_created', 'Magos Ferrum'],
      ['petition_denied', 'Magos Ferrum'],
      ['paused', null],
      ['resumed', null],
      ['shutdown_started', null],
      ['concluded', 'Acolyte Concluding'],
      ['shutdown_step', null],
      ['left', 'Magos Ferrum'],
      ['ended', null]
    ])
  })
})

describe('cult supervisor: quit and restart', () => {
  it('ends every member on quit and marks the run interrupted', async () => {
    const { run, magos } = await startRun()
    const acolyte = await summon(run.id)

    expect(f.supervisor.busy()).toBe(true)
    await f.supervisor.dispose()
    expect(runOf(run.id)).toMatchObject({ state: 'ended', endReason: 'interrupted' })
    expect([running(magos), running(acolyte)]).toEqual([false, false])
    expect(f.supervisor.busy()).toBe(false)
  })

  it('marks runs left active interrupted on startup, ends their surviving processes and revokes the upgrades they left', async () => {
    // The app that crashed: its run, its member processes (fake PTYs still running) and its upgrade, all on disk.
    const { run, magos } = await startRun()
    const acolyte = await summon(run.id)
    const save = f.supervisor.petition(run.id, { kind: 'allow_save', reason: 'Save.' }, magos.chatId)
    await f.supervisor.decidePetition(save.id, true)
    const magosGrant = f.h.rig.store.getChat({ folder: run.workDir, id: magos.chatId })!.grantIds![0]!
    await eventually(() => readFileSync(join(f.h.rig.userData, 'cults', 'ledger.json'), 'utf8').includes(magosGrant), 'the ledger')
    // A recorded pid that is no process of a member any more is left alone.
    await f.ledger.addProcess({ runId: run.id, chatId: f.h.rig.newChat('omp').id, pid: 1 })
    // The crash: the old supervisor hears nothing more.
    f.hearing.on = false
    await controlled(magos, 'petition')

    const restarted = supervisorOver({ ...f, hearing: { on: true }, ledger: createCultLedger({ userData: f.h.rig.userData }) })
    const interrupted = await restarted.reconcileOnStartup()

    expect(interrupted.map((candidate) => [candidate.id, candidate.state, candidate.endReason])).toEqual([[run.id, 'ended', 'interrupted']])
    expect(f.reaped.sort()).toEqual([ptyOf(f.h, magos).pid, ptyOf(f.h, acolyte).pid].sort())
    expect(f.h.rig.host.spawns.every((pty) => pty.exited)).toBe(true)
    expect(f.h.cults.listMembers(run.id).every((member) => member.state === 'left')).toBe(true)
    expect(await grantOf(run.workDir, magosGrant)).toMatchObject({ active: false })
    expect(f.h.rig.store.getChat({ folder: run.workDir, id: magos.chatId })!.allowSave).toBe(false)
    expect(createCultLedger({ userData: f.h.rig.userData }).processes()).toEqual([])
    // A member chat resumed later finds no control file to re-apply.
    expect(existsSync(cultControlPath(f.h.rig.userData, magos.chatId))).toBe(false)
    expect(await restarted.reconcileOnStartup()).toEqual([])
  })
})

describe('cult supervisor: member activity', () => {
  it('publishes each live member\'s working flag and last tool in its snapshots, at most once per 2 s, until the run ends', async () => {
    const { run, magos } = await startRun()
    const { sessionDir } = ompFilePaths(f.h.rig.userData, magos.chatId)
    const write = (path: string): void => {
      mkdirSync(sessionDir, { recursive: true })
      const entry = { type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'Edit', arguments: { path } }] } }
      writeFileSync(join(sessionDir, '2026-11-26T09-00-00-000Z_01a2183e-671f-77a4-af4f-4626eb9fee75.jsonl'), JSON.stringify(entry) + '\n')
    }
    write('/repo/src/renderer/src/cults/CultPage.tsx')
    const before = f.snapshots.length
    f.activityClock.advance(2 * SECOND)
    await settle()

    const published = f.snapshots.slice(before)
    expect(published).toHaveLength(1)
    expect(published[0]!.members[0]!.activity).toMatchObject({ working: true, tool: { name: 'edit', target: 'cults/CultPage.tsx' } })
    write('/repo/a/second.ts')
    f.activityClock.advance(SECOND)
    write('/repo/a/third.ts')
    f.activityClock.advance(SECOND)
    await settle()
    expect(f.snapshots.slice(before)).toHaveLength(2)
    expect(f.supervisor.snapshot(run.id).members[0]!.activity?.tool?.target).toBe('a/third.ts')

    await f.supervisor.killNow(run.id)
    await settle()
    expect(f.supervisor.snapshot(run.id).members[0]!.activity).toBeNull()
    expect(f.clock.pending).toBe(0)
  })
})

/** A promise the test opens when it chooses. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

function shutdownSteps(runId: string): string[] {
  return f.h.cults.pageEvents(runId).events.filter((event) => event.kind === 'shutdown_step').map((event) => event.summary)
}

describe('cult supervisor: refusals', () => {
  it('refuses a run it does not know or no longer supervises, and an unknown petition', async () => {
    await expect(f.supervisor.pause('cr_missing')).rejects.toMatchObject({ code: 'not_found' })
    const { run } = await startRun()
    await f.supervisor.killNow(run.id)

    await expect(f.supervisor.resume(run.id)).rejects.toMatchObject({ code: 'invalid_state', message: expect.stringMatching(/not supervised/) })
    await expect(f.supervisor.decidePetition('cp_missing', true)).rejects.toMatchObject({ code: 'not_found' })
  })

  it.each([
    ['starting', 'invalid_state'],
    ['paused', 'run_paused'],
    ['shutting_down', 'run_ending'],
    ['ended', 'run_ending']
  ])('refuses a member command while the run is %s with %s', (state, code) => {
    expect(() => requireRunningRun({ state: state as RunState })).toThrow(expect.objectContaining({ code }))
  })

  it('refuses to dismiss the Magos, and an acolyte being dismissed is no member any more', async () => {
    const { run, magos } = await startRun()
    await expect(f.supervisor.dismissAcolyte(run.id, magos.chatId)).rejects.toMatchObject({ code: 'invalid_input' })
    const acolyte = await summon(run.id, 'Acolyte Leaving')
    expect(f.supervisor.memberOf(acolyte.chatId)).toMatchObject({ run: { id: run.id }, member: { role: 'acolyte' } })

    const dismissing = f.supervisor.dismissAcolyte(run.id, acolyte.chatId)
    await controlled(acolyte, 'shutdown')
    expect(running(acolyte)).toBe(true)
    expect(f.supervisor.memberOf(acolyte.chatId)).toBeNull()
    ptyOf(f.h, acolyte).exit()
    await dismissing
    expect(running(magos)).toBe(true)
  })

  it('answers a conclusion of a run already stopping with its snapshot, without a second shutdown', async () => {
    const { run } = await startRun()
    await f.supervisor.stop(run.id)

    expect((await f.supervisor.concludeRun(run.id)).run).toMatchObject({ state: 'shutting_down', endReason: 'stopped' })
    expect(f.h.cults.pageEvents(run.id).events.filter((event) => event.kind === 'shutdown_started')).toHaveLength(1)
  })

  it('leaves a petition pending when the store refuses its approval, with nothing applied or told', async () => {
    const { run, magos } = await startRun({ defaultCap: 24 })
    const more = f.supervisor.petition(run.id, { kind: 'acolytes', additional: 1, reason: 'More hands.' }, magos.chatId)

    await expect(f.supervisor.decidePetition(more.id, true)).rejects.toMatchObject({ code: 'capacity_exceeded' })
    expect(f.h.cults.getPetition(more.id)!.state).toBe('pending')
    expect(actionsOf(magos)).toEqual([])
  })

  it('marks an acolyte that did not start as left, and refuses its summon', async () => {
    const { run } = await startRun()
    f.h.rig.host.failNextSpawn(new Error('posix_spawnp failed.'))

    await expect(summon(run.id, 'Acolyte Stillborn')).rejects.toMatchObject({ code: 'internal_error', message: expect.stringContaining('Acolyte Stillborn did not start') })
    expect(f.h.cults.listMembers(run.id).find((member) => member.displayName === 'Acolyte Stillborn')!.state).toBe('left')
    expect(runOf(run.id).state).toBe('running')
  })
})

describe('cult supervisor: the Magos concluding and leaving', () => {
  it.each([
    ['a running run: its shutdown starts, completed', false, 'completed'],
    ['a run already stopping: it stays stopped', true, 'stopped']
  ])('the Magos concludes %s', async (_name, stopFirst, reason) => {
    const { run, magos } = await startRun()
    if (stopFirst) await f.supervisor.stop(run.id)

    const concluding = f.supervisor.concludeMember(run.id, magos.chatId)
    await controlled(magos, 'shutdown')
    ptyOf(f.h, magos).exit()
    expect(await concluding).toMatchObject({ state: 'concluded' })
    await eventually(() => runOf(run.id).state === 'ended', 'the run to end')
    expect(runOf(run.id).endReason).toBe(reason)
    expect(f.h.cults.pageEvents(run.id).events.filter((event) => event.kind === 'shutdown_started')).toHaveLength(1)
  })

  it('fails a run whose Magos exits before it is watched, leaving no timer', async () => {
    f.h.rig.host.onSpawn = (pty) => {
      queueMicrotask(() => pty.exit({ exitCode: 1, signal: null }))
    }
    const { run } = await startRun()

    await eventually(() => runOf(run.id).state === 'ended', 'the run to fail')
    expect(runOf(run.id).endReason).toBe('failed')
    expect(f.supervisor.busy()).toBe(false)
    expect(f.clock.pending).toBe(0)
  })

  it('with its Magos gone mid-shutdown: refuses a decision, skips the Magos at the window, and the backstop ends the rest', async () => {
    const { run, magos } = await startRun({}, { acolyteGraceMs: 30 * SECOND, magosWindowMs: 30 * SECOND })
    const acolyte = await summon(run.id, 'Acolyte Last')
    const pending = f.supervisor.petition(run.id, { kind: 'allow_save', reason: 'Save.' }, magos.chatId)
    await f.supervisor.stop(run.id)
    ptyOf(f.h, magos).exit()
    await eventually(() => f.h.cults.listMembers(run.id)[0]!.state === 'left', 'the Magos to leave')

    await expect(f.supervisor.decidePetition(pending.id, true)).rejects.toMatchObject({ code: 'invalid_state', message: expect.stringMatching(/no running Magos/) })
    await advance(60 * SECOND)
    expect(runOf(run.id).state).toBe('shutting_down')
    await advance(60 * SECOND)
    await eventually(() => runOf(run.id).state === 'ended', 'the backstop')
    expect(runOf(run.id).endReason).toBe('stopped')
    expect([running(acolyte), ptyOf(f.h, acolyte).kills]).toEqual([false, 1])
    expect(shutdownSteps(run.id)).toEqual([
      'The acolyte grace ended; the Magos has its window to write the chronicle and conclude.',
      'The Magos window ended.',
      'The backstop ended every member still running.'
    ])
    expect(f.h.cults.getPetition(pending.id)!.state).toBe('denied')
  })
})

describe('cult supervisor: timers out of step', () => {
  it('waits out a clock that fires early, and expires the run only at its limit', async () => {
    let early = true
    await superviseWith({
      clock: {
        now: f.supervisorClock.now,
        after: (callback, ms) => {
          const lead = early ? MINUTE : 0
          early = false
          return f.clock.after(callback, ms - lead)
        }
      }
    })
    const { run } = await startRun({ defaultTimeLimitMs: 60 * MINUTE })

    await advance(59 * MINUTE)
    expect(runOf(run.id).state).toBe('running')
    await advance(MINUTE - 1)
    expect(runOf(run.id).state).toBe('running')
    await advance(1)
    expect(runOf(run.id)).toMatchObject({ state: 'shutting_down', endReason: 'expired', accumulatedRunningMs: 60 * MINUTE })
  })

  it('ignores a limit timer that still fires after the run was paused', async () => {
    await superviseWith({
      clock: {
        now: f.supervisorClock.now,
        after: (callback, ms) => {
          f.clock.after(callback, ms)
          return () => {}
        }
      }
    })
    const { run } = await startRun({ defaultTimeLimitMs: 60 * MINUTE })
    await advance(10 * MINUTE)
    await f.supervisor.pause(run.id)

    await advance(50 * MINUTE)
    expect(runOf(run.id)).toMatchObject({ state: 'paused', accumulatedRunningMs: 10 * MINUTE })
  })
})

describe('cult supervisor: shutdown timers after the end', () => {
  it('lets a backstop that still fires after the run ended kill nothing and record no step', async () => {
    await superviseWith({
      clock: {
        now: f.supervisorClock.now,
        after: (callback, ms) => {
          f.clock.after(callback, ms)
          return () => {}
        }
      }
    })
    const { run, magos } = await startRun({}, { acolyteGraceMs: 30 * SECOND, magosWindowMs: 30 * SECOND })
    await f.supervisor.stop(run.id)
    ptyOf(f.h, magos).exit()
    await f.supervisor.endRun(run.id)
    expect(f.supervisor.busy()).toBe(false)

    await advance(2 * MINUTE)
    expect(shutdownSteps(run.id)).not.toContain('The backstop ended every member still running.')
    expect(runOf(run.id)).toMatchObject({ state: 'ended', endReason: 'stopped' })
    expect(ptyOf(f.h, magos).kills).toBe(0)
  })
})

describe('cult supervisor: ending races', () => {
  it('refuses a Stop that arrives while Kill now is ending the run, leaving no shutdown step or timer behind', async () => {
    const held = gate()
    let first = true
    f.supervisor.onWakeClose(async () => {
      if (!first) return
      first = false
      await held.wait
    })
    const { run } = await startRun()
    const killing = f.supervisor.killNow(run.id)
    await expect(f.supervisor.stop(run.id)).rejects.toMatchObject({ code: 'run_ending' })
    held.open()
    await killing

    expect(runOf(run.id)).toMatchObject({ state: 'ended', endReason: 'killed' })
    expect(f.clock.pending).toBe(0)
    await advance(DEFAULT_ACOLYTE_GRACE_MS + DEFAULT_MAGOS_WINDOW_MS + MINUTE)
    expect(shutdownSteps(run.id)).toEqual([])
  })

  it('ends a run once when its last member exits while its Stop is still closing the wake', async () => {
    const held = gate()
    f.supervisor.onWakeClose(() => held.wait)
    const { run, magos } = await startRun()
    const stopping = f.supervisor.stop(run.id)
    await eventually(() => runOf(run.id).state === 'shutting_down', 'the shutdown to start')
    ptyOf(f.h, magos).exit()
    await eventually(() => runOf(run.id).state === 'ended', 'the run to end')

    held.open()
    expect((await stopping).run).toMatchObject({ state: 'ended', endReason: 'stopped' })
    expect(f.h.cults.pageEvents(run.id).events.filter((event) => event.kind === 'ended')).toHaveLength(1)
    expect(f.errors).toEqual([])
    expect(f.clock.pending).toBe(0)
  })
})

describe('cult supervisor: endRun', () => {
  it('waits for a run already stopping to end', async () => {
    const { run, magos } = await startRun()
    await f.supervisor.stop(run.id)
    const ending = f.supervisor.endRun(run.id)
    ptyOf(f.h, magos).exit()

    await ending
    expect(runOf(run.id)).toMatchObject({ state: 'ended', endReason: 'stopped' })
    expect(f.supervisor.busy()).toBe(false)
  })

  it('ends at once a run none of whose members runs any more', async () => {
    const { run, magos } = await startRun()
    f.hearing.on = false
    ptyOf(f.h, magos).exit()

    await f.supervisor.endRun(run.id)
    expect(runOf(run.id)).toMatchObject({ state: 'ended', endReason: 'stopped' })
    expect(f.supervisor.busy()).toBe(false)
  })

  it('keeps a stopped run\'s end when Kill now arrives while it is still settling', async () => {
    const { run, magos } = await startRun()
    await f.supervisor.stop(run.id)
    ptyOf(f.h, magos).exit()
    expect(runOf(run.id).state).toBe('ended')

    const killed = await f.supervisor.killNow(run.id)
    expect(killed.run).toMatchObject({ state: 'ended', endReason: 'stopped' })
    await f.supervisor.endRun(run.id)
    expect(f.supervisor.busy()).toBe(false)
    expect(f.h.cults.pageEvents(run.id).events.filter((event) => event.kind === 'ended')).toHaveLength(1)
  })
})

describe('cult supervisor: defaults', () => {
  it('without an error sink or clocks of its own, a failing control write never stands in the way of a pause', async () => {
    await superviseWith({
      clock: undefined, activityClock: undefined, onError: undefined,
      control: { send: async () => Promise.reject(new Error('The disk is full.')), clear: (chatId) => f.h.control.clear(chatId) }
    })
    const { run } = await startRun({ defaultTimeLimitMs: null })

    expect((await f.supervisor.pause(run.id)).run.state).toBe('paused')
    expect(f.supervisor.isWakeOpen(run.id)).toBe(false)
    await f.supervisor.killNow(run.id)
  })
})

/** The real chat grants, with `setChatGrantAllowSave` replaced. */
function grantsWith(setChatGrantAllowSave: SupervisorDeps['grants']['setChatGrantAllowSave']): SupervisorDeps['grants'] {
  return { ...f.h.grants, setChatGrantAllowSave }
}

describe('cult supervisor: upgrades out of step', () => {
  it('takes back an upgrade whose decision lands after the run ended, and refuses the work queued behind it', async () => {
    const held = gate()
    const applied: boolean[] = []
    await superviseWith({
      grants: grantsWith(async (grantId, allowSave) => {
        await f.h.grants.setChatGrantAllowSave(grantId, allowSave)
        applied.push(allowSave)
        if (allowSave) await held.wait
      })
    })
    const { run, magos } = await startRun()
    const save = f.supervisor.petition(run.id, { kind: 'allow_save', reason: 'Save.' }, magos.chatId)
    const cap = f.supervisor.petition(run.id, { kind: 'acolytes', additional: 1, reason: 'More.' }, magos.chatId)
    const outcomes = Promise.allSettled([f.supervisor.decidePetition(save.id, true), f.supervisor.decidePetition(cap.id, true), f.supervisor.concludeRun(run.id)])
    await eventually(() => applied.includes(true), 'Allow save to be applied')

    await f.supervisor.killNow(run.id)
    held.open()
    const [saved, capped, concluded] = await outcomes
    expect(saved).toMatchObject({ status: 'rejected', reason: { code: 'invalid_state', message: expect.stringMatching(/already denied/) } })
    expect(capped).toMatchObject({ status: 'rejected', reason: { code: 'invalid_state', message: expect.stringMatching(/already denied/) } })
    expect(concluded).toMatchObject({ status: 'rejected', reason: { code: 'run_ending' } })
    expect(f.h.rig.store.getChat({ folder: run.workDir, id: magos.chatId })!.allowSave).toBe(false)
    expect(f.ledger.grants()).toEqual([])
    expect(runOf(run.id).cap).toBe(run.cap)
  })

  it('refuses a queued decision whose petition was deleted with its cult after the run ended', async () => {
    const held = gate()
    await superviseWith({
      grants: grantsWith(async (grantId, allowSave) => {
        await f.h.grants.setChatGrantAllowSave(grantId, allowSave)
        if (allowSave) await held.wait
      })
    })
    const { run, magos } = await startRun()
    const save = f.supervisor.petition(run.id, { kind: 'allow_save', reason: 'Save.' }, magos.chatId)
    const cap = f.supervisor.petition(run.id, { kind: 'acolytes', additional: 1, reason: 'More.' }, magos.chatId)
    const outcomes = Promise.allSettled([f.supervisor.decidePetition(save.id, true), f.supervisor.decidePetition(cap.id, true)])
    await eventually(() => f.ledger.grants().length === 1, 'Allow save to be applied')

    await f.supervisor.killNow(run.id)
    f.h.cults.deleteCult(run.cultId)
    held.open()
    const [saved, capped] = await outcomes
    expect(saved).toMatchObject({ status: 'rejected', reason: { code: 'not_found' } })
    expect(capped).toMatchObject({ status: 'rejected', reason: { code: 'not_found', message: `No cult petition ${cap.id}.` } })
    expect(f.ledger.grants()).toEqual([])
  })
})

describe('cult supervisor: upgrade refusals and revocation failures', () => {
  it('reports an Allow save it could not revoke at the end, and keeps it in the ledger for the next start', async () => {
    const failure = new Error('The workspace is closed.')
    await superviseWith({
      grants: grantsWith(async (grantId, allowSave) => (allowSave ? f.h.grants.setChatGrantAllowSave(grantId, allowSave) : Promise.reject(failure)))
    })
    const { run, magos } = await startRun()
    await f.supervisor.decidePetition(f.supervisor.petition(run.id, { kind: 'allow_save', reason: 'Save.' }, magos.chatId).id, true)

    await f.supervisor.killNow(run.id)
    expect(f.errors).toContain(failure)
    expect(f.ledger.grants()).toMatchObject([{ kind: 'allow_save', chatId: magos.chatId }])
  })

  it('needs nothing more for an Allow save whose grant is already gone at the end', async () => {
    const gone = new DomainError('invalid_state', 'The grant was revoked.')
    await superviseWith({
      grants: grantsWith(async (grantId, allowSave) => (allowSave ? f.h.grants.setChatGrantAllowSave(grantId, allowSave) : Promise.reject(gone)))
    })
    const { run, magos } = await startRun()
    await f.supervisor.decidePetition(f.supervisor.petition(run.id, { kind: 'allow_save', reason: 'Save.' }, magos.chatId).id, true)

    await f.supervisor.killNow(run.id)
    expect(f.errors).not.toContain(gone)
    expect(f.ledger.grants()).toEqual([])
    expect(f.h.rig.store.getChat({ folder: run.workDir, id: magos.chatId })!.allowSave).toBe(false)
  })

  it('refuses Allow save for a Magos that holds no grant, leaving the petition pending', async () => {
    await superviseWith({
      chatStore: {
        getChat: (ref) => {
          const chat = f.h.rig.store.getChat(ref)
          return chat === null ? null : { ...chat, grantIds: [] }
        },
        updateChat: (ref, patch) => f.h.rig.store.updateChat(ref, patch)
      }
    })
    const { run, magos } = await startRun()
    const save = f.supervisor.petition(run.id, { kind: 'allow_save', reason: 'Save.' }, magos.chatId)

    await expect(f.supervisor.decidePetition(save.id, true)).rejects.toMatchObject({ code: 'invalid_state', message: expect.stringMatching(/holds no grant/) })
    expect(f.h.cults.getPetition(save.id)!.state).toBe('pending')
    expect(f.ledger.grants()).toEqual([])
  })
})

describe('cult supervisor: folder access upgrades', () => {
  it('revokes a folder grant the Magos terminal could not take, and refuses the approval', async () => {
    const other = await otherFolder()
    const sessions = f.h.rig.sessions
    await superviseWith({
      terminals: {
        isRunning: (chatId) => sessions.isRunning(chatId),
        attachGrant: () => false,
        detachGrant: (chatId, grantId) => sessions.detachGrant(chatId, grantId),
        onExit: (listener) => sessions.onExit(listener)
      }
    })
    const { run, magos } = await startRun()
    const access = f.supervisor.petition(run.id, { kind: 'folder_access', folderPath: other, reason: 'Read.' }, magos.chatId)

    await expect(f.supervisor.decidePetition(access.id, true)).rejects.toMatchObject({ code: 'invalid_state', message: expect.stringMatching(/no longer running/) })
    const issued = (await f.h.pool.get(other).listGrants()).filter((grant) => grant.label.endsWith('Cult folder access'))
    expect(issued.map((grant) => grant.active)).toEqual([false])
    expect(f.ledger.grants()).toEqual([])
    expect(f.h.cults.getPetition(access.id)!.state).toBe('pending')
  })

  it('on startup revokes a folder access a crash left, and deletes its token file', async () => {
    const other = await otherFolder()
    const { run, magos } = await startRun()
    const folderGrant = await approveFolderAccess(run, magos, other)
    f.hearing.on = false

    const restarted = supervisorOver({ ...f, hearing: { on: true }, ledger: createCultLedger({ userData: f.h.rig.userData }) })
    await restarted.reconcileOnStartup()
    expect(await grantOf(other, folderGrant.grantId)).toMatchObject({ active: false })
    expect(existsSync(folderGrant.tokenFile!)).toBe(false)
    expect(createCultLedger({ userData: f.h.rig.userData }).grants()).toEqual([])
  })
})
