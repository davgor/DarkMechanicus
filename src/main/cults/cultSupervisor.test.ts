/**
 * The cult supervisor over the real pieces (`__mocks__/cultRig.ts`): the cult store on a real app database, real chat
 * grants in real workspaces, the members' control files on disk and the terminal session manager on the fake PTY host.
 * Run time is a fake clock (`FakeClock`), shared by the supervisor and the store; nothing waits on wall time.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CultMemberView, CultRunView } from '../../shared/cults/cult'
import { DEFAULT_ACOLYTE_GRACE_MS, DEFAULT_MAGOS_WINDOW_MS, remainingMs } from '../../shared/cults/runState'
import { eventually, FakeClock, settle } from '../terminals/__mocks__/terminalSessionsRig'
import { cultHarness, disposeCultHarness, folderCultInput, ptyOf, type CultHarness } from './__mocks__/cultRig'
import { cultControlPath } from './cultControl'
import { createCultLedger, type CultLedger, type LeftoverProcesses } from './cultLedger'
import { createCultSupervisor, CULT_CHANGED, type CultRunSnapshot, type CultSupervisor } from './cultSupervisor'
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

function supervisorOver(fixture: Omit<Fixture, 'supervisor' | 'snapshots'>): CultSupervisor {
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
    onError: (error) => fixture.errors.push(error)
  })
}

beforeEach(async () => {
  const clock = new FakeClock()
  const supervisorClock = clockOver(clock)
  const h = await cultHarness({ now: supervisorClock.now, exitOnKill: true })
  const ledger = createCultLedger({ userData: h.rig.userData })
  const base = { h, clock, supervisorClock, ledger, errors: [], reaped: [], hearing: { on: true } }
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
