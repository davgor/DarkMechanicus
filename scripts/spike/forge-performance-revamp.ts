/**
 * The performance-revamp matrix (DM-959): what the person sees (plan view, ticket panel, Kanban board) idle and during a
 * sync, click to paint over CDP, write-lock holds by caller, unchanged-reconcile counters and built-CLI agent latency.
 * Runs inside the profiler's Electron main against the built desktop. Measurement only: no app behaviour is changed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { once } from 'node:events'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserWindow } from 'electron'
import type { ProfileProject } from './forge-performance-fixture'
import type { OwnerAction, OwnerReply } from './forge-performance-owner'
import { absoluteNow, cpuSink, holdSummary, latencyStats, outcomeCounts, type HoldRecord } from './forge-performance-sinks'
import { gitRunsDuring, laneDuring, laneSettled, lastCommandAt, ownerWorkSince, splitWindow, type WindowSplit } from './forge-performance-taps'

export interface Reply<T> { ok: boolean; data: T; error?: { code: string; message: string } }
export interface CliResult { elapsedMs: number; code: number | null; output: unknown }
interface Folder { root: string }

export interface RevampDeps {
  window: BrowserWindow
  /** The bundled `forge-performance-renderer.ts` source, re-injected after every renderer reload. */
  rendererBundle: string
  report(stage: string, detail: Record<string, unknown>): void
  command<T>(folder: Folder, name: string, input?: unknown): Promise<Reply<T>>
  cli(folder: Folder, name: string, input: unknown, token?: string): Promise<CliResult>
  stageChange(project: ProfileProject): string
  owner: { send(action: OwnerAction, project: ProfileProject): Promise<OwnerReply> }
  track(root: string): Promise<void>
  /** Runs the built desktop's own 15-second timers now (`pool.heartbeatAll()`; the Forge tick has no member here). */
  heartbeatNow(): void
}

/** `DM_REVAMP_SMOKE=1` shakes out the native harness quickly: 3 samples, a 10 s agent run, CLI scenarios on any fixture. */
const SMOKE = process.env['DM_REVAMP_SMOKE'] === '1'
const ITERATIONS = SMOKE ? 3 : 30
const AGENT_SECONDS = SMOKE ? 10 : 60
/**
 * `DM_REVAMP_SYNC_EVERY_MS=3500` starts the agent stage's desktop syncs on a fixed schedule (one every 3.5 s; a sync
 * still running at its slot delays the next) instead of back to back, so builds whose syncs finish faster carry the
 * same sync load. `DM_REVAMP_ONLY=cli-agents` runs only that stage, on the 10,000-ticket fixture.
 */
const SYNC_EVERY_MS = Number(process.env['DM_REVAMP_SYNC_EVERY_MS'] ?? 0)
const ONLY_CLI_AGENTS = process.env['DM_REVAMP_ONLY'] === 'cli-agents'
/** Renderer and main read separate monotonic clocks against one wall clock; allow this much skew at window edges. */
const SKEW_MS = 5
const CPU = cpuSink()

type ViewName = 'plan' | 'ticket' | 'kanban'
const VIEW_COMMANDS: Record<ViewName, string[]> = {
  plan: ['getEpic', 'getPlan', 'getRun', 'getCheckpoint', 'listTickets', 'validatePlan', 'getTransfer'],
  ticket: ['getTicket', 'listEvents'],
  kanban: ['listKanbanCards', 'getKanbanOpenCount']
}

function js<T>(deps: RevampDeps, code: string): Promise<T> {
  return deps.window.webContents.executeJavaScript(code) as Promise<T>
}

