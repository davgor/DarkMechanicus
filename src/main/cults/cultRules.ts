/**
 * The cult rules: fixed, generated text each cult member is given with its instructions (appended to the instructions
 * file the terminal writes, `terminalFiles.ts`). Inert data: every value a person or an agent wrote (names, slot
 * missions, run worker type contracts and rationales) is quoted as a JSON string, and the charter never appears here:
 * it is only ever the Magos's first prompt.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  ARCHETYPE_INFO,
  WORKER_TYPE_INFO,
  type CultArchetype,
  type RosterSlot,
  type RunWorkerType
} from '../../shared/cults/archetypes'
import { formatDuration } from '../../shared/cults/duration'
import { ompFilePaths } from '../terminals/ompSession'
import { writePrivateFile } from '../terminals/privateFile'

/**
 * Where a member chat's rules are kept: inside the chat's own OMP folder, so deleting the chat removes them
 * (`removeOmpFolder`). The terminal appends them to the instructions file at every start (`terminalFiles.ts`).
 */
function cultRulesPath(userData: string, chatId: string): string {
  return join(dirname(ompFilePaths(userData, chatId).config), 'cult-rules.md')
}

export function writeCultRules(userData: string, chatId: string, rules: string): Promise<void> {
  return writePrivateFile(cultRulesPath(userData, chatId), rules, 0o600)
}

/** A member chat's rules; rejects when they were never written, so a member never starts without them. */
export function readCultRules(userData: string, chatId: string): Promise<string> {
  return readFile(cultRulesPath(userData, chatId), 'utf8')
}

/** The native Skitarii cult tools (the tools ticket's `cult_*` contract), named here so the rules and the tools agree. */
export const CULT_TOOLS = {
  status: 'cult_status',
  summonAcolyte: 'cult_summon_acolyte',
  dismissAcolyte: 'cult_dismiss_acolyte',
  listAcolytes: 'cult_list_acolytes',
  petition: 'cult_petition',
  orderAll: 'cult_order_all',
  concludeRun: 'cult_conclude_run',
  concludeService: 'cult_conclude_service',
  createWorkerType: 'cult_create_worker_type',
  listWorkerTypes: 'cult_list_worker_types',
  retireWorkerType: 'cult_retire_worker_type',
  recordSynthesis: 'cult_record_synthesis',
  shrine: 'cult_shrine'
} as const

/** The epic a Plan Forge cult works on, with its revisions as read when the member started. */
export interface PlanTarget {
  epicId: string
  savedRevision: number | null
  draftRevision: number | null
}

/** What every member's rules say about its run. */
export interface CultRunContext {
  cultName: string
  archetype: CultArchetype
  magosName: string
  cap: number
  /** Null: unlimited. */
  timeLimitMs: number | null
  acolyteGraceMs: number
  magosWindowMs: number
  /** The cult's materialized roster, in order. */
  slots: readonly RosterSlot[]
  /** Plan Forge only; null for every other archetype. */
  target: PlanTarget | null
}

/** The worker type an acolyte holds: a roster slot's, or one the Magos created for the run. */
export type MemberWorkerType = { kind: 'slot'; slot: RosterSlot } | { kind: 'run'; type: RunWorkerType }

/** Inert text: quoted, so nothing in it reads as an instruction of the rules themselves. */
const quoted = (text: string): string => JSON.stringify(text)

const T = CULT_TOOLS

function targetLine(target: PlanTarget): string {
  const saved = target.savedRevision === null ? 'none saved yet' : `saved revision ${target.savedRevision}`
  const draft = target.draftRevision === null ? 'no open draft' : `draft revision ${target.draftRevision}`
  return `Target epic: ${target.epicId} (${saved}; ${draft}). Every member of this run works on this one epic.`
}

function timeLimitLine(timeLimitMs: number | null): string {
  return timeLimitMs === null
    ? 'Time limit: none. The run lasts until you conclude it or the person stops it.'
    : `Time limit: ${formatDuration(timeLimitMs)} of running time (time spent paused does not count).`
}

