/**
 * Supervises cult runs over time, one supervisor per app (`docs/design/cults.md`, sections 1 to 3 and 7). It drives the
 * pure run state machine (`runState.ts`, persisted by `cultStore.ts`) and the launcher (`cultLauncher.ts`):
 *
 * - **Timer.** One per running run, on an injectable clock. It counts running time only: it fires at the run's
 *   `remainingMs` and is cancelled while paused (the store banks the running time), then rescheduled from the frozen
 *   remainder. A delay past `setTimeout`'s maximum is re-armed in chunks (`runTimer.ts`); an unlimited run has none.
 * - **Pause** interrupts every member's turn through its trusted control file (`cultControl.ts`: the extension calls
 *   `ctx.abort()` and shows a fixed "paused" notice); the run's standing wake is closed (`isWakeOpen`) while it is not
 *   running. **Resume** sends the fixed "resumed" reminder.
 * - **Shutdown** (Stop, expiry, or the Magos concluding the run): `shutting_down`, the Magos is told to wind down and
 *   every acolyte to conclude; acolytes that conclude end gracefully within the acolyte grace, after which the rest are
 *   asked to exit; the Magos then has its window to write the chronicle and conclude, after which it is asked to exit;
 *   at the backstop (grace + window + 1 minute) every member still running is killed. The run then ends with its
 *   reason, its pending petitions denied (by the store) and every petition upgrade revoked.
 * - **Kill now** ends every member at once (`killed`). **Quit** (`dispose`) does the same with `interrupted`, and
 *   **startup** (`reconcileOnStartup`) marks every run left active `interrupted`, ends any member process that
 *   survived (`cultLedger.ts`) and revokes the upgrades it left.
 * - A member whose terminal exits on its own has `left`; when that is the Magos of a running or paused run, every
 *   acolyte is killed and the run ends `failed`.
 * - **The standing wake** closes the moment a run leaves `running` (pause, shutdown, Kill now, a failure, quit): every
 *   `onWakeClose` listener (the cult wake disarming its members' armed wakes) is awaited before a member is told or
 *   ended, so a wake not yet taken never fires once the run has left `running`.
 * - Every change is told as `cult_changed` with the run's snapshot.
 */
import { EventEmitter } from 'node:events'
import { DomainError, fail } from '../../core/errors'
import {
  type CultMemberView,
  type CultPetitionView,
  type CultRunView,
  LIVE_MEMBER_STATES,
  type PetitionInput,
  type RunStartInput
} from '../../shared/cults/cult'
import type { MemberActivity } from '../../shared/cults/cultApi'
import { type AbortReason, backstopMs, isExpired, remainingMs, type ShutdownReason } from '../../shared/cults/runState'
import { ompFilePaths } from '../terminals/ompSession'
import type { TerminalSessions } from '../terminals/terminalSessions'
import type { AcolyteRequest, CultLauncher, LaunchedMember } from './cultLauncher'
import type { CultControl, CultControlRequest } from './cultControl'
import { type CultLedger, endLeftover, type LedgerGrant, type LeftoverProcesses } from './cultLedger'
import type { CultStore } from './cultStore'
import { grantAllowSave, grantFolderAccess, revokeLeftUpgrade, revokeUpgrade, type UpgradeDeps, type UpgradedMagos } from './cultUpgrades'
import { createMemberActivity, type MemberActivityTracker } from './memberActivity'
import { schedule, type SupervisorClock, systemClock } from './runTimer'

export const CULT_CHANGED = 'cult_changed'

/** What `cult_changed` carries: the run as it is now, with its members (each with its live activity) and petitions. */
export interface CultRunSnapshot {
  run: CultRunView
  members: (CultMemberView & { activity: MemberActivity | null })[]
  petitions: CultPetitionView[]
}

/** A run's overrides of its cult's defaults. */
type RunOptions = Omit<RunStartInput, 'workDir'>

interface CultSupervisorDeps {
  cults: Pick<CultStore, 'getRun' | 'transitionRun' | 'listMembers' | 'updateMember' | 'createPetition' | 'decidePetition' | 'getPetition' | 'listPetitions' | 'appendEvent' | 'activeRunsOnStartup' | 'slotCoverage' | 'raiseCap'>
  launcher: Pick<CultLauncher, 'launch' | 'startAcolyte' | 'endMember'>
  /** `onLaunch` lets a member relaunched while its run is paused be told the paused state again. */
  terminals: Pick<TerminalSessions, 'onExit' | 'isRunning' | 'attachGrant' | 'detachGrant'> & Partial<Pick<TerminalSessions, 'onLaunch'>>
  control: CultControl
  ledger: CultLedger
  grants: UpgradeDeps['grants']
  chatStore: UpgradeDeps['chatStore']
  /** Revokes a grant through the desktop's own session in its folder (what a crash left). */
  revokeGrantIn: UpgradeDeps['revokeGrantIn']
  /** The tracked folders (never a sanctum): what a folder-access petition may name. */
  folders: { resolve(path: string): string | null }
  leftovers: LeftoverProcesses
  userData: string
  clock?: SupervisorClock
  /** The member activity poll's clock; the supervisor's own by default. */
  activityClock?: SupervisorClock
  onError?: (error: unknown) => void
}