async function until<T>(probe: () => T | null | undefined | Promise<T | null | undefined>, what: string, limitMs = 60_000): Promise<T> {
  const deadline = absoluteNow() + limitMs
  for (;;) {
    const value = await probe()
    if (value !== null && value !== undefined) return value
    if (absoluteNow() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await delay(5)
  }
}

function viewExpression(view: ViewName, project: ProfileProject): string {
  const root = JSON.stringify(project.root)
  const { epicId, ticketId } = project.sample
  if (view === 'plan') return `dmRevamp.planView(${root}, ${JSON.stringify(epicId)})`
  if (view === 'ticket') return `dmRevamp.ticketPanel(${root}, ${JSON.stringify(epicId)}, ${JSON.stringify(ticketId)})`
  return `dmRevamp.kanbanBoard(${root})`
}

/** One end-to-end load in the renderer, split by the main-process taps. */
interface Sample extends WindowSplit { ms: number }
/** One click to paint; `renderMs` is the last reply's arrival in main until the content painted (IPC hop included). */
interface ClickSample extends Sample { renderMs: number | null }

async function sampleView(deps: RevampDeps, project: ProfileProject, view: ViewName): Promise<Sample> {
  const timing = await js<{ ms: number; startedAt: number; endedAt: number }>(deps, viewExpression(view, project))
  const split = splitWindow(project.root, VIEW_COMMANDS[view], timing.startedAt - SKEW_MS, timing.endedAt + SKEW_MS)
  return { ms: timing.ms, ...split }
}

function summarize(samples: readonly Sample[]) {
  return {
    endToEnd: latencyStats(samples.map((sample) => sample.ms)),
    queueWait: latencyStats(samples.map((sample) => sample.queueWaitMs)),
    ownerRun: latencyStats(samples.map((sample) => sample.ownerRunMs)),
    payloadBytes: latencyStats(samples.map((sample) => sample.payloadBytes)),
    samplesWithOtherOwnerWork: samples.filter((sample) => Object.keys(sample.otherWork).length > 0).length
  }
}

/** Starts one sync of `project`: a changed portable epic state imported by the renderer's reconcile, plus a heartbeat. */
async function startSync(deps: RevampDeps, project: ProfileProject) {
  // Start from a settled lane: the heartbeat the previous sync carried must not import this sample's change.
  await until(() => laneSettled(project.root) || null, 'the previous sync to settle')
  const epicId = deps.stageChange(project)
  const startedAt = absoluteNow()
  const done = deps.command<{ imported: string[] }>(project, 'reconcileRepository')
  await until(() => (ownerWorkSince(project.root, startedAt)['reconcileRepository'] ?? 0) > 0 || null, 'the sync to reach the utility')
  deps.heartbeatNow()
  return { epicId, startedAt, done }
}

async function viewsIdle(deps: RevampDeps, project: ProfileProject): Promise<void> {
  for (const view of ['plan', 'ticket', 'kanban'] as const) {
    CPU.read()
    const samples: Sample[] = []
    for (let index = 0; index < ITERATIONS; index += 1) samples.push(await sampleView(deps, project, view))
    deps.report('revamp-view', { tickets: project.tickets, view, condition: 'idle', ...summarize(samples), cpu: CPU.read(), samples })
  }
}

async function viewsDuringSync(deps: RevampDeps, project: ProfileProject): Promise<void> {
  for (const view of ['plan', 'ticket', 'kanban'] as const) {
    CPU.read()
    const from = absoluteNow()
    const samples: (Sample & { syncMs: number; imported: boolean })[] = []
    for (let index = 0; index < ITERATIONS; index += 1) {
      const sync = await startSync(deps, project)
      const sample = await sampleView(deps, project, view)
      const synced = await sync.done
      if (!synced.ok) throw new Error(`Sync failed: ${JSON.stringify(synced.error)}`)
      samples.push({ ...sample, syncMs: absoluteNow() - sync.startedAt, imported: synced.data.imported.includes(sync.epicId) })
    }
    if (samples.some((sample) => !sample.imported)) throw new Error('A sync did not import its changed epic state.')
    const syncs = latencyStats(samples.map((sample) => sample.syncMs))
    deps.report('revamp-view', {
      tickets: project.tickets, view, condition: 'sync', ...summarize(samples), sync: syncs, lane: laneSummary(from, absoluteNow()), cpu: CPU.read(), samples
    })
  }
}

/** The sync lanes' write-lock holds by caller, and their reconciles: how many re-ran their preparation under the lock. */
function laneSummary(from: number, to: number) {
  const { holds, reconciles } = laneDuring(from, to)
  return {
    holds: holdSummary(holds),
    reconciles: reconciles.length,
    byMode: outcomeCounts(reconciles.map((row) => ({ ok: false, code: row.mode }))),
    reconcileMs: latencyStats(reconciles.map((row) => row.ms)),
    reprepared: reconciles.filter((row) => row.fileReads.locked > 0).length,
    fileReadsUnderLock: latencyStats(reconciles.map((row) => row.fileReads.locked))
  }
}

async function clickAt(deps: RevampDeps, point: { x: number; y: number }): Promise<void> {
  const debug = deps.window.webContents.debugger
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await debug.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
}

async function center(deps: RevampDeps, folderName: string | null, selector: string, text: string | null): Promise<{ x: number; y: number }> {
  const call = `dmRevamp.centerOf(${JSON.stringify(folderName)}, ${JSON.stringify(selector)}, ${JSON.stringify(text)})`
  try {
    return await until(() => js<{ x: number; y: number } | null>(deps, call), selector)
  } catch (error) {
    const shown = await js<unknown>(deps, `dmRevamp.describe(${JSON.stringify(selector)})`)
    throw new Error(`${String(error)} Looking in ${JSON.stringify(folderName)}; the page shows ${JSON.stringify(shown)}`)
  }
}

async function reloadShell(deps: RevampDeps): Promise<void> {
  const loaded = once(deps.window.webContents, 'did-finish-load')
  deps.window.webContents.reload()
  await loaded
  await js(deps, deps.rendererBundle)
}

/** Waits until no desktop command has been received or answered for `ms` (the shell's own polls run every 1.5 s). */
function quiet(ms = 400): Promise<true> {
  return until(() => absoluteNow() - lastCommandAt() > ms || null, 'a quiet IPC window')
}

interface PaintTarget { root: string; folderName: string; epicTitle: string }
/** The plan view counts as painted once a ticket node of its graph is on screen. */
const PLAN_CONTENT = { selector: '.react-flow__node .pg-card', text: null }

/** A click that paints nothing within this long is a failure, reported with what the page shows. */
const PAINT_LIMIT_MS = 30_000

interface Click { point: { x: number; y: number }; content: { selector: string; text: string | null }; commands: readonly string[] }

/** Arms the paint watch for `content` (a selector and optional exact text), clicks `point` and times click to paint. */
async function timedClick(deps: RevampDeps, target: PaintTarget, { point, content, commands }: Click): Promise<ClickSample> {
  await js(deps, `dmRevamp.arm(${JSON.stringify(content.selector)}, ${JSON.stringify(content.text)})`)
  await clickAt(deps, point)
  const paint = await Promise.race([
    js<{ clickAt: number; paintAt: number }>(deps, 'dmRevamp.painted()'),
    delay(PAINT_LIMIT_MS).then(() => null)
  ])
  if (paint === null) {
    const shown = await js<unknown>(deps, `dmRevamp.describe(${JSON.stringify(content.selector)})`)
    throw new Error(`Nothing matching ${JSON.stringify(content)} painted within ${PAINT_LIMIT_MS} ms of a click; the page shows ${JSON.stringify(shown)}`)
  }
  const split = splitWindow(target.root, commands, paint.clickAt - SKEW_MS, paint.paintAt + SKEW_MS)
  const renderMs = split.lastDoneAt === null ? null : paint.paintAt - split.lastDoneAt
  return { ms: paint.paintAt - paint.clickAt, renderMs, ...split }
}

/** One cold plan open: leave the epic, reload the renderer (dropping its in-memory view cache), then click the epic row. */
async function planClick(deps: RevampDeps, target: PaintTarget): Promise<ClickSample> {
  await clickAt(deps, await center(deps, target.folderName, '.folder-main', null))
  await reloadShell(deps)
  const row = await revealEpic(deps, target)
  await quiet()
  return timedClick(deps, target, { point: row, content: PLAN_CONTENT, commands: VIEW_COMMANDS.plan })
}

/**
 * The click point of the target epic's sidebar row. A reloaded sidebar loads its epic list after the folder row, and
 * shows the Completed bucket (where the fixture epic is) collapsed: expand collapsed buckets until the row appears.
 */
async function revealEpic(deps: RevampDeps, target: PaintTarget): Promise<{ x: number; y: number }> {
  const folder = JSON.stringify(target.folderName)
  const find = async (): Promise<{ x: number; y: number } | null> => {
    const row = await js<{ x: number; y: number } | null>(deps, `dmRevamp.centerOf(${folder}, '.epic-row-title', ${JSON.stringify(target.epicTitle)})`)
    if (row !== null) return row
    const collapsed = await js<{ x: number; y: number } | null>(deps, `dmRevamp.centerOf(${folder}, '.bucket-header[aria-expanded="false"]', null)`)
    if (collapsed !== null) {
      await clickAt(deps, collapsed)
      await delay(50)
    }
    return null
  }
  try {
    return await until(find, 'the epic row')
  } catch (error) {
    const shown = await js<unknown>(deps, `dmRevamp.describe('.epic-row-title')`)
    throw new Error(`${String(error)} Looking in ${folder}; the page shows ${JSON.stringify(shown)}`)
  }
}

async function ticketClicks(deps: RevampDeps, target: PaintTarget): Promise<ClickSample[]> {
  // Open the epic (untimed: planClicks times this) so its graph's ticket nodes can be clicked.
  await timedClick(deps, target, { point: await revealEpic(deps, target), content: PLAN_CONTENT, commands: VIEW_COMMANDS.plan })
  const samples: ClickSample[] = []
  let last = ''
  for (let index = 0; index < ITERATIONS; index += 1) {
    const ticket = await until(async () => (await js<{ id: string; title: string; x: number; y: number }[]>(deps, 'dmRevamp.visibleTickets()'))
      .find((row) => row.id !== last), 'a visible ticket node')
    last = ticket.id
    await quiet()
    samples.push(await timedClick(deps, target, { point: ticket, content: { selector: '.tp .tp-title', text: ticket.title }, commands: ['getTicket'] }))
  }
  return samples
}

async function clickToPaint(deps: RevampDeps, target: PaintTarget, tickets: number | 'real-store'): Promise<void> {
  deps.window.webContents.debugger.attach('1.3')
  try {
    // A folder tracked through `window.dm.pickFolder()` (not the sidebar's button) shows in the sidebar after a reload.
    await reloadShell(deps)
    for (const [view, run] of [['plan', () => planClicks(deps, target)], ['ticket', () => ticketClicks(deps, target)]] as const) {
      CPU.read()
      const samples = await run()
      const renders = samples.flatMap((sample) => sample.renderMs === null ? [] : [sample.renderMs])
      deps.report('revamp-click-to-paint', {
        tickets, view, ...summarize(samples), render: latencyStats(renders), cpu: CPU.read(), samples
      })
    }
  } finally {
    deps.window.webContents.debugger.detach()
  }
}

async function planClicks(deps: RevampDeps, target: PaintTarget): Promise<ClickSample[]> {
  const samples: ClickSample[] = []
  for (let index = 0; index < ITERATIONS; index += 1) samples.push(await planClick(deps, target))
  return samples
}

function ownerRow(reply: OwnerReply) {
  return { elapsedMs: reply.elapsedMs, reads: reply.reads, writeTransactions: reply.holds.length, holds: holdSummary(reply.holds) }
}

/** Unchanged-reconcile counters and write-lock holds by caller, from a profiler utility with the `Db` hold observer. */
async function holdsAndCounters(deps: RevampDeps, project: ProfileProject): Promise<void> {
  const { owner } = deps
  const opened = await owner.send('open', project)
  await owner.send('heartbeat', project)
  const automatic = await owner.send('heartbeat', project)
  const explicit = await owner.send('reconcile', project)
  deps.stageChange(project)
  const changed = await owner.send('reconcile', project)
  const command = await owner.send('mutate', project)
  await owner.send('close', project)
  const all: HoldRecord[] = [opened, automatic, explicit, changed, command].flatMap((reply) => reply.holds)
  deps.report('revamp-unchanged-reconcile', { tickets: project.tickets, automaticHeartbeat: ownerRow(automatic), explicitReconcile: ownerRow(explicit) })
  deps.report('revamp-lock-holds', {
    tickets: project.tickets, byCaller: holdSummary(all), open: ownerRow(opened), changedReconcile: ownerRow(changed),
    commandAndFlush: ownerRow(command), holds: all
  })
}

function cliOutcome(result: CliResult): { ok: boolean; code: string | null } {
  const output = result.output as Reply<unknown> | null
  return output !== null && typeof output === 'object' && 'ok' in output
    ? { ok: output.ok === true, code: output.ok === true ? null : output.error?.code ?? 'no_code' }
    : { ok: false, code: 'no_json' }
}

async function cliWallTimes(deps: RevampDeps, project: ProfileProject): Promise<void> {
  for (const [name, input] of [['list_kanban_cards', {}], ['get_epic', { epicId: project.sample.epicId }]] as const) {
    CPU.read()
    const runs: CliResult[] = []
    for (let index = 0; index < 10; index += 1) runs.push(await deps.cli(project, name, input))
    deps.report('revamp-cli-call', {
      tickets: project.tickets, name, wall: latencyStats(runs.map((run) => run.elapsedMs)),
      outcomes: outcomeCounts(runs.map(cliOutcome)), cpu: CPU.read()
    })
  }
}

interface Agent { token: string; attemptId: string; claimToken: string }
interface AgentCall { agent: number; name: string; ms: number; ok: boolean; code: string | null }

async function prepareAgent(deps: RevampDeps, project: ProfileProject, cardId: string): Promise<Agent> {
  const issued = await deps.command<{ token: string }>(project, 'issueGrant', { role: 'orchestrator', label: 'Revamp CLI agent' })
  if (!issued.ok) throw new Error(JSON.stringify(issued.error))
  const token = issued.data.token
  const launched = await deps.cli(project, 'launch_kanban_cards', { cardIds: [cardId] }, token)
  if (!cliOutcome(launched).ok) throw new Error(`Agent card launch failed: ${JSON.stringify(launched.output)}`)
  const claimed = await deps.cli(project, 'claim_kanban_card', { cardId, leaseSeconds: 600 }, token)
  const packet = (claimed.output as Reply<{ attemptId: string; claimToken: string }>).data
  if (!cliOutcome(claimed).ok || !packet?.claimToken) throw new Error('Agent card claim issued no token.')
  return { token, attemptId: packet.attemptId, claimToken: packet.claimToken }
}

function agentMix(project: ProfileProject, agent: Agent, commentEpicId: string, step: number): [string, unknown] {
  const { epicId, ticketId } = project.sample
  switch (step % 4) {
    case 0: return ['list_kanban_cards', {}]
    case 1: return ['get_ticket', { epicId, ticketId, view: 'saved' }]
    case 2: return ['heartbeat_kanban_card', { attemptId: agent.attemptId, claimToken: agent.claimToken, progressNote: 'Revamp agent loop' }]
    default: return ['add_comment', { epicId: commentEpicId, body: `Revamp agent comment ${step}`, idempotencyKey: `${agent.attemptId}-${step}` }]
  }
}

async function agentLoop(deps: RevampDeps, input: { project: ProfileProject; agent: Agent; index: number; commentEpicId: string; until: number }) {
  const calls: AgentCall[] = []
  for (let step = input.index; absoluteNow() < input.until; step += 1) {
    const [name, args] = agentMix(input.project, input.agent, input.commentEpicId, step)
    const result = await deps.cli(input.project, name, args, input.agent.token).catch((): CliResult => ({ elapsedMs: 0, code: null, output: null }))
    calls.push({ agent: input.index, name, ms: result.elapsedMs, ...cliOutcome(result) })
  }
  return calls
}

/** Waits for the next fixed sync slot (`DM_REVAMP_SYNC_EVERY_MS`); returns whether the slot had already passed. */
async function awaitSlot(slot: number): Promise<boolean> {
  const wait = slot - absoluteNow()
  if (wait > 0) await delay(wait)
  return wait <= 0
}

async function syncLoop(deps: RevampDeps, project: ProfileProject, until: number) {
  const durations: number[] = []
  const failures: string[] = []
  let late = 0
  for (let slot = absoluteNow(); absoluteNow() < until; slot += SYNC_EVERY_MS) {
    // A sync still running at its slot delays the next one; the schedule then restarts from when it finished.
    if (SYNC_EVERY_MS > 0 && await awaitSlot(slot)) late += 1
    if (absoluteNow() >= until) break
    const sync = await startSync(deps, project)
    const result = await sync.done
    durations.push(absoluteNow() - sync.startedAt)
    if (!result.ok) failures.push(result.error?.code ?? 'unknown')
    slot = Math.max(slot, absoluteNow() - SYNC_EVERY_MS)
  }
  return { everyMs: SYNC_EVERY_MS || 'closed-loop', late, syncs: latencyStats(durations), failures: outcomeCounts(failures.map((code) => ({ ok: false, code }))) }
}

interface PhaseRow {
  at: number; command: string | null; marks: Record<string, number>; phases: Record<string, Record<string, number>>
  reconciles?: Record<string, number>[]; gates?: { automatic: boolean; current: boolean[]; stale: boolean[]; applied: number }[]
}

/** The CLI processes' phase timings (`cli-phase-timing.cjs`, `DM_CLI_PHASE_LOG`) that exited between `from` and `to`. */
function cliPhases(from: number, to: number) {
  const file = process.env['DM_CLI_PHASE_LOG']
  if (!file || !existsSync(file)) return null
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as PhaseRow).filter((row) => row.at >= from && row.at <= to)
  const names = [...new Set(rows.flatMap((row) => Object.keys(row.phases)))]
  const stat = (pick: (row: PhaseRow) => number) => latencyStats(rows.map(pick))
  return {
    processes: rows.length,
    // Process start to the preload, the preload to the workspace open (module load), the open, and exit after close.
    startToPreload: stat((row) => row.marks['preload'] ?? 0),
    moduleLoad: stat((row) => (row.marks['open'] ?? 0) - (row.marks['preload'] ?? 0)),
    total: stat((row) => row.marks['exit'] ?? 0),
    phases: Object.fromEntries(names.map((name) => [name, {
      wall: stat((row) => row.phases[name]?.['ms'] ?? 0),
      gitMs: stat((row) => row.phases[name]?.['gitMs'] ?? 0),
      gitRuns: rows.reduce((sum, row) => sum + (row.phases[name]?.['gitN'] ?? 0), 0),
      gitVerbs: rows.reduce<Record<string, number>>((all, row) => {
        for (const [verb, count] of Object.entries((row.phases[name]?.['git'] ?? {}) as unknown as Record<string, number>)) all[verb] = (all[verb] ?? 0) + count
        return all
      }, {}),
      writerWaitMs: stat((row) => row.phases[name]?.['beginWaitMs'] ?? 0),
      writes: rows.reduce((sum, row) => sum + (row.phases[name]?.['beginN'] ?? 0), 0),
      busyErrors: rows.reduce((sum, row) => sum + (row.phases[name]?.['busy'] ?? 0), 0),
      holdMs: stat((row) => row.phases[name]?.['holdMs'] ?? 0)
    }])),
    // Each automatic open's fingerprint gate: how often its first check hit, and how its reconciles ended.
    gates: outcomeCounts(rows.flatMap((row) => row.gates ?? []).map((gate) => ({
      ok: false, code: `${gate.automatic ? 'auto' : 'explicit'}:first=${gate.current[0] ?? 'none'}:recheck=${gate.current.slice(1).join('/') || 'none'}:stale=${gate.stale.join('/') || 'none'}:applied=${gate.applied}`
    }))),
    imported: rows.reduce((sum, row) => sum + (row.reconciles ?? []).reduce((total, result) => total + (result['imported'] ?? 0), 0), 0)
  }
}

