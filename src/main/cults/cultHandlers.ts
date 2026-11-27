/**
 * The `cults:*` IPC handlers (`window.dm.cults`, `src/shared/cults/cultApi.ts`) and the `cults:event` push. Every
 * argument arrives from the renderer and is untrusted: each is parsed by a strict zod schema, so a key the API does not
 * name (a member's resolved worker type, a Magos-created type, a work folder) is refused, never ignored. A folder cult's
 * folder must be a tracked folder of the Folders registry (never a sanctum: those exist only in main); a Plan Forge's
 * target epic must be in that same folder and its cap at least six. Answers are `CommandResult`s with typed errors.
 * Register through the sender guard (`guardIpc`), like every other channel.
 */
import type { IpcMain } from 'electron'
import { z } from 'zod'
import { fail } from '../../core/errors'
import { parseInput } from '../../core/schemas'
import { chatIdSchema } from '../../shared/agents/chat'
import { ARCHETYPE_INFO, CULT_ARCHETYPES, CUSTOM_WORKER_TYPE, STANDARD_WORKER_TYPES, WORKER_TYPE_INFO } from '../../shared/cults/archetypes'
import type { CultInput, CultMemberView, CultPetitionView, CultRunView, CultView } from '../../shared/cults/cult'
import {
  CULT_EVENT_CHANNEL,
  type CultCatalogView,
  type CultMemberDetail,
  type CultPushEvent,
  type CultModelsView,
  type CultRunDetail,
  type RunWorkerTypeDetail
} from '../../shared/cults/cultApi'
import { shrineKind } from '../../shared/cults/shrine'
import { MAX_CAP, MAX_SHUTDOWN_TIMING_MS, MIN_CAP, MIN_SHUTDOWN_TIMING_MS, MIN_TIME_LIMIT_MS } from '../../shared/cults/runState'
import type { CommandResult } from '../../shared/desktop/api'
import { answer } from '../agents/chatHandlers'
import { sendToWindows, type ChatWindow } from '../agents/chatIpc'
import type { CultLauncher } from './cultLauncher'
import type { CultStore } from './cultStore'
import { CULT_CHANGED, type CultRunSnapshot, type CultSupervisor } from './cultSupervisor'
import type { NamingDispatcher } from '../naming/controlPipe'

/** A Plan Forge council needs a seat for each of its six specialists. */
const PLAN_FORGE_MIN_CAP = 6

const id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/)
const line = (max: number) => z.string().trim().min(1).max(max)
const timing = z.number().int().min(MIN_SHUTDOWN_TIMING_MS).max(MAX_SHUTDOWN_TIMING_MS)
const cap = z.number().int().min(MIN_CAP).max(MAX_CAP)
const timeLimit = z.number().int().min(MIN_TIME_LIMIT_MS).max(Number.MAX_SAFE_INTEGER).nullable()

/** One ordered custom slot: stable id, label, mission. Nothing else: never a run type or a resolved member type. */
const slotSchema = z.strictObject({
  id,
  workerType: z.enum([...STANDARD_WORKER_TYPES, CUSTOM_WORKER_TYPE]),
  label: line(80),
  mission: line(4000),
  required: z.boolean()
})

const definitionSchema = z.strictObject({
  name: line(120),
  charter: line(32_000),
  scope: z.enum(['folder', 'sanctum']),
  folderPath: z.string().min(1).max(4096).nullable(),
  archetype: z.enum(CULT_ARCHETYPES),
  targetEpicId: id.nullable().optional(),
  magosName: line(80),
  magosModelId: z.string().min(1).max(200).nullable(),
  defaultTimeLimitMs: timeLimit,
  defaultCap: cap.optional(),
  acolyteGraceMs: timing.optional(),
  magosWindowMs: timing.optional(),
  slots: z.array(slotSchema).max(MAX_CAP).optional()
})
type Definition = z.infer<typeof definitionSchema>

const overridesSchema = z.strictObject({
  timeLimitMs: timeLimit.optional(),
  cap: cap.optional(),
  acolyteGraceMs: timing.optional(),
  magosWindowMs: timing.optional()
})
const pipelineSchema = z.strictObject({ afterSeq: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500) })

