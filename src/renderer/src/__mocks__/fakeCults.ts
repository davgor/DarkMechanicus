/**
 * A working `window.dm.cults` for cult renderer tests and the sidebar preview: seeded cults and runs, a model list
 * (or a signed-out reason), recorded changes, and `push` to deliver a `cults:event` as main would.
 */
import { ARCHETYPE_INFO } from '../../../shared/cults/archetypes'
import type { CultDefinitionInput, CultMemberDetail, CultModelsView, CultPushEvent, CultRunDetail, CultsApi } from '../../../shared/cults/cultApi'
import type { CultMemberView, CultPetitionView, CultRunView, CultView } from '../../../shared/cults/cult'
import type { CommandResult } from '../../../shared/desktop/api'
import { idleCults } from './idleCults'

const ok = <T>(data: T): Promise<CommandResult<T>> => Promise.resolve({ ok: true, data })

export function cultView(patch: Partial<CultView> = {}): CultView {
  return {
    id: 'cult_1',
    name: 'Shrine Builders',
    charter: 'Build the Gerry Shrine.',
    scope: 'folder',
    folderPath: '/home/u/code/alpha',
    archetype: 'general',
    targetEpicId: null,
    magosName: 'Magos Vettius',
    magosModelId: 'anthropic/claude-haiku',
    defaultTimeLimitMs: 30 * 60_000,
    defaultCap: 6,
    acolyteGraceMs: 3 * 60_000,
    magosWindowMs: 2 * 60_000,
    slots: ARCHETYPE_INFO.general.preset.map((slot) => ({ ...slot })),
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-20T10:00:00.000Z',
    ...patch
  }
}

function runView(patch: Partial<CultRunView> = {}): CultRunView {
  return {
    id: 'run_1',
    cultId: 'cult_1',
    state: 'running',
    endReason: null,
    timeLimitMs: 30 * 60_000,
    acolyteGraceMs: 3 * 60_000,
    magosWindowMs: 2 * 60_000,
    accumulatedRunningMs: 0,
    runningSince: '2026-11-27T12:00:00.000Z',
    cap: 6,
    workDir: '/home/u/code/alpha',
    chronicle: null,
    shrinePath: null,
    shrineRevision: null,
    startedAt: '2026-11-27T12:00:00.000Z',
    endedAt: null,
    ...patch
  }
}

export function memberDetail(patch: Partial<CultMemberDetail> = {}): CultMemberDetail {
  return {
    runId: 'run_1',
    chatId: 'chat_magos',
    role: 'magos',
    displayName: 'Magos Vettius',
    mission: '',
    model: 'anthropic/claude-haiku',
    tier: null,
    tierReason: null,
    slotId: null,
    workerType: null,
    runWorkerTypeId: null,
    state: 'active',
    joinedAt: '2026-11-27T12:00:00.000Z',
    leftAt: null,
    typeOrigin: null,
    reported: false,
    activity: null,
    ...patch
  }
}

export function runDetail(run: Partial<CultRunView> = {}, members: CultMemberDetail[] = []): CultRunDetail {
  return {
    run: runView(run),
    targetEpicId: null,
    members,
    petitions: [],
    slots: [],
    workerTypes: [],
    missing: { slots: [], workerTypes: [] },
    synthesis: null,
    shrine: null
  }
}

export class FakeCults implements CultsApi {
  cults: CultView[] = []
  /** Each cult's runs, newest first. */
  runsByCult: Record<string, CultRunDetail[]> = {}
  modelsView: CultModelsView = {
    options: [
      { id: 'anthropic/claude-haiku', provider: 'anthropic', label: 'Claude Haiku', tier: 'low' },
      { id: 'anthropic/claude-sonnet', provider: 'anthropic', label: 'Claude Sonnet', tier: 'normal' }
    ],
    reason: null
  }
  created: CultDefinitionInput[] = []
  updated: [string, CultDefinitionInput][] = []
  deleted: string[] = []
  modelRequests: boolean[] = []
  private listeners = new Set<(event: CultPushEvent) => void>()
  private readonly idle = idleCults()