async function cliAgents(deps: RevampDeps, project: ProfileProject): Promise<void> {
  const epic = await deps.command<{ id: string }>(project, 'createEpic', { title: 'Revamp agent comments' })
  if (!epic.ok) throw new Error(JSON.stringify(epic.error))
  const agents: Agent[] = []
  for (const cardId of project.agentCardIds) agents.push(await prepareAgent(deps, project, cardId))
  CPU.read()
  const from = absoluteNow()
  const end = from + AGENT_SECONDS * 1000
  const [sync, ...perAgent] = await Promise.all([
    syncLoop(deps, project, end),
    ...agents.map((agent, index) => agentLoop(deps, { project, agent, index, commentEpicId: epic.data.id, until: end }))
  ])
  const calls = perAgent.flat()
  const names = [...new Set(calls.map((call) => call.name))]
  deps.report('revamp-cli-agents', {
    tickets: project.tickets, agents: agents.length, seconds: AGENT_SECONDS, calls: calls.length, outcomes: outcomeCounts(calls),
    byCommand: Object.fromEntries(names.map((name) => {
      const rows = calls.filter((call) => call.name === name)
      return [name, { outcomes: outcomeCounts(rows), wall: latencyStats(rows.map((row) => row.ms)) }]
    })),
    desktopSync: sync, lane: laneSummary(from, absoluteNow()), cliPhases: cliPhases(from, absoluteNow()), cpu: CPU.read()
  })
}

