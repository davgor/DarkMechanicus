/**
 * Cult commands through the real control pipe (`src/main/naming/controlPipe.ts`) and the real desktop client
 * (`src/core/desktop/desktopClient.ts`). Each caller holds the real chat grant its member's launch bound
 * (`src/main/agents/chatGrants.ts`); main derives its run and role from that grant alone. The runs are real supervised
 * runs over the cult rig (`__mocks__/cultRig.ts`): the cult store on a real app database, real workspaces with their
 * mailboxes, fake PTYs, and a fake run clock that nothing here advances.
 */
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDesktopClient } from '../../core/desktop/desktopClient'
import { fail } from '../../core/errors'
import { readInbox } from '../../core/services/agentMailStore'
import type { NamingOperation, NamingReply } from '../../shared/agents/chatNaming'
import { STANDARD_WORKER_TYPES } from '../../shared/cults/archetypes'
import type { CultInput, CultMemberView, CultRunView } from '../../shared/cults/cult'
import { MAGOS_OPERATIONS, MAX_LONG_TEXT_BYTES } from '../../shared/cults/cultControl'
import { createControlPipe, type ControlPipe, type NamingDispatcher } from '../naming/controlPipe'
import { eventually, FakeClock, settle } from '../terminals/__mocks__/terminalSessionsRig'
import { cultHarness, disposeCultHarness, folderCultInput, ptyOf, type CultHarness } from './__mocks__/cultRig'
import { createCultDispatcher, planTargetRevision, type CultCommandDeps } from './cultCommands'
import { cultControlPath } from './cultControl'
import { createCultLedger } from './cultLedger'
import { createCultSupervisor, type CultSupervisor } from './cultSupervisor'
import { cheapest, parseOmpModels } from './ompModels'

const MODELS = parseOmpModels(readFileSync(new URL('./__fixtures__/omp-models.json', import.meta.url), 'utf8'), ['anthropic'])!
const CHEAPEST = cheapest(MODELS)!
const BASE = Date.parse('2026-11-26T09:00:00.000Z')