export interface CultSupervisor {
  /** Creates the run, prepares its workspace and starts its Magos; the run is `running` once the Magos runs. */
  start(cultId: string, options?: RunOptions): Promise<CultRunSnapshot>
  pause(runId: string): Promise<CultRunSnapshot>
  resume(runId: string): Promise<CultRunSnapshot>
  /** Graceful shutdown, `stopped`. */
  stop(runId: string): Promise<CultRunSnapshot>
  killNow(runId: string): Promise<CultRunSnapshot>
  /** Refused unless the run is running, or past its cap; a missing or taken name is generated. */
  addAcolyte(runId: string, request: AcolyteRequest): Promise<CultMemberView>
  /**
   * The Magos's own summon (`cult_summon_acolyte`), refused with a typed code: `run_paused`, `run_ending`,
   * `cap_reached`, `name_taken` (never renamed), and in a cult with a roster `slot_unknown` or `slot_occupied`.
   */
  summonAcolyte(runId: string, request: AcolyteRequest): Promise<CultMemberView>
  /** The live member a chat is, with its supervised run; null for any other chat. */
  memberOf(chatId: string): { run: CultRunView; member: CultMemberView } | null
  /** The Magos concluded the run: its graceful shutdown starts (`completed`); `run_ending` once it has ended. */
  concludeRun(runId: string): Promise<CultRunSnapshot>
  /** Refused unless the run is running. */
  dismissAcolyte(runId: string, chatId: string): Promise<CultMemberView>
  /** A member concluded: an acolyte is ended gracefully; the Magos concluding winds the run down (`completed`). */
  concludeMember(runId: string, chatId: string): Promise<CultMemberView>
  /** `fromChatId`: the member who raised it (the Magos), named on its event. A folder must be a tracked folder. */
  petition(runId: string, input: PetitionInput, fromChatId?: string): CultPetitionView
  /** The decision is applied to the running Magos live, then told to it as a fixed reminder. */
  decidePetition(petitionId: string, approve: boolean, granted?: number): Promise<CultPetitionView>
  /** Whether the run's standing wake is open: it is supervised here, running and not being ended. */
  isWakeOpen(runId: string): boolean
  snapshot(runId: string): CultRunSnapshot
  /** Startup: every run left active is marked `interrupted`; surviving member processes end; left upgrades are revoked. */
  reconcileOnStartup(): Promise<CultRunView[]>
  /** Quit: every supervised run ends `interrupted`, its members ended and its upgrades revoked. */
  dispose(): Promise<void>
  /** True while a supervised run is active. */
  busy(): boolean
  on(event: typeof CULT_CHANGED, listener: (snapshot: CultRunSnapshot) => void): () => void
  /**
   * Work the supervisor awaits the moment a run's standing wake closes, before it tells or ends a member; it gets the
   * run's member chat ids. A listener that fails is reported, never in the lifecycle's way.
   */
  onWakeClose(listener: WakeCloser): () => void
  /** Raises a running or paused run's acolyte cap, told as a change. */
  raiseCap(runId: string, cap: number): CultRunSnapshot
  /** Tells the run's current snapshot as a change (a Magos command recorded something the snapshot shows). */
  changed(runId: string): void
  /**
   * Ends an active run gracefully (Stop, unless it is already shutting down) and resolves once it has ended and settled:
   * no file of its members is still being written. A run that has ended but is still settling is waited for alone.
   */
  endRun(runId: string): Promise<void>
}

type WakeCloser = (memberChatIds: string[]) => Promise<void>

/** A run this supervisor drives. */
interface Supervised {
  cancelTimer: (() => void) | null
  shutdownTimers: (() => void)[]
  /** Set once the run is being killed, interrupted or failed: member exits are expected, not failures. */
  ending: boolean
  /** Summons, dismissals and decisions of the run, one at a time (the cap check and the start go together). */
  queue: Promise<unknown>
}