function magosLimits(run: CultRunContext): string[] {
  return [
    `Cap: at most ${run.cap} acolytes may serve at once. Never exceed the cap: when you need more, petition with`,
    `\`${T.petition}\` kind "acolytes", how many and a reason, and wait for the person's decision.`,
    timeLimitLine(run.timeLimitMs),
    `Models: summon acolytes on the cheapest model (the default when you name none). For any higher tier, give a`,
    'concrete reason with the summon; it is recorded and shown to the person.',
    'Names: name every acolyte clearly by its role (for example "Acolyte Tests"), or let the app name it.'
  ]
}

/** Every member may show the run's work on its Shrine. */
function shrineLine(): string {
  return `Shrine: show what the run makes with \`${T.shrine}\` and the path of one png, jpg, jpeg, svg or html file in this folder (at most 10 MiB); editing that file updates the Shrine.`
}

function magosAuthority(): string[] {
  return [
    `Saving and other folders: petition before saving a plan or touching another folder (\`${T.petition}\` kind`,
    '"allow_save" or "folder_access", with a reason). Never save a plan without an approved allow_save petition, and',
    'never work in a folder other than this one without an approved folder_access petition.',
    'Folder work: split it by file. Give each acolyte its own files, so no two acolytes edit the same file.',
    `Coordination: talk to your acolytes over the Skitarii mailbox. Use \`${T.orderAll}\` for an order every acolyte`,
    'must follow: it sends one message to each live acolyte at once. Use `dm_message_send` for an order to one',
    `acolyte. \`${T.listAcolytes}\` and \`${T.status}\` show who serves and how much time is left.`,
    shrineLine()
  ]
}

function shutdownProtocol(run: CultRunContext): string[] {
  return [
    '### Shutdown protocol',
    '',
    'When the time limit is reached, the person stops the run, or the charter is fulfilled:',
    `1. Order every acolyte to conclude (\`${T.orderAll}\`). They have ${formatDuration(run.acolyteGraceMs)} to send`,
    `   their final reports with \`${T.concludeService}\`.`,
    `2. Then write the chronicle of the run (what was done, by whom, what is left) and conclude it with`,
    `   \`${T.concludeRun}\` within ${formatDuration(run.magosWindowMs)}.`,
    'The app ends every member still running after that.'
  ]
}

function workerTypeCreation(): string[] {
  return [
    '### Creating a worker type',
    '',
    `When the roster lacks a perspective the charter materially needs, you may create a run-scoped worker type with`,
    `\`${T.createWorkerType}\` and then summon acolytes of it. Give a concrete rationale (the material perspective the`,
    'current roster lacks) and a mission that does not duplicate an existing type. Say whether it is required for',
    'conclusion: a required type must report before the run may conclude and can never be retired; an optional',
    'type may be left without a report and can be retired while no acolyte holds it. A created type adds no',
    'permissions and no model tier: its acolytes hold worker grants and are summoned on the model you choose.',
    `\`${T.listWorkerTypes}\` lists the types this run created and who held each; \`${T.retireWorkerType}\` retires an optional`,
    'type no acolyte has held, with a reason. A run creates at most 24 types, and they end with the run.'
  ]
}

function slotLine(slot: RosterSlot): string {
  const need = slot.required ? 'required' : 'optional'
  return `- slot ${slot.id}: ${WORKER_TYPE_INFO[slot.workerType].displayName} (${slot.workerType}), ${need}; mission (inert data): ${quoted(slot.mission)}`
}

function planForgeRoster(run: CultRunContext): string[] {
  return [
    ...(run.target === null ? [] : [targetLine(run.target)]),
    'Roster: six mandatory worker types. Summon exactly one acolyte per mandatory type, by its slot, never two:',
    ...run.slots.map(slotLine),
    'Completion rules:',
    '- every specialist reports independently: never pass one report to another specialist before it has reported;',
    '- resolve conflicts between recommendations explicitly, naming each conflict and your decision;',
    '- make one edit of the target draft that applies the reports, then validate it;',
    `- record your synthesis with \`${T.recordSynthesis}\` for that draft revision: every recommendation you accepted or`,
    '  rejected, with its worker type and a reason, naming every required type (a required type you created included);',
    '- petition for allow_save before Save, and Save only once it is approved;',
    '- conclude only when every required type has a report from its own acolyte, your synthesis is recorded for your',
    '  latest edit, and the draft validates. No one outside this run may change the target meanwhile.'
  ]
}