/** How long the desktop sits idle on the selected 10,000-ticket folder while its footer status refreshes. */
const FOOTER_IDLE_MS = SMOKE ? 15_000 : 60_000

/** The checkout's index stamp and HEAD as `storage.ts` keys its cached `git status` count (size, mtime, inode; branch and commit). */
function checkoutStamp(root: string): string {
  const index = statSync(join(root, '.git', 'index'), { throwIfNoEntry: false })
  const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim()
  const ref = head.startsWith('ref: ') ? join(root, '.git', ...head.slice(5).split('/')) : null
  const commit = ref !== null && existsSync(ref) ? readFileSync(ref, 'utf8').trim() : head
  return JSON.stringify([index === undefined ? null : [index.size, index.mtimeMs, index.ino], head, commit])
}

/**
 * The footer's storage-status refreshes with the desktop idle on `project` (selected in the sidebar) for
 * `FOOTER_IDLE_MS`: the `getStorageStatus` calls, the git processes the desktop ran (`GIT_TRACE`), and how often the
 * checkout's index stamp or HEAD changed (sampled every 100 ms). Measurement only.
 */
async function footerIdle(deps: RevampDeps, project: ProfileProject): Promise<void> {
  // Select the folder so the footer describes it. `clickToPaint` detached its CDP session; attach one for this click.
  deps.window.webContents.debugger.attach('1.3')
  try {
    await clickAt(deps, await center(deps, basename(project.root), '.folder-main', null))
  } finally {
    deps.window.webContents.debugger.detach()
  }
  await until(() => laneSettled(project.root) || null, 'the last sync to settle')
  const stamps = [checkoutStamp(project.root)]
  const from = absoluteNow()
  const sampler = setInterval(() => {
    const stamp = checkoutStamp(project.root)
    if (stamp !== stamps.at(-1)) stamps.push(stamp)
  }, 100)
  await delay(FOOTER_IDLE_MS)
  clearInterval(sampler)
  const to = absoluteNow()
  const status = splitWindow(project.root, ['getStorageStatus'], from, to)
  deps.report('revamp-footer-idle', {
    tickets: project.tickets, seconds: FOOTER_IDLE_MS / 1000, storageStatusCalls: status.calls, stampChanges: stamps.length - 1,
    gitRuns: gitRunsDuring(from, to), otherWork: status.otherWork
  })
}