interface State {
  deps: CultSupervisorDeps
  clock: SupervisorClock
  onError: (error: unknown) => void
  upgrades: UpgradeDeps
  runs: Map<string, Supervised>
  /** Member chat id → its supervised run. */
  chatRuns: Map<string, string>
  events: EventEmitter
  wakeClosers: Set<WakeCloser>
  /** Each live member's working flag and last tool call, polled while its run is supervised. */
  activity: MemberActivityTracker
  /** Runs that have ended and are still settling (`settle`): run id → its settling, until no file of a member is being written. */
  settling: Map<string, Promise<void>>
}

const isLive = (member: Pick<CultMemberView, 'state'>): boolean => LIVE_MEMBER_STATES.includes(member.state)

function requireRun(s: State, runId: string): CultRunView {
  return s.deps.cults.getRun(runId) ?? fail('not_found', `No cult run ${runId}.`)
}

function supervised(s: State, runId: string): Supervised {
  requireRun(s, runId)
  return s.runs.get(runId) ?? fail('invalid_state', `Cult run ${runId} is not supervised by this app; it has ended or was interrupted.`)
}

function snapshot(s: State, runId: string): CultRunSnapshot {
  const members = s.deps.cults.listMembers(runId).map((member) => ({ ...member, activity: isLive(member) ? s.activity.of(member.chatId) : null }))
  return { run: requireRun(s, runId), members, petitions: s.deps.cults.listPetitions(runId) }
}

function emit(s: State, runId: string): CultRunSnapshot {
  const now = snapshot(s, runId)
  try {
    s.events.emit(CULT_CHANGED, now)
  } catch (error) {
    s.onError(error)
  }
  return now
}

function liveMembers(s: State, runId: string): CultMemberView[] {
  return s.deps.cults.listMembers(runId).filter(isLive)
}

function magosOf(s: State, runId: string): CultMemberView | null {
  return liveMembers(s, runId).find((member) => member.role === 'magos') ?? null
}

/** Sends one control action to members; a write that fails is reported, never in the lifecycle's way. */
async function tell(s: State, members: readonly CultMemberView[], request: (member: CultMemberView) => CultControlRequest): Promise<void> {
  await Promise.all(members.map((member) => s.deps.control.send(member.chatId, request(member)).catch(s.onError)))
}

/** The run's standing wake closed: every listener has finished before a member is told or ended. */
async function closeWake(s: State, runId: string): Promise<void> {
  const chatIds = s.deps.cults.listMembers(runId).map((member) => member.chatId)
  await Promise.all([...s.wakeClosers].map(async (close) => {
    try {
      await close(chatIds)
    } catch (error) {
      s.onError(error)
    }
  }))
}

function addWakeCloser(s: State, closer: WakeCloser): () => void {
  s.wakeClosers.add(closer)
  return () => {
    s.wakeClosers.delete(closer)
  }
}

/** Runs `work` after the run's earlier queued work. */
function queued<T>(entry: Supervised, work: () => Promise<T>): Promise<T> {
  const next = entry.queue.catch(() => {}).then(work)
  entry.queue = next
  return next
}

// --- the timer ---------------------------------------------------------------------------------------------------

function arm(s: State, runId: string): void {
  const entry = s.runs.get(runId)
  const run = s.deps.cults.getRun(runId)
  entry?.cancelTimer?.()
  if (entry === undefined || run?.state !== 'running') return
  const left = remainingMs(run, s.clock.now())
  entry.cancelTimer = left === null ? null : schedule(s.clock, left, () => expire(s, runId))
}

function expire(s: State, runId: string): void {
  const entry = s.runs.get(runId)
  const run = s.deps.cults.getRun(runId)
  if (entry === undefined || run?.state !== 'running') return
  entry.cancelTimer = null
  // A clock that fired a little early is waited out again; only a used-up limit expires the run.
  if (!isExpired(run, s.clock.now())) return arm(s, runId)
  void beginShutdown(s, runId, 'expired').catch(s.onError)
}

// --- members -----------------------------------------------------------------------------------------------------

/** Tracks a member whose terminal just started: its exit watched, its state active, its process in the ledger. */
async function track(s: State, runId: string, launched: LaunchedMember): Promise<CultMemberView> {
  const chatId = launched.chat.id
  if (launched.start.state !== 'running') {
    s.deps.cults.updateMember(runId, chatId, { state: 'left' })
    fail('internal_error', `${launched.member.displayName} did not start: ${launched.start.message}`)
  }
  s.chatRuns.set(chatId, runId)
  s.activity.track(runId, chatId)
  const member = s.deps.cults.updateMember(runId, chatId, { state: 'active' })
  const recording = s.deps.ledger.addProcess({ runId, chatId, pid: launched.start.pid })
  // It may have exited before it was watched.
  if (!s.deps.terminals.isRunning(chatId)) memberExited(s, chatId)
  await recording
  await resendPause(s, runId, chatId)
  return member
}

