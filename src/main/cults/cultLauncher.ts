/**
 * Launching a cult run (`docs/design/cults.md`): its workspace, and its members as Skitarii (OMP) chats made through the
 * ordinary chat records and terminal sessions, so mailbox binding works unchanged.
 *
 * **Workspace.** A folder cult works in its tracked folder, checked again at each launch. A project-less cult works in
 * its sanctum (`sanctumRegistry.ts`), created and registered here, then set up as a **db-mode** workspace: its records
 * live in `dbProjectDir(sanctum, dmHome)` and nothing is written into the sanctum folder, which is not a Git repository.
 *
 * **Members.** Each member chat records `cultRunId` and `cultRole` (main leaves member chats out of the folder chat
 * lists), is titled with the member's display name and runs on its model (`--model`, checked by `isSafeModelId`; an
 * acolyte defaults to the cheapest signed-in model). The Magos holds an `orchestrator` grant and an acolyte a `worker`
 * grant, both issued with an explicit Allow save **false** (an orchestrator grant defaults to true); the supervisor
 * upgrades the Magos when an `allow_save` petition is approved. Each member's rules (`cultRules.ts`) are written before
 * its start and appended to its instructions; its first prompt is the charter (Magos) or its mission (acolyte).
 *
 * **Ending.** `endMember` gives a member's CLI Ctrl+D and 5 s to exit, then kills its tree (`killPtyTree`); its grant is
 * revoked by the terminal on every way out. Deleting a cult deletes its member chats (records, transcripts, mailboxes,
 * own folders, and grants with their terminals), then the cult, then its sanctum and the sanctum's database project.
 * Timers, pause and shutdown sequencing, agent commands and IPC are later tickets; they call in through this module.
 */
import { rm } from 'node:fs/promises'
import { dbProjectDir } from '../../core/repo/storageMode'
import { DomainError, fail } from '../../core/errors'
import type { ChatRecord, ChatRole } from '../../shared/agents/chat'
import { isSafeModelId } from '../../shared/agents/models'
import type { RosterSlot } from '../../shared/cults/archetypes'
import type { CultMemberView, CultRunView, CultView, MemberRole } from '../../shared/cults/cult'
import { cultistName } from '../../shared/cults/names'
import type { ChatRecords } from '../agents/chatRecords'
import type { ProjectWorkspace } from '../desktop/workspaceClient'
import type { TerminalSessions, TerminalStart } from '../terminals/terminalSessions'
import { acolyteMission, acolyteRules, magosRules, writeCultRules, type CultRunContext, type MemberWorkerType, type PlanTarget } from './cultRules'
import type { CultStore } from './cultStore'
import type { SanctumRegistry } from './sanctumRegistry'

/** The agent every cult member runs: Skitarii (OMP), whose chats have mailboxes. */
const CULT_AGENT = 'omp'
/** What a graceful end types into a member's CLI: Ctrl+D, which closes an idle OMP editor (`cults.md`, section 3). */
const EXIT_KEYS = '\x04'
/** How long a member's CLI gets to exit on its own before its tree is killed. */
export const GRACEFUL_EXIT_MS = 5_000

export interface CultLauncherDeps {
  cults: Pick<CultStore, 'getCult' | 'getRun' | 'startRun' | 'transitionRun' | 'addMember' | 'listMembers' | 'listWorkerTypes' | 'listRuns' | 'deleteCult'>
  /** The Folders registry: what a folder cult's folder must still be tracked in. */
  folders: { resolve(path: string): string | null }
  sanctums: Pick<SanctumRegistry, 'create' | 'remove' | 'pathOf'>
  /** The chat records, with deleting a chat also ending its terminal (`endingTerminals`). */
  chats: Pick<ChatRecords, 'createChat' | 'deleteChat'>
  terminals: Pick<TerminalSessions, 'start' | 'endChat'>
  /** The desktop's own workspace of a tracked folder or a registered sanctum (the sanctum-aware `desktopWorkspace`). */
  workspaceFor: (folder: string) => Pick<ProjectWorkspace, 'initializeRepository' | 'getEpic'>
  /** Closes the desktop's workspace of a folder, before its database project is removed. */
  closeWorkspace: (folder: string) => Promise<void>
  /** The id of the cheapest signed-in OMP model (`cheapest` over the model catalog); null when there is none. */
  cheapestModel: () => Promise<string | null>
  userData: string
  /** The Dark Mechanicus home, where db-mode projects live (`dbProjectDir`). */
  dmHome: string
}

/** An acolyte as the Magos (or the person) summons it; the name is generated when absent. */
export interface AcolyteRequest {
  name?: string
  mission: string
  model?: string | null
  tier?: string | null
  tierReason?: string | null
  slotId?: string | null
  runWorkerTypeId?: string | null
}