/** The matrix for one generated fixture, after the profiler tracked it cold. */
export async function revampProject(deps: RevampDeps, project: ProfileProject): Promise<void> {
  await js(deps, deps.rendererBundle)
  if (ONLY_CLI_AGENTS) return cliAgents(deps, project)
  await viewsIdle(deps, project)
  await viewsDuringSync(deps, project)
  // The sidebar shows the title the desktop imported (the portable record's), so ask the desktop for it.
  const epic = await deps.command<{ title: string }>(project, 'getEpic', { epicId: project.sample.epicId })
  if (!epic.ok) throw new Error(JSON.stringify(epic.error))
  await clickToPaint(deps, { root: project.root, folderName: basename(project.root), epicTitle: epic.data.title }, project.tickets)
  if (project.tickets === 10_000 || SMOKE) await footerIdle(deps, project)
  await holdsAndCounters(deps, project)
  if (project.tickets === 10_000 || SMOKE) {
    await cliWallTimes(deps, project)
    await cliAgents(deps, project)
  }
}

interface EpicRow { id: string; title: string; ticketCount: number; currentRevisionId: string | null }

/** Click to paint on a temporary copy of a real ticket store: its largest saved epic and that epic's tickets. */
export async function revampRealStore(deps: RevampDeps, root: string): Promise<void> {
  await deps.track(root)
  const started = absoluteNow()
  const epics = await deps.command<EpicRow[]>({ root }, 'listEpics')
  if (!epics.ok) throw new Error(JSON.stringify(epics.error))
  deps.report('revamp-real-store-open', { firstCommandMs: absoluteNow() - started, epics: epics.data.length })
  const saved = epics.data.filter((epic) => epic.currentRevisionId !== null).sort((a, b) => b.ticketCount - a.ticketCount)
  const epic = saved[0]
  if (epic === undefined) throw new Error('The real store copy has no saved epic.')
  // clickToPaint reloads the shell, so the sidebar lists the copy.
  await clickToPaint(deps, { root, folderName: basename(root), epicTitle: epic.title }, 'real-store')
  deps.report('revamp-real-store-epic', { tickets: epic.ticketCount })
}