/**
 * A member launched while its run is paused: actions sent while it had no running launch were dropped
 * (`cultControl.ts`), so its new launch is told the paused state now.
 */
async function resendPause(s: State, runId: string, chatId: string): Promise<void> {
  if (s.deps.cults.getRun(runId)?.state !== 'paused' || !s.deps.terminals.isRunning(chatId)) return
  const member = liveMembers(s, runId).find((candidate) => candidate.chatId === chatId)
  if (member !== undefined) await tell(s, [member], () => ({ action: 'interrupt' }))
}

/** A member's chat launched again (a new generation) while it is still a member of a supervised run. */
function memberLaunched(s: State, chatId: string): void {
  const runId = s.chatRuns.get(chatId)
  if (runId !== undefined && s.runs.has(runId)) void resendPause(s, runId, chatId).catch(s.onError)
}

function requireLiveMember(s: State, runId: string, chatId: string): CultMemberView {
  const member = liveMembers(s, runId).find((candidate) => candidate.chatId === chatId)
  if (member === undefined) fail('not_found', `No live member ${chatId} in cult run ${runId}.`)
  return member
}

function requireRunning(run: CultRunView, what: string): void {
  if (run.state !== 'running') fail('invalid_state', `Cannot ${what} while the cult run is ${run.state.replace('_', ' ')}.`)
}

/** The typed refusal of a member's command that needs a running run. */
export function requireRunningRun(run: Pick<CultRunView, 'state'>): void {
  if (run.state === 'paused') fail('run_paused', 'The cult run is paused.')
  if (run.state === 'shutting_down' || run.state === 'ended') fail('run_ending', 'The cult run is ending.')
  if (run.state !== 'running') fail('invalid_state', 'The cult run has not started yet.')
}

/** A cult with a roster: every acolyte holds a free slot of it, unless it serves as a run worker type. */
function requireFreeSlot(s: State, runId: string, request: AcolyteRequest): void {
  const slots = s.deps.cults.slotCoverage(runId)
  if (request.slotId == null) {
    if (slots.length > 0 && request.runWorkerTypeId == null) fail('slot_unknown', 'This cult has a roster: name the slot the acolyte fills.')
    return
  }
  const slot = slots.find((candidate) => candidate.slotId === request.slotId) ?? fail('slot_unknown', `The cult has no roster slot ${request.slotId}.`)
  if (slot.liveMemberChatIds.length > 0) fail('slot_occupied', `A live acolyte already holds the slot ${slot.slotId}.`)
}

async function summonAcolyte(s: State, runId: string, request: AcolyteRequest): Promise<CultMemberView> {
  const run = requireRun(s, runId)
  requireRunningRun(run)
  const members = s.deps.cults.listMembers(runId)
  const acolytes = members.filter((member) => member.role === 'acolyte' && isLive(member)).length
  if (acolytes >= run.cap) fail('cap_reached', `The cult run is at its cap of ${run.cap} acolytes.`)
  const wanted = request.name?.trim().toLowerCase() ?? ''
  if (wanted !== '' && members.some((member) => member.displayName.toLowerCase() === wanted)) fail('name_taken', `The name ${request.name} is taken in this run.`)
  requireFreeSlot(s, runId, request)
  const member = await track(s, runId, await s.deps.launcher.startAcolyte(run, request))
  emit(s, runId)
  return member
}

function memberOf(s: State, chatId: string): { run: CultRunView; member: CultMemberView } | null {
  const runId = s.chatRuns.get(chatId)
  if (runId === undefined || !s.runs.has(runId)) return null
  const member = liveMembers(s, runId).find((candidate) => candidate.chatId === chatId)
  return member === undefined ? null : { run: requireRun(s, runId), member }
}

async function concludeRun(s: State, runId: string): Promise<CultRunSnapshot> {
  const run = requireRun(s, runId)
  if (run.state === 'ended') fail('run_ending', 'The cult run has ended.')
  return run.state === 'shutting_down' ? snapshot(s, runId) : beginShutdown(s, runId, 'completed')
}

async function addAcolyte(s: State, runId: string, request: AcolyteRequest): Promise<CultMemberView> {
  const run = requireRun(s, runId)
  requireRunning(run, 'summon an acolyte')
  const members = s.deps.cults.listMembers(runId)
  const acolytes = members.filter((member) => member.role === 'acolyte' && isLive(member)).length
  if (acolytes >= run.cap) fail('capacity_exceeded', `The cult run is at its cap of ${run.cap} acolytes.`)
  const wanted = request.name?.trim().toLowerCase()
  const taken = wanted !== undefined && members.some((member) => member.displayName.toLowerCase() === wanted)
  const member = await track(s, runId, await s.deps.launcher.startAcolyte(run, { ...request, name: taken ? undefined : request.name }))
  emit(s, runId)
  return member
}