/** A member started: its chat, its membership, and how its terminal start went. */
export interface LaunchedMember {
  chat: ChatRecord
  member: CultMemberView
  start: TerminalStart
}

export interface CultLauncher {
  /** The cult's tracked folder (still tracked), or its sanctum, created, registered and set up in db mode. */
  prepareWorkspace(cult: CultView): Promise<string>
  /** Prepares the workspace, records the run, and starts its Magos; the run is `running` once the Magos runs. */
  launch(cultId: string, options?: { timeLimitMs?: number | null; cap?: number }): Promise<{ run: CultRunView; magos: LaunchedMember }>
  startMagos(run: CultRunView): Promise<LaunchedMember>
  startAcolyte(run: CultRunView, request: AcolyteRequest): Promise<LaunchedMember>
  endMember(chatId: string, options: { graceful: boolean }): Promise<void>
  /** Deletes the cult with its member chats, grants and sanctum; refused (`active_run_exists`) while a run is active. */
  deleteCult(cultId: string): Promise<void>
}

function requireCult(deps: CultLauncherDeps, cultId: string): CultView {
  return deps.cults.getCult(cultId) ?? fail('not_found', `No cult ${cultId}.`)
}

function folderWorkspace(deps: CultLauncherDeps, cult: CultView): string {
  const folder = cult.folderPath ?? fail('invalid_state', `Cult ${cult.name} has no folder.`)
  return deps.folders.resolve(folder) ?? fail('unauthorized', `The folder ${folder} of cult ${cult.name} is not tracked by Dark Mechanicus.`)
}

async function sanctumWorkspace(deps: CultLauncherDeps, cult: CultView): Promise<string> {
  const sanctum = await deps.sanctums.create(cult.id)
  try {
    await deps.workspaceFor(sanctum).initializeRepository({ name: cult.name, mode: 'db' })
  } catch (error) {
    // Already set up by an earlier run: the same db-mode project serves this one.
    if (!(error instanceof DomainError && error.code === 'already_initialized')) throw error
  }
  return sanctum
}

/** A model for the command line: refused unless `isSafeModelId` passes it, never silently dropped. */
function checkedModel(model: string | null, who: string): string | null {
  if (model !== null && (model === 'default' || !isSafeModelId(model))) fail('invalid_input', `${JSON.stringify(model)} is not a model id ${who} can run on.`)
  return model
}

async function planTarget(deps: CultLauncherDeps, cult: CultView, workDir: string): Promise<PlanTarget | null> {
  if (cult.archetype !== 'plan_forge' || cult.targetEpicId === null) return null
  const epic = await deps.workspaceFor(workDir).getEpic({ epicId: cult.targetEpicId })
  return { epicId: epic.id, savedRevision: epic.currentRevisionNumber, draftRevision: epic.draftRevision }
}

async function runContext(deps: CultLauncherDeps, cult: CultView, run: CultRunView): Promise<CultRunContext> {
  return {
    cultName: cult.name,
    archetype: cult.archetype,
    magosName: cult.magosName,
    cap: run.cap,
    timeLimitMs: run.timeLimitMs,
    acolyteGraceMs: run.acolyteGraceMs,
    magosWindowMs: run.magosWindowMs,
    slots: cult.slots,
    target: await planTarget(deps, cult, run.workDir)
  }
}

interface MemberLaunch {
  run: CultRunView
  role: MemberRole
  name: string
  model: string | null
  firstPrompt: string
  rules: (name: string) => string
  membership: Omit<Parameters<CultLauncherDeps['cults']['addMember']>[1], 'chatId' | 'role' | 'displayName'>
}

const GRANT_ROLE: Readonly<Record<MemberRole, ChatRole>> = { magos: 'orchestrator', acolyte: 'worker' }

/** Creates the member's chat and membership, writes its rules, then starts its terminal with its first prompt. */
async function startMember(deps: CultLauncherDeps, launch: MemberLaunch): Promise<LaunchedMember> {
  const { run, role, name } = launch
  const chat = await deps.chats.createChat({
    folder: run.workDir, agent: CULT_AGENT, model: launch.model, role: GRANT_ROLE[role], allowSave: false,
    title: name, firstPrompt: launch.firstPrompt, cultRunId: run.id, cultRole: role
  })
  let member: CultMemberView
  try {
    member = deps.cults.addMember(run.id, { chatId: chat.id, role, displayName: name, model: launch.model, ...launch.membership })
    await writeCultRules(deps.userData, chat.id, launch.rules(member.displayName))
  } catch (error) {
    await deps.chats.deleteChat(chat)
    throw error
  }
  const start = await deps.terminals.start(chat, { kickoff: launch.firstPrompt })
  return { chat, member, start }
}