export interface CultHandlerDeps {
  cults: Pick<CultStore, 'getCult' | 'listCults' | 'createCult' | 'updateCult' | 'listRuns' | 'getRun' | 'listMembers' | 'listPetitions' | 'slotCoverage' | 'listWorkerTypes' | 'listReports' | 'latestSynthesis' | 'latestShrineEvent'>
  supervisor: Pick<CultSupervisor, 'start' | 'pause' | 'resume' | 'stop' | 'killNow' | 'raiseCap' | 'decidePetition' | 'dismissAcolyte' | 'endRun' | 'on' | 'snapshot'>
  launcher: Pick<CultLauncher, 'deleteCult'>
  /** The Folders registry only: a sanctum is never a folder the renderer may name. */
  folders: { resolve(path: string): string | null }
  /** The OMP model catalog (`OmpModelCatalog`): cached, or asked again on refresh. */
  models: { list(): Promise<CultModelsView>; refresh(): Promise<CultModelsView> }
  /** Resolves when `epicId` is an epic of the tracked `folder`'s own workspace; throws (`not_found`) otherwise. */
  epicIn: (folder: string, epicId: string) => Promise<unknown>
  onUnexpectedError?: (error: unknown) => void
}

type Answer<T> = Promise<CommandResult<T>>

/** One handler per `cults:*` channel; every argument is the renderer's, unparsed. */
export interface CultHandlers {
  list(): Answer<CultView[]>
  get(cultId: unknown): Answer<CultView>
  create(input: unknown): Answer<CultView>
  update(cultId: unknown, input: unknown): Answer<CultView>
  delete(cultId: unknown): Answer<null>
  models(refresh: unknown): Answer<CultModelsView>
  archetypes(): Answer<CultCatalogView>
  start(cultId: unknown, overrides: unknown): Answer<CultRunDetail>
  pause(runId: unknown): Answer<CultRunDetail>
  resume(runId: unknown): Answer<CultRunDetail>
  stop(runId: unknown): Answer<CultRunDetail>
  killNow(runId: unknown): Answer<CultRunDetail>
  raiseCap(runId: unknown, cap: unknown): Answer<CultRunDetail>
  decidePetition(petitionId: unknown, approve: unknown, granted: unknown): Answer<CultPetitionView>
  dismissAcolyte(runId: unknown, chatId: unknown): Answer<CultMemberView>
  runs(cultId: unknown): Answer<CultRunDetail[]>
  pipeline(runId: unknown, request: unknown): Answer<never>
}

type Cults = CultHandlerDeps['cults']

function trackedFolder(deps: CultHandlerDeps, path: string): string {
  return deps.folders.resolve(path) ?? fail('folder_not_tracked', `The folder ${path} is not tracked by Dark Mechanicus.`)
}

async function requireTarget(deps: CultHandlerDeps, folder: string, epicId: string): Promise<void> {
  try {
    await deps.epicIn(folder, epicId)
  } catch {
    fail('invalid_input', `The target epic ${epicId} is not an epic of ${folder}.`)
  }
}

/** The cult's folder: none for a sanctum cult (main creates its sanctum), else a tracked folder, canonical. */
function folderOf(deps: CultHandlerDeps, cult: Definition): string | null {
  if (cult.scope === 'sanctum' && cult.folderPath !== null) fail('invalid_input', 'A sanctum cult names no folder; main creates its sanctum.')
  if (cult.scope === 'folder' && cult.folderPath === null) fail('invalid_input', 'A folder cult needs a tracked folder.')
  return cult.folderPath === null ? null : trackedFolder(deps, cult.folderPath)
}

/** A Plan Forge needs a seat for each of its six specialists and a target epic of its own folder. */
async function requirePlanForge(deps: CultHandlerDeps, cult: Definition, folderPath: string | null): Promise<void> {
  if ((cult.defaultCap ?? PLAN_FORGE_MIN_CAP) < PLAN_FORGE_MIN_CAP) fail('invalid_input', `A Plan Forge cult needs a cap of at least ${PLAN_FORGE_MIN_CAP}.`)
  if (folderPath === null || cult.targetEpicId == null) fail('invalid_input', 'A Plan Forge cult needs a target epic in its folder.')
  await requireTarget(deps, folderPath, cult.targetEpicId)
}

/** The definition as the store takes it: the folder canonical and tracked, a Plan Forge's target and cap checked. */
async function definition(deps: CultHandlerDeps, input: unknown): Promise<CultInput> {
  const cult: Definition = parseInput(definitionSchema, input, 'cult definition')
  const folderPath = folderOf(deps, cult)
  if (cult.archetype === 'plan_forge') await requirePlanForge(deps, cult, folderPath)
  return { ...cult, folderPath, targetEpicId: cult.targetEpicId ?? null }
}

function requireCult(deps: CultHandlerDeps, cultId: unknown): CultView {
  const parsed = parseInput(id, cultId, 'cult id')
  return deps.cults.getCult(parsed) ?? fail('not_found', `No cult ${parsed}.`)
}