interface Fixture {
  h: CultHarness
  clock: FakeClock
  supervisor: CultSupervisor
  pipe: ControlPipe
  /** What the pipe dispatches to; a test may swap in a dispatcher with other dependencies. */
  dispatch: NamingDispatcher
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

/** The dispatcher main builds (`startCults` in `bootstrap.ts`), over the rig's pieces. */
function commandDeps(overrides: Partial<CultCommandDeps> = {}): CultCommandDeps {
  const { h } = f
  return {
    supervisor: f.supervisor, cults: h.cults, models: async () => MODELS,
    sendOrder: (order) => h.pool.get(order.folder).call('sendCultOrder', order),
    targetRevision: planTargetRevision(h.cults, (folder, epicId) => h.pool.get(folder).getEpic({ epicId })),
    now: runTime(f.clock),
    ...overrides
  }
}

beforeEach(async () => {
  const clock = new FakeClock()
  const h = await cultHarness({ now: runTime(clock), exitOnKill: true })
  f = { h, clock, supervisor: supervisorOver(h, clock), pipe: null as never, dispatch: null as never }
  f.dispatch = createCultDispatcher(commandDeps())
  f.pipe = await createControlPipe({ authorize: (token) => h.grants.authorizeNaming(token), dispatch: (operation, context) => f.dispatch(operation, context) })
})

afterEach(async () => {
  await f.pipe.close()
  await f.supervisor.dispose()
  await settle()
  await disposeCultHarness(f.h)
})

type Member = Pick<CultMemberView, 'chatId'>

/** The grant token the member's launch runs with, as its `dm` reads it. */
const tokenOf = (member: Member): string => ptyOf(f.h, member).spec.env['DM_SESSION_TOKEN']!

/** One cult operation through the desktop client, as `member` (its token) or as the holder of a raw token. */
function call(member: Member | string, op: string, args: object = {}): Promise<NamingReply> {
  const token = typeof member === 'string' ? member : tokenOf(member)
  return createDesktopClient({ env: { DM_DESKTOP_PIPE: f.pipe.address, DM_SESSION_TOKEN: token } }).request({ op, args } as NamingOperation)
}

async function data<T = Record<string, unknown>>(reply: Promise<NamingReply>): Promise<T> {
  const settled = await reply
  if (!settled.ok) throw new Error(`Refused with ${settled.error.code}.`)
  return settled.data as T
}

const refusal = (code: string) => ({ ok: false, error: { code } })

/** A request written straight to the pipe, past the client's own checks: what the server alone refuses. */
async function raw(token: string, op: string, args: object): Promise<unknown> {
  const socket = createConnection(f.pipe.address)
  let text = ''
  socket.on('data', (chunk) => (text += String(chunk)))
  const closed = once(socket, 'close')
  await once(socket, 'connect')
  socket.write(`${JSON.stringify({ version: 1, requestId: 'raw-1', token, op, args })}\n`)
  await closed
  return JSON.parse(text)
}

async function startRun(overrides: Partial<CultInput> = {}) {
  const cult = f.h.cults.createCult(folderCultInput(f.h, overrides))
  const { run, members } = await f.supervisor.start(cult.id)
  return { run, magos: members[0]! }
}

const memberNamed = (runId: string, name: string): CultMemberView =>
  f.h.cults.listMembers(runId).find((member) => member.displayName === name)!

async function summon(magos: Member, args: object = {}): Promise<{ summoned: string; model: string; tier: string; tierReason: string | null }> {
  return data(call(magos, 'cult_summon_acolyte', { mission: 'Sweep the nave.', ...args }))
}

function actionsOf(member: Member): string[] {
  const path = cultControlPath(f.h.rig.userData, member.chatId)
  if (!existsSync(path)) return []
  return (JSON.parse(readFileSync(path, 'utf8')) as { actions: { action: string }[] }).actions.map((entry) => entry.action)
}

/** The member's mailbox messages, read straight from its folder's store. */
function inboxOf(run: CultRunView, member: Member) {
  const endpointId = f.h.rig.store.getChat({ folder: run.workDir, id: member.chatId })!.endpointId!
  return readInbox(f.h.pool.get(run.workDir).ctx(), { endpointId }).messages
}

const ordersOf = (runId: string) => f.h.cults.pageEvents(runId).events.filter((event) => event.kind === 'order_all')

/** Valid arguments of every operation, so a refusal is the caller's, never the input's. */
const ARGS: Readonly<Record<string, object>> = {
  cult_status: {},
  cult_summon_acolyte: { mission: 'Sweep the nave.' },
  cult_dismiss_acolyte: { name: 'Acolyte Brass' },
  cult_list_acolytes: {},
  cult_petition: { kind: 'allow_save', reason: 'Save the plan.' },
  cult_order_all: { body: 'Kneel.' },
  cult_conclude_run: { chronicle: 'It is done.' },
  cult_conclude_service: { report: 'It is done.' },
  cult_create_worker_type: { displayName: 'Scribe', description: 'Writes.', mission: 'Write.', rationale: 'Needed.', requiredForConclusion: false }
}

describe('cult control: the caller comes only from its bound grant (c3)', () => {
  it('refuses a chat that is not a member, and a token no live grant holds', async () => {
    const { run } = await startRun()
    const outsider = await f.h.grants.issueChatCli(run.workDir, { role: 'orchestrator', allowSave: false, label: 'Outsider' })
    await f.h.grants.bindChatGrant(outsider.grantId, { folder: run.workDir, chatId: 'ch_outsider', generation: 'outsider-1' })
    const token = outsider.cli.env['DM_SESSION_TOKEN']!

    for (const op of Object.keys(ARGS)) expect(await call(token, op, ARGS[op]!), op).toMatchObject(refusal('unauthorized'))
    expect(await call('dmg_foreign_token', 'cult_status')).toMatchObject(refusal('unauthorized'))
    expect(f.h.cults.listMembers(run.id)).toHaveLength(1)
    expect(f.h.cults.listPetitions(run.id)).toEqual([])
  })

  it('refuses an acolyte every Magos-only command and the Magos the acolyte-only one; both read their status', async () => {
    const { run, magos } = await startRun()
    await summon(magos, { name: 'Acolyte Brass' })
    const acolyte = memberNamed(run.id, 'Acolyte Brass')

    for (const op of MAGOS_OPERATIONS) expect(await call(acolyte, op, ARGS[op]!), op).toMatchObject(refusal('unauthorized'))
    expect(await call(magos, 'cult_conclude_service', ARGS['cult_conclude_service']!)).toMatchObject(refusal('unauthorized'))
    expect(await data(call(acolyte, 'cult_status'))).toMatchObject({ name: 'Acolyte Brass', role: 'acolyte', magosName: 'Magos Ferrum', state: 'running' })
    expect(await data(call(magos, 'cult_status'))).toMatchObject({
      name: 'Magos Ferrum', role: 'magos', state: 'running', remainingMs: 60 * 60_000, cap: 6, liveAcolytes: 1, pendingPetitions: []
    })
    expect(memberNamed(run.id, 'Acolyte Brass').state).toBe('active')
    expect(f.h.cults.listMembers(run.id)).toHaveLength(2)
  })

  it('takes no run, role or sender from the arguments, and acts only on the caller\'s own run', async () => {
    const a = await startRun()
    const b = await startRun({ name: 'Order of the Gear', magosName: 'Magos Aes' })
    await summon(a.magos, { name: 'Acolyte Brass' })
    await summon(b.magos, { name: 'Acolyte Rust' })

    for (const extra of [{ runId: b.run.id }, { role: 'magos' }, { sender: b.magos.chatId }]) {
      expect(await raw(tokenOf(a.magos), 'cult_order_all', { body: 'Kneel.', ...extra })).toMatchObject(refusal('invalid_request'))
      expect(await call(a.magos, 'cult_order_all', { body: 'Kneel.', ...extra })).toMatchObject(refusal('invalid_request'))
    }
    expect(await data(call(a.magos, 'cult_order_all', { body: 'Kneel.' }))).toMatchObject({ recipients: ['Acolyte Brass'] })
    expect(inboxOf(b.run, memberNamed(b.run.id, 'Acolyte Rust'))).toEqual([])
    expect(ordersOf(b.run.id)).toEqual([])
    const listed = await data<{ acolytes: { name: string }[] }>(call(b.magos, 'cult_list_acolytes'))
    expect(listed.acolytes.map((acolyte) => acolyte.name)).toEqual(['Acolyte Rust'])
  })
})

describe('cult control: summoning acolytes, model and tier', () => {
  it('runs a summon without a model on the cheapest signed-in model, and refuses one outside the list with the ids (c1)', async () => {
    const { run, magos } = await startRun()
    expect(await summon(magos, { name: 'Acolyte Brass' })).toMatchObject({ summoned: 'Acolyte Brass', model: CHEAPEST.id, tier: CHEAPEST.tier })
    expect(memberNamed(run.id, 'Acolyte Brass')).toMatchObject({ model: CHEAPEST.id, state: 'active' })
    expect(ptyOf(f.h, memberNamed(run.id, 'Acolyte Brass')).spec.args).toContain(CHEAPEST.id)

    const refused = await call(magos, 'cult_summon_acolyte', { mission: 'Sweep.', model: 'anthropic/claude-unknown-9' })
    expect(refused).toMatchObject({ ok: false, error: { code: 'model_unavailable', details: { available: MODELS.map((model) => model.id) } } })
    expect(f.h.cults.listMembers(run.id)).toHaveLength(2)
  })

  it('refuses a higher tier without a tierReason, and stores the reason on the member with one (c2)', async () => {
    const { run, magos } = await startRun()
    const higher = MODELS.find((model) => model.tier === 'high')!
    const sameTier = MODELS.find((model) => model.tier === CHEAPEST.tier && model.id !== CHEAPEST.id)!

    expect(await call(magos, 'cult_summon_acolyte', { mission: 'Prove it.', model: higher.id })).toMatchObject(refusal('tier_reason_required'))
    expect(await summon(magos, { name: 'Acolyte Cheap', model: sameTier.id })).toMatchObject({ model: sameTier.id, tierReason: null })
    const reason = 'The proof needs the deepest reasoning.'
    expect(await summon(magos, { name: 'Acolyte Deep', model: higher.id, tierReason: reason })).toMatchObject({ model: higher.id, tier: 'high', tierReason: reason })
    expect(memberNamed(run.id, 'Acolyte Deep')).toMatchObject({ model: higher.id, tier: 'high', tierReason: reason })
    expect(f.h.cults.listMembers(run.id).map((member) => member.displayName)).toEqual(['Magos Ferrum', 'Acolyte Cheap', 'Acolyte Deep'])
  })
})

describe('cult control: summoning acolytes, cap and names', () => {
  it('refuses a summon at the cap with cap_reached, and while the run is paused or ending (c5)', async () => {
    const { run, magos } = await startRun({ defaultCap: 3 })
    for (const name of ['Acolyte Brass', 'Acolyte Cog', 'Acolyte Gear']) await summon(magos, { name })

    expect(await call(magos, 'cult_summon_acolyte', ARGS['cult_summon_acolyte']!)).toMatchObject(refusal('cap_reached'))
    const listed = await data<{ acolytes: { name: string; model: string; state: string }[] }>(call(magos, 'cult_list_acolytes'))
    expect(listed.acolytes).toEqual([
      expect.objectContaining({ name: 'Acolyte Brass', model: CHEAPEST.id, state: 'active' }),
      expect.objectContaining({ name: 'Acolyte Cog', model: CHEAPEST.id, state: 'active' }),
      expect.objectContaining({ name: 'Acolyte Gear', model: CHEAPEST.id, state: 'active' })
    ])
    await f.supervisor.pause(run.id)
    expect(await call(magos, 'cult_summon_acolyte', ARGS['cult_summon_acolyte']!)).toMatchObject(refusal('run_paused'))
    await f.supervisor.resume(run.id)
    await f.supervisor.stop(run.id)
    expect(await call(magos, 'cult_summon_acolyte', ARGS['cult_summon_acolyte']!)).toMatchObject(refusal('run_ending'))
    expect(f.h.cults.listMembers(run.id)).toHaveLength(4)
  })

  it('generates a unique name for a summon without one, and refuses a taken name with name_taken (c6)', async () => {
    const { run, magos } = await startRun()
    const first = await summon(magos)
    const second = await summon(magos)
    await summon(magos, { name: 'Acolyte Brass' })

    expect(first.summoned).toMatch(/^Acolyte /)
    expect(second.summoned).toMatch(/^Acolyte /)
    expect(first.summoned).not.toBe(second.summoned)
    for (const name of ['Magos Ferrum', 'acolyte brass', first.summoned]) {
      expect(await call(magos, 'cult_summon_acolyte', { mission: 'Sweep.', name }), name).toMatchObject(refusal('name_taken'))
    }
    expect(new Set(f.h.cults.listMembers(run.id).map((member) => member.displayName.toLowerCase())).size).toBe(4)
  })
})

describe('cult control: petitions (c5)', () => {
  it('creates a pending petition of each kind, folder access on a tracked folder only', async () => {
    const other = join(f.h.rig.root, 'other')
    mkdirSync(other)
    f.h.rig.tracked.add(other)
    const { run, magos } = await startRun()

    const asked = [
      { kind: 'acolytes', additional: 2, reason: 'More hands.' },
      { kind: 'allow_save', reason: 'Save the plan.' },
      { kind: 'folder_access', folder: other, reason: 'Read the other plan.' }
    ]
    for (const args of asked) expect(await data(call(magos, 'cult_petition', args))).toMatchObject({ kind: args.kind, state: 'pending' })
    const untracked = { kind: 'folder_access', folder: join(f.h.rig.root, 'nowhere'), reason: 'Read it.' }
    expect(await call(magos, 'cult_petition', untracked)).toMatchObject(refusal('folder_not_tracked'))
    expect(await call(magos, 'cult_petition', { kind: 'acolytes', reason: 'How many?' })).toMatchObject(refusal('invalid_request'))

    expect(f.h.cults.listPetitions(run.id).map(({ kind, state, additional, folderPath }) => ({ kind, state, additional, folderPath }))).toEqual([
      { kind: 'acolytes', state: 'pending', additional: 2, folderPath: null },
      { kind: 'allow_save', state: 'pending', additional: null, folderPath: null },
      { kind: 'folder_access', state: 'pending', additional: null, folderPath: other }
    ])
    const status = await data<{ pendingPetitions: { kind: string }[] }>(call(magos, 'cult_status'))
    expect(status.pendingPetitions.map((petition) => petition.kind)).toEqual(['acolytes', 'allow_save', 'folder_access'])
  })
})

describe('cult control: order_all (c7)', () => {
  it('sends one mailbox message to each live acolyte and records one order_all event with the message ids', async () => {
    const { run, magos } = await startRun({ defaultCap: 3 })
    for (const name of ['Acolyte Brass', 'Acolyte Cog', 'Acolyte Gear']) await summon(magos, { name })
    const gear = memberNamed(run.id, 'Acolyte Gear')
    const dismissing = call(magos, 'cult_dismiss_acolyte', { name: 'Acolyte Gear' })
    await eventually(() => actionsOf(gear).includes('shutdown'), 'the dismissal')
    ptyOf(f.h, gear).exit()
    expect(await data(dismissing)).toEqual({ dismissed: 'Acolyte Gear' })

    const body = 'Every acolyte: report your findings by the next bell.'
    const order = await data<{ orderId: string; recipients: string[] }>(call(magos, 'cult_order_all', { body }))
    expect(order.recipients).toEqual(['Acolyte Brass', 'Acolyte Cog'])
    const events = ordersOf(run.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ memberName: 'Magos Ferrum', data: { orderId: order.orderId, recipients: order.recipients } })
    const messageIds = events[0]!.data!.messageIds
    expect(messageIds).toHaveLength(2)
    order.recipients.forEach((name, index) => {
      const inbox = inboxOf(run, memberNamed(run.id, name))
      expect(inbox.map(({ id, body: text }) => ({ id, text }))).toEqual([{ id: messageIds[index], text: body }])
      expect(inbox[0]!.from.endpointId).toBe(f.h.rig.store.getChat({ folder: run.workDir, id: magos.chatId })!.endpointId)
    })
    expect(inboxOf(run, magos)).toEqual([])
  })

  it('is refused with no acolytes, while paused, while ending and from an acolyte', async () => {
    const { run, magos } = await startRun()
    const order = { body: 'Kneel.' }
    expect(await call(magos, 'cult_order_all', order)).toMatchObject(refusal('no_acolytes'))
    await summon(magos, { name: 'Acolyte Brass' })
    const acolyte = memberNamed(run.id, 'Acolyte Brass')
    expect(await call(acolyte, 'cult_order_all', order)).toMatchObject(refusal('unauthorized'))
    await f.supervisor.pause(run.id)
    expect(await call(magos, 'cult_order_all', order)).toMatchObject(refusal('run_paused'))
    await f.supervisor.resume(run.id)
    await f.supervisor.stop(run.id)
    expect(await call(magos, 'cult_order_all', order)).toMatchObject(refusal('run_ending'))
    expect(ordersOf(run.id)).toEqual([])
    expect(inboxOf(run, acolyte)).toEqual([])
  })
})