/** Records the member's leaving state, then ends its terminal; `graceful` asks it to exit before it is killed. */
async function endMember(s: State, runId: string, member: CultMemberView, change: { state: 'concluded' | 'dismissed' | 'left'; graceful: boolean }): Promise<CultMemberView> {
  const left = isLive(member) ? s.deps.cults.updateMember(runId, member.chatId, { state: change.state }) : member
  await s.deps.launcher.endMember(member.chatId, { graceful: change.graceful })
  return left
}

async function dismissAcolyte(s: State, runId: string, chatId: string): Promise<CultMemberView> {
  requireRunning(requireRun(s, runId), 'dismiss an acolyte')
  const member = requireLiveMember(s, runId, chatId)
  if (member.role !== 'acolyte') fail('invalid_input', 'Only an acolyte can be dismissed.')
  const dismissed = await endMember(s, runId, member, { state: 'dismissed', graceful: true })
  emit(s, runId)
  return dismissed
}

async function concludeMember(s: State, runId: string, chatId: string): Promise<CultMemberView> {
  const member = requireLiveMember(s, runId, chatId)
  const run = requireRun(s, runId)
  if (member.role === 'magos' && run.state !== 'shutting_down') await beginShutdown(s, runId, 'completed')
  const concluded = await endMember(s, runId, member, { state: 'concluded', graceful: true })
  emit(s, runId)
  return concluded
}

/** A member's terminal exited: one still a live member has left; the Magos of a running run failing ends it. */
function memberExited(s: State, chatId: string): void {
  const runId = s.chatRuns.get(chatId)
  if (runId === undefined) return
  s.chatRuns.delete(chatId)
  s.activity.untrack(chatId)
  void s.deps.ledger.removeProcess(chatId).catch(s.onError)
  void s.deps.control.clear(chatId).catch(s.onError)
  const member = s.deps.cults.listMembers(runId).find((candidate) => candidate.chatId === chatId)
  if (member !== undefined && isLive(member)) s.deps.cults.updateMember(runId, chatId, { state: 'left' })
  const entry = s.runs.get(runId)
  if (entry === undefined || entry.ending) return void emit(s, runId)
  const state = requireRun(s, runId).state
  if (member?.role === 'magos' && state !== 'shutting_down') void abort(s, runId, 'failed').catch(s.onError)
  else if (state === 'shutting_down') void finishIfDone(s, runId).catch(s.onError)
  else emit(s, runId)
}

// --- shutdown, kill, interruption --------------------------------------------------------------------------------

function cancelTimers(entry: Supervised): void {
  entry.cancelTimer?.()
  entry.cancelTimer = null
  for (const cancel of entry.shutdownTimers) cancel()
  entry.shutdownTimers = []
}

function step(s: State, runId: string, summary: string): void {
  s.deps.cults.appendEvent(runId, { kind: 'shutdown_step', summary })
  emit(s, runId)
}

/** Starts the graceful shutdown; its steps are timed from now, on the run's own grace and window. */
async function beginShutdown(s: State, runId: string, reason: ShutdownReason): Promise<CultRunSnapshot> {
  const entry = supervised(s, runId)
  const run = s.deps.cults.transitionRun(runId, { type: 'shutdown', reason })
  cancelTimers(entry)
  const grace = run.acolyteGraceMs
  entry.shutdownTimers = [
    schedule(s.clock, grace, () => void graceOver(s, runId).catch(s.onError)),
    schedule(s.clock, grace + run.magosWindowMs, () => void windowOver(s, runId).catch(s.onError)),
    schedule(s.clock, backstopMs(grace, run.magosWindowMs), () => void backstop(s, runId).catch(s.onError))
  ]
  emit(s, runId)
  await closeWake(s, runId)
  await tell(s, liveMembers(s, runId), (member) => ({ action: member.role === 'magos' ? 'wind_down' : 'conclude' }))
  await finishIfDone(s, runId)
  return snapshot(s, runId)
}

/** The acolyte grace is over: the acolytes still running are asked to exit; the Magos has its window. */
async function graceOver(s: State, runId: string): Promise<void> {
  step(s, runId, 'The acolyte grace ended; the Magos has its window to write the chronicle and conclude.')
  const acolytes = liveMembers(s, runId).filter((member) => member.role === 'acolyte')
  await tell(s, acolytes, () => ({ action: 'shutdown' }))
}

async function windowOver(s: State, runId: string): Promise<void> {
  step(s, runId, 'The Magos window ended.')
  const magos = magosOf(s, runId)
  await tell(s, magos === null ? [] : [magos], () => ({ action: 'shutdown' }))
}