  list = () => ok(this.cults)
  get = (cultId: string) => {
    const cult = this.cults.find((candidate) => candidate.id === cultId)
    return cult ? ok(cult) : Promise.resolve<CommandResult<CultView>>({ ok: false, error: { code: 'not_found', message: `No cult ${cultId}.` } })
  }
  create = (input: CultDefinitionInput) => {
    this.created.push(input)
    const cult = cultView({ ...input, id: `cult_${this.cults.length + 1}`, targetEpicId: input.targetEpicId ?? null, slots: input.slots ?? [] })
    this.cults.push(cult)
    return ok(cult)
  }
  update = (cultId: string, input: CultDefinitionInput) => {
    this.updated.push([cultId, input])
    this.cults = this.cults.map((cult) => (cult.id === cultId ? { ...cult, ...input, targetEpicId: input.targetEpicId ?? null, slots: input.slots ?? cult.slots } : cult))
    return this.get(cultId)
  }
  delete = (cultId: string) => {
    this.deleted.push(cultId)
    this.cults = this.cults.filter((cult) => cult.id !== cultId)
    return ok(null)
  }
  models = (refresh?: boolean) => {
    this.modelRequests.push(refresh === true)
    return ok(this.modelsView)
  }
  archetypes = this.idle.archetypes
  /** Every run control the page sent, as `[method, ...arguments]`, oldest first. */
  controls: unknown[][] = []
  /** Answers a run control with the run's snapshot unchanged (main pushes the real change). */
  private control(method: string, runId: string, ...rest: unknown[]): Promise<CommandResult<CultRunDetail>> {
    this.controls.push([method, runId, ...rest])
    const run = Object.values(this.runsByCult).flat().find((candidate) => candidate.run.id === runId)
    return run ? ok(run) : Promise.resolve({ ok: false, error: { code: 'not_found', message: `No run ${runId}.` } })
  }
  start = (cultId: string, overrides: Parameters<CultsApi['start']>[1]) => {
    this.controls.push(['start', cultId, overrides])
    return ok(runDetail({ cultId, state: 'starting' }))
  }
  pause = (runId: string) => this.control('pause', runId)
  resume = (runId: string) => this.control('resume', runId)
  stop = (runId: string) => this.control('stop', runId)
  killNow = (runId: string) => this.control('killNow', runId)
  raiseCap = (runId: string, cap: number) => this.control('raiseCap', runId, cap)
  decidePetition = (petitionId: string, approve: boolean, granted?: number) => {
    this.controls.push(['decidePetition', petitionId, approve, granted])
    const petition = Object.values(this.runsByCult).flat().flatMap((run) => run.petitions).find((candidate) => candidate.id === petitionId)
    if (petition === undefined) return Promise.resolve<CommandResult<CultPetitionView>>({ ok: false, error: { code: 'not_found', message: `No petition ${petitionId}.` } })
    return ok({ ...petition, state: approve ? 'approved' as const : 'denied' as const, granted: approve && petition.kind === 'acolytes' ? (granted ?? petition.additional) : null })
  }
  dismissAcolyte = (runId: string, chatId: string) => {
    this.controls.push(['dismissAcolyte', runId, chatId])
    const member = Object.values(this.runsByCult).flat().flatMap((run) => run.members).find((candidate) => candidate.chatId === chatId)
    return member ? ok<CultMemberView>(member) : Promise.resolve<CommandResult<CultMemberView>>({ ok: false, error: { code: 'not_found', message: `No member ${chatId}.` } })
  }
  pipeline = this.idle.pipeline
  runs = (cultId: string) => ok(this.runsByCult[cultId] ?? [])
  onEvent = (listener: (event: CultPushEvent) => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Delivers a run snapshot as main's `cults:event` push. */
  push(snapshot: CultRunDetail): void {
    for (const listener of this.listeners) listener({ type: 'run_changed', snapshot })
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}