describe('cult control: concluding a run', () => {
  it('stores a chronicle of at most 32 KiB and starts the end of the run', async () => {
    const { run, magos } = await startRun()
    const over = 'a'.repeat(MAX_LONG_TEXT_BYTES + 1)
    expect(await call(magos, 'cult_conclude_run', { chronicle: over })).toMatchObject(refusal('invalid_request'))
    expect(await raw(tokenOf(magos), 'cult_conclude_run', { chronicle: over })).toMatchObject(refusal('invalid_request'))
    expect(f.h.cults.getRun(run.id)).toMatchObject({ state: 'running', chronicle: null })

    const chronicle = 'é'.repeat(MAX_LONG_TEXT_BYTES / 2)
    expect(await data(call(magos, 'cult_conclude_run', { chronicle }))).toEqual({ concluding: 'run' })
    expect(f.h.cults.getRun(run.id)).toMatchObject({ state: 'shutting_down', chronicle })
  })
})

describe('cult control: a Plan Forge council (c8)', () => {
  async function planForge() {
    const epic = await f.h.pool.get(f.h.rig.repo).createEpic({ title: 'Target plan' })
    return { epic, ...(await startRun({ archetype: 'plan_forge', targetEpicId: epic.id })) }
  }

  it('rejects unknown and occupied slots, and exposes the six roles and their report states', async () => {
    const { run, magos } = await planForge()
    expect(await call(magos, 'cult_summon_acolyte', { mission: 'Review.' })).toMatchObject(refusal('slot_unknown'))
    expect(await call(magos, 'cult_summon_acolyte', { mission: 'Review.', slotId: 'astrology' })).toMatchObject(refusal('slot_unknown'))
    expect(await summon(magos, { name: 'Acolyte Ward', slotId: 'security' })).toMatchObject({ summoned: 'Acolyte Ward' })
    expect(await call(magos, 'cult_summon_acolyte', { mission: 'Review.', slotId: 'security' })).toMatchObject(refusal('slot_occupied'))

    const listed = await data<{ slots: object[]; missingSlots: string[] }>(call(magos, 'cult_list_acolytes'))
    expect(listed.slots).toEqual(STANDARD_WORKER_TYPES.map((slotId) => ({
      slotId, workerType: slotId, required: true, holder: slotId === 'security' ? 'Acolyte Ward' : null, reported: false
    })))
    expect(listed.missingSlots).toEqual([...STANDARD_WORKER_TYPES])
    const ward = memberNamed(run.id, 'Acolyte Ward')
    expect(await data(call(ward, 'cult_status'))).toMatchObject({ role: 'acolyte', workerType: 'security', slotId: 'security', reported: false })
  })

  it('persists a report under the bound member, then refuses to conclude with typed failures', async () => {
    const { epic, run, magos } = await planForge()
    await summon(magos, { name: 'Acolyte Ward', slotId: 'security' })
    const ward = memberNamed(run.id, 'Acolyte Ward')
    const report = 'Security review: the grant scope holds.'
    expect(await data(call(ward, 'cult_conclude_service', { report }))).toEqual({ concluding: 'service', reportStored: true })
    const seen = await f.h.pool.get(run.workDir).getEpic({ epicId: epic.id })
    expect(f.h.cults.listReports(run.id)).toEqual([expect.objectContaining({
      memberChatId: ward.chatId, slotId: 'security', text: report,
      targetRevision: `saved ${seen.currentRevisionNumber ?? 0}, draft ${seen.draftRevision ?? 0}`
    })])
    await eventually(() => actionsOf(ward).includes('shutdown'), 'the conclusion')
    ptyOf(f.h, ward).exit()

    const listed = await data<{ missingSlots: string[] }>(call(magos, 'cult_list_acolytes'))
    expect(listed.missingSlots).toEqual(STANDARD_WORKER_TYPES.filter((slot) => slot !== 'security'))
    expect(await call(magos, 'cult_conclude_run', { chronicle: 'Done.' })).toMatchObject(refusal('reports_missing'))
    for (const code of ['target_stale', 'plan_invalid'] as const) {
      const council = { governs: () => true, status: async () => null, recordSynthesis: () => fail('invalid_state', 'Unused.'), assertConclusion: async () => fail(code, 'The council refuses.') }
      f.dispatch = createCultDispatcher(commandDeps({ council }))
      expect(await call(magos, 'cult_conclude_run', { chronicle: 'Done.' })).toMatchObject(refusal(code))
    }
    expect(f.h.cults.getRun(run.id)).toMatchObject({ state: 'running', chronicle: null })
  })
})