function memberWorkerType(deps: CultLauncherDeps, cult: CultView, run: CultRunView, request: AcolyteRequest): MemberWorkerType | null {
  if (request.slotId != null) {
    const slot: RosterSlot = cult.slots.find((candidate) => candidate.id === request.slotId) ?? fail('invalid_input', `The cult has no roster slot ${request.slotId}.`)
    return { kind: 'slot', slot }
  }
  if (request.runWorkerTypeId == null) return null
  const type = deps.cults.listWorkerTypes(run.id).find((candidate) => candidate.id === request.runWorkerTypeId)
  return type === undefined ? fail('invalid_input', `The run has no worker type ${request.runWorkerTypeId}.`) : { kind: 'run', type }
}

async function startAcolyte(deps: CultLauncherDeps, run: CultRunView, request: AcolyteRequest): Promise<LaunchedMember> {
  const cult = requireCult(deps, run.cultId)
  const workerType = memberWorkerType(deps, cult, run, request)
  const model = checkedModel(request.model ?? (await deps.cheapestModel()), 'an acolyte')
  const taken = deps.cults.listMembers(run.id).map((member) => member.displayName)
  const name = request.name?.trim() || cultistName(taken, 'acolyte', `${run.id}:${taken.length}`)
  const context = await runContext(deps, cult, run)
  return startMember(deps, {
    run, role: 'acolyte', name, model,
    firstPrompt: acolyteMission(request.mission, workerType),
    rules: (displayName) => acolyteRules(context, { name: displayName, workerType }),
    membership: {
      mission: request.mission, tier: request.tier ?? null, tierReason: request.tierReason ?? null,
      slotId: request.slotId ?? null, runWorkerTypeId: request.runWorkerTypeId ?? null
    }
  })
}

async function startMagos(deps: CultLauncherDeps, run: CultRunView): Promise<LaunchedMember> {
  const cult = requireCult(deps, run.cultId)
  const model = checkedModel(cult.magosModelId ?? (await deps.cheapestModel()), 'the Magos')
  const context = await runContext(deps, cult, run)
  return startMember(deps, {
    run, role: 'magos', name: cult.magosName, model, firstPrompt: cult.charter,
    rules: (displayName) => magosRules({ ...context, magosName: displayName }),
    membership: {}
  })
}

async function launch(deps: CultLauncherDeps, launcher: CultLauncher, cultId: string, options: { timeLimitMs?: number | null; cap?: number }) {
  const cult = requireCult(deps, cultId)
  const workDir = await launcher.prepareWorkspace(cult)
  const run = deps.cults.startRun(cultId, { workDir, ...options })
  try {
    const magos = await startMagos(deps, run)
    if (magos.start.state !== 'running') fail('internal_error', `The Magos did not start: ${magos.start.message}`)
    return { run: deps.cults.transitionRun(run.id, { type: 'started' }), magos }
  } catch (error) {
    deps.cults.transitionRun(run.id, { type: 'abort', reason: 'failed' }, error instanceof Error ? error.message.slice(0, 2000) : undefined)
    throw error
  }
}

/** Deletes one member chat; one already gone is not an error. */
async function deleteMemberChat(deps: CultLauncherDeps, ref: Pick<ChatRecord, 'folder' | 'id'>): Promise<void> {
  try {
    await deps.chats.deleteChat(ref)
  } catch (error) {
    if (!(error instanceof DomainError && error.code === 'not_found')) throw error
  }
}

async function deleteCult(deps: CultLauncherDeps, cultId: string): Promise<void> {
  const cult = requireCult(deps, cultId)
  const runs = deps.cults.listRuns(cultId)
  if (runs.some((run) => run.state !== 'ended')) fail('active_run_exists', 'End the cult run before deleting the cult.')
  for (const run of runs) {
    for (const member of deps.cults.listMembers(run.id)) await deleteMemberChat(deps, { folder: run.workDir, id: member.chatId })
  }
  deps.cults.deleteCult(cultId)
  if (cult.scope !== 'sanctum') return
  const sanctum = deps.sanctums.pathOf(cultId)
  await deps.closeWorkspace(sanctum)
  await deps.sanctums.remove(cultId)
  await rm(dbProjectDir(sanctum, deps.dmHome), { recursive: true, force: true })
}

export function createCultLauncher(deps: CultLauncherDeps): CultLauncher {
  const launcher: CultLauncher = {
    prepareWorkspace: async (cult) => (cult.scope === 'folder' ? folderWorkspace(deps, cult) : sanctumWorkspace(deps, cult)),
    launch: (cultId, options = {}) => launch(deps, launcher, cultId, options),
    startMagos: (run) => startMagos(deps, run),
    startAcolyte: (run, request) => startAcolyte(deps, run, request),
    endMember: (chatId, { graceful }) => deps.terminals.endChat(chatId, graceful ? { input: EXIT_KEYS, withinMs: GRACEFUL_EXIT_MS } : undefined),
    deleteCult: (cultId) => deleteCult(deps, cultId)
  }
  return launcher
}