function memberDetails(snapshot: CultRunSnapshot, reported: ReadonlySet<string>): CultMemberDetail[] {
  return snapshot.members.map((member) => ({
    ...member,
    typeOrigin: member.slotId !== null ? 'definition_slot' : member.runWorkerTypeId !== null ? 'magos_created' : null,
    reported: reported.has(member.chatId)
  }))
}

function workerTypeDetails(cults: Cults, snapshot: CultRunSnapshot): RunWorkerTypeDetail[] {
  const reports = cults.listReports(snapshot.run.id)
  return cults.listWorkerTypes(snapshot.run.id).map((type) => ({
    ...type,
    origin: 'magos_created',
    state: type.retiredAt === null ? 'active' : 'retired',
    assignedChatIds: snapshot.members.filter((member) => member.runWorkerTypeId === type.id).map((member) => member.chatId),
    reportCount: reports.filter((report) => report.runWorkerTypeId === type.id).length
  }))
}

function synthesisOf(cults: Cults, runId: string): CultRunDetail['synthesis'] {
  const synthesis = cults.latestSynthesis(runId)
  if (synthesis === null) return null
  const accepted = synthesis.recommendations.filter((item) => item.decision === 'accepted').length
  return { draftRevision: synthesis.draftRevision, accepted, rejected: synthesis.recommendations.length - accepted, recordedAt: synthesis.recordedAt }
}

/** The run's published Shrine with who published it and when it last changed; null before any publish. */
function shrineOf(cults: Cults, run: CultRunView): CultRunDetail['shrine'] {
  const kind = run.shrinePath === null ? null : shrineKind(run.shrinePath)
  if (run.shrinePath === null || run.shrineRevision === null || kind === null) return null
  const last = cults.latestShrineEvent(run.id)
  return { path: run.shrinePath, revision: run.shrineRevision, kind, publishedBy: last?.memberName ?? null, updatedAt: last?.at ?? run.startedAt }
}

/** A run snapshot as the renderer sees it: members with their type origin and report state, coverage, created types and synthesis. */
function runDetail(deps: Pick<CultHandlerDeps, 'cults'>, snapshot: CultRunSnapshot): CultRunDetail {
  const { run } = snapshot
  const { cults } = deps
  const reported = new Set(deps.cults.listReports(run.id).map((report) => report.memberChatId))
  const slots = deps.cults.slotCoverage(run.id).map((slot) => ({ ...slot, origin: 'definition_slot' as const }))
  const workerTypes = workerTypeDetails(cults, snapshot)
  return {
    run, targetEpicId: deps.cults.getCult(run.cultId)?.targetEpicId ?? null,
    members: memberDetails(snapshot, reported), petitions: snapshot.petitions, slots, workerTypes,
    missing: {
      slots: slots.filter((slot) => slot.required && slot.reportCount === 0).map((slot) => slot.slotId),
      workerTypes: workerTypes.filter((type) => type.requiredForConclusion && type.state === 'active' && type.reportCount === 0).map((type) => type.id)
    },
    synthesis: synthesisOf(cults, run.id),
    shrine: shrineOf(cults, run)
  }
}

function catalog(): CultCatalogView {
  return {
    archetypes: CULT_ARCHETYPES.map((archetype) => ({ id: archetype, ...ARCHETYPE_INFO[archetype] })),
    standardWorkerTypes: STANDARD_WORKER_TYPES.map((type) => ({ id: type, origin: 'standard' as const, ...WORKER_TYPE_INFO[type] }))
  }
}

/** Ends the cult's active run first (Stop, then waits for its end), then deletes the cult with its chats and sanctum. */
async function deleteCult(deps: CultHandlerDeps, cultId: unknown): Promise<null> {
  const cult = requireCult(deps, cultId)
  const active = deps.cults.listRuns(cult.id).find((run) => run.state !== 'ended')
  if (active !== undefined) await deps.supervisor.endRun(active.id)
  await deps.launcher.deleteCult(cult.id)
  return null
}

function runsOf(deps: CultHandlerDeps, cultId: unknown): CultRunDetail[] {
  const cult = requireCult(deps, cultId)
  return deps.cults.listRuns(cult.id).map((run) =>
    runDetail(deps, deps.supervisor.snapshot(run.id)))
}

function pipeline(runId: unknown, request: unknown): never {
  parseInput(id, runId, 'cult run id')
  parseInput(pipelineSchema, request, 'pipeline request')
  return fail('operation_unavailable', 'The run pipeline is not served yet.')
}

const runIdOf = (runId: unknown): string => parseInput(id, runId, 'cult run id')