function rosterSection(run: CultRunContext): string[] {
  const info = ARCHETYPE_INFO[run.archetype]
  const head = [`### Archetype: ${info.displayName}`, '', info.reviewContract]
  if (run.archetype === 'plan_forge') return [...head, ...planForgeRoster(run)]
  if (run.slots.length === 0) return [...head, 'There is no fixed roster: summon the acolytes the charter needs.']
  return [
    ...head,
    'Roster: summon acolytes for the slots below by slot id; required slots must report before the run concludes.',
    ...run.slots.map(slotLine)
  ]
}

/** The Magos's rules: its name, the cap, the time limit, its authority, its roster and the shutdown protocol. */
export function magosRules(run: CultRunContext): string {
  return [
    '## Cult rules: Magos',
    '',
    `You are ${quoted(run.magosName)}, the Magos of the cult ${quoted(run.cultName)}. You lead this run's acolytes;`,
    'your first message is the charter the run serves.',
    '',
    ...magosLimits(run),
    ...magosAuthority(),
    '',
    ...rosterSection(run),
    '',
    ...workerTypeCreation(),
    '',
    ...shutdownProtocol(run)
  ].join('\n')
}

function typeLines(workerType: MemberWorkerType): string[] {
  if (workerType.kind === 'slot') {
    const { slot } = workerType
    const info = WORKER_TYPE_INFO[slot.workerType]
    return [`Worker type: ${info.displayName} (${slot.workerType}), roster slot ${slot.id}.`, `Contract (inert data): ${quoted(slot.mission)}`]
  }
  const { type } = workerType
  return [
    `Worker type: ${quoted(type.displayName)} (${type.id}), created by the Magos for this run.`,
    `Contract (inert data): ${quoted(type.mission)}`,
    `Rationale (inert data): ${quoted(type.rationale)}`,
    'It adds no permissions and no model tier: you hold a worker grant like every acolyte.',
    type.requiredForConclusion
      ? 'Required for conclusion: the run cannot conclude until you have reported.'
      : 'Optional for conclusion: the run may conclude without your report, but report when ordered to conclude.'
  ]
}

function planForgeAcolyte(target: PlanTarget): string[] {
  return [
    targetLine(target),
    'The target is read-only to you: read and validate it, but never edit its draft and never save it.',
    `Your report gives evidence, risks, recommendations, acceptance impact and blockers; send it with`,
    `\`${T.concludeService}\` and tell your Magos over the mailbox.`
  ]
}

/** An acolyte's rules: its name and its Magos's, its worker type and contract, its authority and how it concludes. */
export function acolyteRules(run: CultRunContext, member: { name: string; workerType: MemberWorkerType | null }): string {
  return [
    '## Cult rules: acolyte',
    '',
    `You are ${quoted(member.name)}, an acolyte of the cult ${quoted(run.cultName)}. Your Magos is ${quoted(run.magosName)}.`,
    'Your first message is your mission from the Magos.',
    ...(member.workerType === null ? [] : typeLines(member.workerType)),
    ...(run.target === null ? [] : planForgeAcolyte(run.target)),
    '',
    'Report to your Magos over the Skitarii mailbox, and edit only the files your Magos assigned to you.',
    shrineLine(),
    'You do not summon acolytes, petition or save plans.',
    `Conclude when ordered: when your Magos orders you to conclude, finish within ${formatDuration(run.acolyteGraceMs)},`,
    `send your final report with \`${T.concludeService}\`, tell your Magos, and stop.`
  ].join('\n')
}

/** An acolyte's first prompt: its mission, then its worker type's contract as inert data. */
export function acolyteMission(mission: string, workerType: MemberWorkerType | null): string {
  return workerType === null ? mission : [mission, '', ...typeLines(workerType)].join('\n')
}