/** Kills every member of the run still running (or still a member), marking the live ones `left`. */
async function endEveryone(s: State, runId: string, roles: readonly string[] = ['magos', 'acolyte']): Promise<void> {
  const members = s.deps.cults.listMembers(runId).filter((member) => roles.includes(member.role))
  const running = members.filter((member) => isLive(member) || s.deps.terminals.isRunning(member.chatId))
  await Promise.all(running.map((member) => endMember(s, runId, member, { state: 'left', graceful: false }).catch(s.onError)))
}

async function backstop(s: State, runId: string): Promise<void> {
  const entry = s.runs.get(runId)
  if (entry === undefined) return
  step(s, runId, 'The backstop ended every member still running.')
  entry.ending = true
  await revokeUpgrades(s, runId)
  await endEveryone(s, runId)
  await finish(s, runId)
}

/** Ends a shutting-down run once no member of it is running. */
async function finishIfDone(s: State, runId: string): Promise<void> {
  const running = s.deps.cults.listMembers(runId).some((member) => s.deps.terminals.isRunning(member.chatId))
  if (!running) await finish(s, runId)
}

async function finish(s: State, runId: string): Promise<void> {
  const entry = s.runs.get(runId)
  if (entry === undefined || requireRun(s, runId).state !== 'shutting_down') return
  entry.ending = true
  cancelTimers(entry)
  s.deps.cults.transitionRun(runId, { type: 'finish' })
  await settle(s, runId)
}

/** Ends the run at once from any active state: every member killed first (the acolytes before a failure is recorded). */
async function abort(s: State, runId: string, reason: AbortReason): Promise<CultRunSnapshot> {
  const entry = supervised(s, runId)
  entry.ending = true
  cancelTimers(entry)
  await closeWake(s, runId)
  await revokeUpgrades(s, runId)
  await endEveryone(s, runId)
  if (requireRun(s, runId).state !== 'ended') s.deps.cults.transitionRun(runId, { type: 'abort', reason })
  await settle(s, runId)
  return snapshot(s, runId)
}

/** Revokes every petition upgrade of the run; one already gone with its member's terminal needs nothing more. */
async function revokeUpgrades(s: State, runId: string): Promise<void> {
  const upgrades = s.deps.ledger.grants().filter((grant) => grant.runId === runId)
  await Promise.all(upgrades.map((grant) => revokeUpgrade(s.upgrades, grant).catch(s.onError)))
}

/**
 * After the run ended: every upgrade revoked, the run's records here dropped, the end told, its members' files cleared.
 * Kept in `settling` until it is done, so `endRun` can wait for it.
 */
function settle(s: State, runId: string): Promise<void> {
  const settling = settleRun(s, runId)
  s.settling.set(runId, settling)
  const done = (): void => {
    if (s.settling.get(runId) === settling) s.settling.delete(runId)
  }
  settling.then(done, done)
  return settling
}

async function settleRun(s: State, runId: string): Promise<void> {
  await revokeUpgrades(s, runId)
  const members = s.deps.cults.listMembers(runId)
  for (const member of members) s.chatRuns.delete(member.chatId)
  s.runs.delete(runId)
  s.activity.endRun(runId)
  emit(s, runId)
  // Awaited, so a run has settled (and a quit finished) only once no file of its members is still being written: each
  // clear is queued behind the control writes still in flight for its chat (`cultControl.ts`).
  await Promise.all(members.flatMap((member) => [
    s.deps.control.clear(member.chatId).catch(s.onError),
    s.deps.ledger.removeProcess(member.chatId).catch(s.onError)
  ]))
}

// --- petitions ---------------------------------------------------------------------------------------------------

function trackedFolder(s: State, folder: string): string {
  return s.deps.folders.resolve(folder) ?? fail('folder_not_tracked', `The folder ${folder} is not tracked by Dark Mechanicus.`)
}

function petition(s: State, runId: string, input: PetitionInput, fromChatId?: string): CultPetitionView {
  requireRun(s, runId)
  const named = input.kind === 'folder_access' ? { ...input, folderPath: trackedFolder(s, input.folderPath) } : input
  const from = fromChatId === undefined ? undefined : s.deps.cults.listMembers(runId).find((member) => member.chatId === fromChatId)
  const created = s.deps.cults.createPetition(runId, named, from?.displayName ?? null)
  emit(s, runId)
  return created
}

/** Applies an approved upgrade to the running Magos; null for an acolytes petition, which only raises the cap. */
async function applyUpgrade(s: State, petition: CultPetitionView, magos: UpgradedMagos): Promise<LedgerGrant | null> {
  const run = requireRun(s, petition.runId)
  if (petition.kind === 'allow_save') return grantAllowSave(s.upgrades, run, magos)
  if (petition.kind === 'folder_access') return grantFolderAccess(s.upgrades, run, magos, trackedFolder(s, petition.folderPath!))
  return null
}