function controls(deps: CultHandlerDeps) {
  const run = (runId: unknown, act: (runId: string) => Promise<CultRunSnapshot>): Promise<CommandResult<CultRunDetail>> =>
    answer(deps, async () => runDetail(deps, await act(runIdOf(runId))))
  return {
    start: (cultId: unknown, overrides: unknown) => answer(deps, async () => {
      const options = parseInput(overridesSchema, overrides, 'run overrides')
      return runDetail(deps, await deps.supervisor.start(requireCult(deps, cultId).id, options))
    }),
    pause: (runId: unknown) => run(runId, (parsed) => deps.supervisor.pause(parsed)),
    resume: (runId: unknown) => run(runId, (parsed) => deps.supervisor.resume(parsed)),
    stop: (runId: unknown) => run(runId, (parsed) => deps.supervisor.stop(parsed)),
    killNow: (runId: unknown) => run(runId, (parsed) => deps.supervisor.killNow(parsed)),
    raiseCap: (runId: unknown, next: unknown) =>
      run(runId, async (parsed) => deps.supervisor.raiseCap(parsed, parseInput(cap, next, 'cap'))),
    decidePetition: (petitionId: unknown, approve: unknown, granted: unknown) => answer(deps, () =>
      deps.supervisor.decidePetition(parseInput(id, petitionId, 'petition id'), parseInput(z.boolean(), approve, 'decision'),
        parseInput(cap.optional(), granted, 'granted acolytes'))),
    dismissAcolyte: (runId: unknown, chatId: unknown) => answer(deps, () =>
      deps.supervisor.dismissAcolyte(runIdOf(runId), parseInput(chatIdSchema, chatId, 'chat id')))
  }
}

export function createCultHandlers(deps: CultHandlerDeps): CultHandlers {
  return {
    list: () => answer(deps, () => deps.cults.listCults()),
    get: (cultId: unknown) => answer(deps, () => requireCult(deps, cultId)),
    create: (input: unknown) => answer(deps, async () => deps.cults.createCult(await definition(deps, input))),
    update: (cultId: unknown, input: unknown) => answer(deps, async () => {
      const cult = requireCult(deps, cultId)
      return deps.cults.updateCult(cult.id, await definition(deps, input))
    }),
    delete: (cultId: unknown) => answer(deps, () => deleteCult(deps, cultId)),
    models: (refresh: unknown) => answer(deps, () =>
      parseInput(z.boolean().optional(), refresh, 'refresh') === true ? deps.models.refresh() : deps.models.list()),
    archetypes: () => answer(deps, catalog),
    ...controls(deps),
    runs: (cultId: unknown) => answer(deps, () => runsOf(deps, cultId)),
    pipeline: (runId: unknown, request: unknown) => answer(deps, () => pipeline(runId, request))
  }
}

const CULT_CHANNELS = ['list', 'get', 'create', 'update', 'delete', 'models', 'archetypes', 'start', 'pause', 'resume', 'stop', 'killNow',
  'raiseCap', 'decidePetition', 'dismissAcolyte', 'runs', 'pipeline'] as const

/** One `cults:<method>` channel per handler; each forwards its payload arguments untouched to be validated. */
export function registerCultIpc(ipcMain: Pick<IpcMain, 'handle'>, handlers: CultHandlers): void {
  for (const method of CULT_CHANNELS) {
    const handler = handlers[method] as (...args: unknown[]) => unknown
    ipcMain.handle(`cults:${method}`, (_event, ...args: unknown[]) => handler(...args))
  }
}

/** Sends every run change the supervisor tells to each open window as its detail on `cults:event`; returns the unsubscribe. */
export function forwardCultEvents(deps: Pick<CultHandlerDeps, 'cults' | 'supervisor'>, windows: () => readonly ChatWindow[]): () => void {
  return deps.supervisor.on(CULT_CHANGED, (snapshot) => {
    const event: CultPushEvent = { type: 'run_changed', snapshot: runDetail(deps, snapshot) }
    sendToWindows(windows(), CULT_EVENT_CHANNEL, event)
  })
}

/**
 * The cult dispatcher with every successful Magos or acolyte command told as a run change, so what it recorded (a
 * Magos-created type, an assignment, a report, a synthesis) reaches the renderer live on `cults:event`.
 */
export function announcingDispatcher(dispatch: NamingDispatcher, supervisor: Pick<CultSupervisor, 'memberOf' | 'changed'>): NamingDispatcher {
  return async (operation, context) => {
    const runId = supervisor.memberOf(context.binding.chatId)?.run.id
    const result = await dispatch(operation, context)
    if (runId !== undefined) supervisor.changed(runId)
    return result
  }
}
