/**
 * What the Cult page derives from a cult's runs, as plain functions: the active run and the past ones, the members in
 * roster order with their colours, the controls a run state offers, the countdown, a petition's bounded grant and
 * how a member's activity reads.
 */
import { WORKER_TYPE_INFO } from '../../../shared/cults/archetypes'
import type { CultMemberDetail, CultRunDetail, MemberActivity } from '../../../shared/cults/cultApi'
import type { CultPetitionView } from '../../../shared/cults/cult'
import { formatDuration } from '../../../shared/cults/duration'
import { MAX_CAP, remainingMs, runningMs, type EndReason, type RunState } from '../../../shared/cults/runState'
import { memberHue } from './memberColors'

export const END_TEXT: Readonly<Record<EndReason, string>> = {
  completed: 'Completed',
  expired: 'Time ran out',
  stopped: 'Stopped',
  killed: 'Killed',
  interrupted: 'Interrupted',
  failed: 'Failed'
}

export const STATE_TEXT: Readonly<Record<RunState | 'idle', string>> = {
  idle: 'Idle',
  starting: 'Starting',
  running: 'Running',
  paused: 'Paused',
  shutting_down: 'Shutting down',
  ended: 'Ended'
}

/** The run that has not ended, if any; runs come newest first. */
export const activeRunOf = (runs: readonly CultRunDetail[]): CultRunDetail | null => runs.find((run) => run.run.state !== 'ended') ?? null

/** A member on the roster: its detail, its colour's hue (null for the Magos) and its worker type's name. */
export interface RosterMember {
  member: CultMemberDetail
  hue: number | null
  workerType: string | null
}

/** What kind of worker a member is: its slot's type, or the run type its Magos created. */
function workerTypeName(member: CultMemberDetail, run: CultRunDetail): string | null {
  if (member.workerType !== null) return WORKER_TYPE_INFO[member.workerType].displayName
  return run.workerTypes.find((type) => type.id === member.runWorkerTypeId)?.displayName ?? null
}

/**
 * Every live member, the Magos first, then the acolytes in join order. Each acolyte's hue is fixed by its place among
 * all the run's acolytes (those that left included), so it never changes while the run goes on.
 */
export function rosterOf(run: CultRunDetail): RosterMember[] {
  const byJoin = [...run.members].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
  const acolytes = byJoin.filter((member) => member.role === 'acolyte')
  const hueOf = (member: CultMemberDetail): number | null => (member.role === 'magos' ? null : memberHue(acolytes.indexOf(member)))
  const live = byJoin.filter((member) => member.leftAt === null)
  const ordered = [...live.filter((member) => member.role === 'magos'), ...live.filter((member) => member.role === 'acolyte')]
  return ordered.map((member) => ({ member, hue: hueOf(member), workerType: workerTypeName(member, run) }))
}

/** The controls the command bar shows for a run in this state (no run: Start). */
interface Controls {
  start: boolean
  pause: boolean
  resume: boolean
  stop: boolean
  raise: boolean
}

export function controlsFor(state: RunState | null): Controls {
  const live = state !== null && state !== 'ended'
  const steady = state === 'running' || state === 'paused'
  return {
    start: !live,
    pause: state === 'running',
    resume: state === 'paused',
    stop: steady || state === 'starting',
    raise: steady
  }
}

/** The countdown as the command bar says it: the time left, or "Unlimited" with the running time so far. */
export function countdownText(run: CultRunDetail['run'], now: number): string {
  const at = new Date(now).toISOString()
  const left = remainingMs(run, at)
  const seconds = (ms: number): string => formatDuration(Math.ceil(ms / 1000) * 1000)
  return left === null ? `Unlimited · ${seconds(runningMs(run, at))} elapsed` : `${seconds(left)} left`
}

/** How many more acolytes the run can take before the ceiling of 24. */
export const capRoom = (cap: number): number => Math.max(0, MAX_CAP - cap)

/** A granted count for an acolytes petition: a whole number from 1 to what was asked, and never past the ceiling. */
export function boundedGrant(wanted: number, petition: Pick<CultPetitionView, 'additional'>, cap: number): number {
  const most = Math.min(petition.additional ?? 0, capRoom(cap))
  return Math.max(1, Math.min(Number.isFinite(wanted) ? Math.floor(wanted) : most, most))
}

/** The run's pending petitions, newest first. */
export const pendingPetitions = (run: CultRunDetail): CultPetitionView[] =>
  run.petitions.filter((petition) => petition.state === 'pending').sort((a, b) => b.createdAt.localeCompare(a.createdAt))

/** A member's latest activity as plain text: working or idle, and the last tool with its reduced target. */
export function activityText(activity: MemberActivity | null): string {
  if (activity === null) return 'No live activity'
  const state = activity.working ? 'Working' : 'Idle'
  if (activity.tool === null) return state
  return `${state} · ${activity.tool.name}${activity.tool.target === '' ? '' : ` ${activity.tool.target}`}`
}

/** How long a past run lasted, from its start to its end. */
export function runDuration(run: CultRunDetail['run']): string {
  if (run.endedAt === null) return '—'
  return formatDuration(Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt)))
}