async function decidePetition(s: State, petitionId: string, approve: boolean, granted?: number): Promise<CultPetitionView> {
  const pending = s.deps.cults.getPetition(petitionId) ?? fail('not_found', `No cult petition ${petitionId}.`)
  if (pending.state !== 'pending') fail('invalid_state', `Petition ${petitionId} is already ${pending.state}.`)
  supervised(s, pending.runId)
  const magos = magosOf(s, pending.runId) ?? fail('invalid_state', 'The cult run has no running Magos to decide for.')
  const upgrade = approve ? await applyUpgrade(s, pending, magos) : null
  let decided: CultPetitionView
  try {
    decided = s.deps.cults.decidePetition(petitionId, { approve, granted }, magos.displayName)
  } catch (error) {
    if (upgrade !== null) await revokeUpgrade(s.upgrades, upgrade)
    throw error
  }
  const told = { kind: decided.kind, approved: approve, ...(decided.granted === null ? {} : { granted: decided.granted }) }
  const folder = upgrade?.tokenFile == null ? {} : { folder: upgrade.folder, tokenFile: upgrade.tokenFile }
  await tell(s, [magos], () => ({ action: 'petition', petition: { ...told, ...folder } }))
  emit(s, pending.runId)
  return decided
}

// --- lifecycle ---------------------------------------------------------------------------------------------------

async function start(s: State, cultId: string, options: RunOptions): Promise<CultRunSnapshot> {
  const { run, magos } = await s.deps.launcher.launch(cultId, options)
  s.runs.set(run.id, { cancelTimer: null, shutdownTimers: [], ending: false, queue: Promise.resolve() })
  await track(s, run.id, magos)
  arm(s, run.id)
  return emit(s, run.id)
}

async function pause(s: State, runId: string): Promise<CultRunSnapshot> {
  const entry = supervised(s, runId)
  s.deps.cults.transitionRun(runId, { type: 'pause' })
  entry.cancelTimer?.()
  entry.cancelTimer = null
  await closeWake(s, runId)
  await tell(s, liveMembers(s, runId), () => ({ action: 'interrupt' }))
  return emit(s, runId)
}

async function resume(s: State, runId: string): Promise<CultRunSnapshot> {
  supervised(s, runId)
  s.deps.cults.transitionRun(runId, { type: 'resume' })
  arm(s, runId)
  await tell(s, liveMembers(s, runId), () => ({ action: 'resume' }))
  return emit(s, runId)
}

/** Ends a member process a crash left, when it is still the member's own (its command line names its session folder). */
async function reap(s: State, entry: { chatId: string; pid: number }): Promise<void> {
  try {
    await endLeftover(entry.pid, ompFilePaths(s.deps.userData, entry.chatId).sessionDir, s.deps.leftovers)
  } catch (error) {
    s.onError(error)
  }
  await s.deps.ledger.removeProcess(entry.chatId)
}

async function reconcileOnStartup(s: State): Promise<CultRunView[]> {
  const leftovers = s.deps.ledger.processes().filter((entry) => !s.chatRuns.has(entry.chatId))
  await Promise.all(leftovers.map((entry) => reap(s, entry)))
  const grants = s.deps.ledger.grants().filter((grant) => !s.runs.has(grant.runId))
  await Promise.all(grants.map((grant) => revokeLeftUpgrade(s.upgrades, grant).catch(s.onError)))
  const runs = s.deps.cults.activeRunsOnStartup().filter((run) => !s.runs.has(run.id))
  return Promise.all(runs.map(async (run) => {
    for (const member of liveMembers(s, run.id)) s.deps.cults.updateMember(run.id, member.chatId, { state: 'left' })
    s.deps.cults.transitionRun(run.id, { type: 'abort', reason: 'interrupted' }, 'The app stopped while the run was active.')
    // A member chat resumed later must not apply what its control file still holds from the run.
    await Promise.all(s.deps.cults.listMembers(run.id).map((member) => s.deps.control.clear(member.chatId).catch(s.onError)))
    return emit(s, run.id).run
  }))
}

/**
 * Stops the run (unless it is already shutting down) and waits until it has ended and settled (`settle`): its end is told
 * before its members' control files are cleared, and a write still in flight there would race the removal of their
 * folders when the cult is deleted. A run neither supervised nor settling here has nothing to wait for.
 */
async function endRun(s: State, runId: string): Promise<void> {
  if (!s.settling.has(runId) && s.runs.has(runId)) await stopAndWait(s, runId)
  await s.settling.get(runId)
}

async function stopAndWait(s: State, runId: string): Promise<void> {
  let resolve: () => void = () => {}
  // The lib target predates `Promise.withResolvers`.
  const ended = new Promise<void>((done) => {
    resolve = done
  })
  const check = (snapshot: CultRunSnapshot): void => {
    if (snapshot.run.id !== runId || snapshot.run.state !== 'ended') return
    s.events.off(CULT_CHANGED, check)
    resolve()
  }
  s.events.on(CULT_CHANGED, check)
  if (requireRun(s, runId).state !== 'shutting_down') await serialized(s, runId, () => beginShutdown(s, runId, 'stopped'))
  if (s.runs.has(runId)) await ended
}

function serialized<T>(s: State, runId: string, work: () => Promise<T>): Promise<T> {
  return queued(supervised(s, runId), work)
}

/** Raises the run's cap in the store and tells the change. */
function raiseCap(s: State, runId: string, cap: number): CultRunSnapshot {
  s.deps.cults.raiseCap(runId, cap)
  return emit(s, runId)
}

/** Hears every member terminal's exit, and every launch (a member relaunched while paused is told so again). */
function watchTerminals(s: State): void {
  s.deps.terminals.onExit((chatId) => {
    try {
      memberExited(s, chatId)
    } catch (error) {
      s.onError(error)
    }
  })
  s.deps.terminals.onLaunch?.((chatId) => memberLaunched(s, chatId))
}

/** A member's published activity changing is told as a change of its run while the run is supervised. */
function watchActivity(s: State): void {
  s.activity.onChange((runId) => {
    if (s.runs.has(runId)) emit(s, runId)
  })
}

function supervisorState(deps: CultSupervisorDeps): State {
  const onError = deps.onError ?? (() => {})
  const upgrades: UpgradeDeps = {
    userData: deps.userData, chatStore: deps.chatStore, grants: deps.grants, terminals: deps.terminals, ledger: deps.ledger,
    revokeGrantIn: deps.revokeGrantIn, onError
  }
  return {
    deps, clock: deps.clock ?? systemClock, onError, upgrades, runs: new Map(), chatRuns: new Map(), events: new EventEmitter(), wakeClosers: new Set(),
    settling: new Map(),
    activity: createMemberActivity({ userData: deps.userData, clock: deps.activityClock ?? deps.clock ?? systemClock })
  }
}

export function createCultSupervisor(deps: CultSupervisorDeps): CultSupervisor {
  const s = supervisorState(deps)
  watchActivity(s)
  watchTerminals(s)
  return {
    start: (cultId, options = {}) => start(s, cultId, options),
    pause: (runId) => serialized(s, runId, () => pause(s, runId)),
    resume: (runId) => serialized(s, runId, () => resume(s, runId)),
    stop: (runId) => serialized(s, runId, () => beginShutdown(s, runId, 'stopped')),
    killNow: (runId) => abort(s, runId, 'killed'),
    addAcolyte: (runId, request) => serialized(s, runId, () => addAcolyte(s, runId, request)),
    summonAcolyte: (runId, request) => serialized(s, runId, () => summonAcolyte(s, runId, request)),
    memberOf: (chatId) => memberOf(s, chatId),
    concludeRun: (runId) => serialized(s, runId, () => concludeRun(s, runId)),
    dismissAcolyte: (runId, chatId) => serialized(s, runId, () => dismissAcolyte(s, runId, chatId)),
    concludeMember: (runId, chatId) => serialized(s, runId, () => concludeMember(s, runId, chatId)),
    petition: (runId, input, fromChatId) => petition(s, runId, input, fromChatId),
    decidePetition: (petitionId, approve, granted) => {
      const runId = deps.cults.getPetition(petitionId)?.runId
      if (runId === undefined) return Promise.reject(new DomainError('not_found', `No cult petition ${petitionId}.`))
      return serialized(s, runId, () => decidePetition(s, petitionId, approve, granted))
    },
    isWakeOpen: (runId) => s.runs.get(runId)?.ending === false && deps.cults.getRun(runId)?.state === 'running',
    snapshot: (runId) => snapshot(s, runId),
    reconcileOnStartup: () => reconcileOnStartup(s),
    dispose: async () => {
      await Promise.all([...s.runs.keys()].map((runId) => abort(s, runId, 'interrupted').catch(s.onError)))
      s.activity.dispose()
    },
    busy: () => s.runs.size > 0,
    raiseCap: (runId, cap) => raiseCap(s, runId, cap),
    changed: (runId) => void emit(s, runId),
    endRun: (runId) => endRun(s, runId),
    on: (event, listener) => {
      s.events.on(event, listener)
      return () => {
        s.events.off(event, listener)
      }
    },
    onWakeClose: (listener) => addWakeCloser(s, listener)
  }
}
