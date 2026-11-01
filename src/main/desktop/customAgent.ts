/**
 * Adding and editing a custom agent CLI: a program the person picked, started with arguments they typed.
 * Every step is a guard against a compromised renderer or a mistake, in this order, and nothing is stored
 * unless every one passes:
 * 1. The payload is checked strictly: name and arguments for an add; id, name, arguments and `repick` for an
 *    edit. Any other key (a path, a protocol, `__proto__`) is `invalid_input`.
 *    A name is 1-64 characters once trimmed and unique among custom agents whatever its case (`conflict`);
 *    there are at most 32 arguments of 1-1024 characters; neither holds a control or formatting character
 *    (bidi overrides and isolates, zero-width marks, line separators), so the confirmation shows exactly
 *    what will run; and `{folder}` appears only as a whole argument (`launchSpec.ts`).
 * 2. The program comes from main's native file dialog (on an edit only with `repick`; otherwise it stays
 *    the stored one). Its path must hold no such character either.
 * 3. The program and the argv, `{folder}` replaced by a sample path, must pass `planCliLaunch` on this
 *    platform (a file the system would run; a Windows shim argument cmd.exe can be given safely).
 * 4. A native confirmation shows the exact program and each argument (as a JSON string). Only Run and save
 *    with the checkbox ticked goes on.
 * 5. The row is written: `cu_` and a ULID, kind and `connected_via` `custom`, and the arguments, with no protocol.
 *    Nothing is run to check it, so no version is stored: the CLI first runs in a chat's terminal. An edit fails
 *    `not_found` if the agent was removed meanwhile. The name is checked again in the same synchronous step that
 *    writes it.
 *
 * A row marked `needsReview` (saved for ACP or Codex app-server before chats became terminals, `appDatabase.ts`
 * v3) starts no chat until it is reviewed: an edit like any other, whose confirmation is titled as a review and
 * says why. Only a confirmed edit clears the mark.
 *
 * Two adds or edits that would end with the same name are not run side by side: the second is refused
 * with `conflict` while the first is open, as is a second edit of the same agent.
 */
import { z } from 'zod'
import { DomainError } from '../../core/errors'
import { newUlid } from '../../core/ids'
import { parseInput } from '../../core/schemas'
import { agentIdSchema, isBuiltInAgentKind } from '../../shared/desktop/agentKinds'
import type {
  AgentFindResult,
  AgentId,
  AgentRefusalCode,
  AgentView,
  CustomAgentRequest,
  CustomAgentUpdate
} from '../../shared/desktop/api'
import { withFolder } from '../agents/launchSpec'
import { planCliLaunch, type AgentProbeDeps } from './agentProbe'
import type { AgentRegistry } from './agentRegistry'

const MAX_NAME_CHARS = 64
const MAX_ARGS = 32
const MAX_ARG_CHARS = 1024
/**
 * Control (NUL included), format (bidi overrides and isolates, zero-width marks, the BOM), other
 * default-ignorable (invisible fillers, variation selectors), line and paragraph separators, and lone
 * surrogates: what could hide, reorder or break what the confirmation shows.
 */
const HIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cs}\p{Zl}\p{Zp}]/u
const HIDDEN_MESSAGE = 'holds a control or formatting character'
/** Any space but the plain one (no-break, ideographic, em): it reads as a space but is not one to the program. */
const OTHER_SPACE = /(?! )\p{Zs}/u
const OTHER_SPACE_MESSAGE = 'holds a space that is not a plain space'
/** What `{folder}` stands for while the argv is checked: a plain folder on each platform. */
const SAMPLE_FOLDER: Readonly<Record<'win32' | 'other', string>> = {
  win32: 'C:\\Users\\Sample\\Project',
  other: '/home/sample/project'
}

const nameSchema = z
  .string()
  .trim()
  .overwrite((name) => name.normalize('NFC'))
  .min(1, 'is empty')
  .max(MAX_NAME_CHARS, `is longer than ${MAX_NAME_CHARS} characters`)
  .refine((name) => !HIDDEN_TEXT.test(name), HIDDEN_MESSAGE)
  .refine((name) => !OTHER_SPACE.test(name), OTHER_SPACE_MESSAGE)

/** The `{folder}` rule is `withFolder`'s own, so the check and every start agree. */
function wholeFolder(arg: string): boolean {
  try {
    withFolder([arg], SAMPLE_FOLDER.other)
    return true
  } catch {
    return false
  }
}

const argsSchema = z
  .array(
    z
      .string()
      .min(1, 'is empty')
      .max(MAX_ARG_CHARS, `is longer than ${MAX_ARG_CHARS} characters`)
      .refine((arg) => !HIDDEN_TEXT.test(arg), HIDDEN_MESSAGE)
      .refine((arg) => !OTHER_SPACE.test(arg), OTHER_SPACE_MESSAGE)
      .refine(wholeFolder, '{folder} must be an argument of its own')
  )
  .max(MAX_ARGS, `has more than ${MAX_ARGS} arguments`)

const addSchema = z.strictObject({
  name: nameSchema,
  args: argsSchema
}) satisfies z.ZodType<CustomAgentRequest>

const updateSchema = z.strictObject({
  id: agentIdSchema.refine((id) => !isBuiltInAgentKind(id), 'is not a custom agent'),
  name: nameSchema,
  args: argsSchema,
  repick: z.boolean()
}) satisfies z.ZodType<CustomAgentUpdate>

/** What the person is asked to approve: exactly what will be stored and started. `review`: an edit of a row marked `needsReview`. */
export interface CustomAgentConfirmation {
  action: 'add' | 'edit' | 'review'
  name: string
  executablePath: string
  args: readonly string[]
}

interface CustomAgentDeps {
  agents: Pick<AgentRegistry, 'list' | 'get' | 'addCustom' | 'updateCustom'>
  /** Main's native file dialog for the program; null when the person cancels. The only source of a path. */
  pickExecutable: () => Promise<string | null>
  /** Main's native confirmation; resolves true only for an explicit yes. */
  confirm: (confirmation: CustomAgentConfirmation) => Promise<boolean>
  /** The launch rules of this platform, as every start uses them. */
  launch: Pick<AgentProbeDeps, 'platform' | 'inspect' | 'comspec'>
  /** A new agent's id; `cu_` and a fresh ULID by default. */
  newId?: () => AgentId
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface CustomAgents {
  add(request: unknown): Promise<AgentFindResult>
  update(request: unknown): Promise<AgentFindResult>
}

const CANCELLED: AgentFindResult = { outcome: 'cancelled' }

function refused(code: AgentRefusalCode, reason: string): AgentFindResult {
  return { outcome: 'refused', code, reason }
}

/** Names are compared as the person reads them: one form, any case. */
function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/** Refuses a name another custom agent (not `self`) already has. */
function assertNameFree(agents: Pick<AgentRegistry, 'list'>, name: string, self: AgentId | null): void {
  const key = nameKey(name)
  const taken = agents.list().some((agent) => agent.kind === 'custom' && agent.id !== self && nameKey(agent.displayName) === key)
  if (taken) {
    throw new DomainError('conflict', `A custom CLI named ${JSON.stringify(name)} is already connected. Choose another name.`)
  }
}

/** Why the program and argv cannot be started on this platform, or null when they can. */
function launchRefusal(confirmation: CustomAgentConfirmation, launch: CustomAgentDeps['launch']): AgentFindResult | null {
  const { executablePath, args } = confirmation
  if (HIDDEN_TEXT.test(executablePath)) {
    return refused('unsafe_path', 'The path of that program holds a control or formatting character, so it cannot be shown or started safely.')
  }
  const sample = launch.platform === 'win32' ? SAMPLE_FOLDER.win32 : SAMPLE_FOLDER.other
  const plan = planCliLaunch(executablePath, withFolder(args, sample), launch)
  return 'ok' in plan ? refused(plan.code, plan.reason) : null
}

type Store = () => AgentView

/** Launch rules and the confirmation; `store` runs only once both said yes. */
async function confirmAndStore(deps: CustomAgentDeps, confirmation: CustomAgentConfirmation, store: Store): Promise<AgentFindResult> {
  const refusal = launchRefusal(confirmation, deps.launch)
  if (refusal !== null) {
    return refusal
  }
  if (!(await deps.confirm(confirmation))) {
    return CANCELLED
  }
  return { outcome: 'connected', agent: store() }
}

/** Runs `work` holding `keys`; a key already held is refused with `conflict`, and every key is let go afterwards. */
async function holding<T>(held: Set<string>, keys: readonly string[], work: () => Promise<T>): Promise<T> {
  if (keys.some((key) => held.has(key))) {
    throw new DomainError('conflict', 'A custom CLI with that name, or this custom CLI, is being saved already. Finish that first.')
  }
  keys.forEach((key) => held.add(key))
  try {
    return await work()
  } finally {
    keys.forEach((key) => held.delete(key))
  }
}

async function addAgent(deps: CustomAgentDeps, held: Set<string>, input: unknown): Promise<AgentFindResult> {
  const { name, args } = parseInput(addSchema, input, 'custom CLI')
  assertNameFree(deps.agents, name, null)
  return holding(held, [`name:${nameKey(name)}`], async () => {
    const executablePath = await deps.pickExecutable()
    if (executablePath === null) {
      return CANCELLED
    }
    return confirmAndStore(deps, { action: 'add', name, executablePath, args }, () => {
      assertNameFree(deps.agents, name, null)
      const id = deps.newId?.() ?? `cu_${newUlid()}`
      return deps.agents.addCustom({ id, displayName: name, executablePath, args })
    })
  })
}

function customAgent(agents: Pick<AgentRegistry, 'get'>, id: AgentId): AgentView {
  const agent = agents.get(id)
  if (agent === null || agent.kind !== 'custom') {
    throw new DomainError('not_found', `No custom CLI has the id ${id}. It may have been removed.`)
  }
  return agent
}

async function updateAgent(deps: CustomAgentDeps, held: Set<string>, input: unknown): Promise<AgentFindResult> {
  const { id, name, args, repick } = parseInput(updateSchema, input, 'custom CLI edit')
  const existing = customAgent(deps.agents, id)
  assertNameFree(deps.agents, name, id)
  return holding(held, [`name:${nameKey(name)}`, `id:${id}`], async () => {
    const executablePath = repick ? await deps.pickExecutable() : existing.executablePath
    if (executablePath === null) {
      return CANCELLED
    }
    const confirmation: CustomAgentConfirmation = { action: existing.needsReview ? 'review' : 'edit', name, executablePath, args }
    return confirmAndStore(deps, confirmation, () => {
      assertNameFree(deps.agents, name, id)
      const updated = deps.agents.updateCustom(id, { displayName: name, executablePath, args })
      if (updated === null) {
        throw new DomainError('not_found', `The custom CLI ${JSON.stringify(name)} was removed while it was being edited; nothing was saved.`)
      }
      return updated
    })
  })
}

export function createCustomAgents(deps: CustomAgentDeps): CustomAgents {
  const held = new Set<string>()
  return {
    add: (input) => addAgent(deps, held, input),
    update: (input) => updateAgent(deps, held, input)
  }
}

/** The shape of the native confirmation (assignable to Electron's message box options). */
interface CustomAgentDialogOptions {
  type: 'question'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: true
  checkboxLabel: string
  checkboxChecked: false
}

/** A yes is a click on Run and save with the checkbox ticked: one click a renderer timed under the pointer is not enough. */
export function customAgentApproved(answer: { response: number; checkboxChecked: boolean }): boolean {
  return answer.response === 0 && answer.checkboxChecked
}

const DIALOG_VERBS: Readonly<Record<CustomAgentConfirmation['action'], string>> = { add: 'Add', edit: 'Edit', review: 'Review' }

/** Why a review asks again: the arguments were for a protocol server, which a terminal does not talk to. */
const REVIEW_NOTE =
  'These arguments were saved before chats ran in a terminal, for a protocol (ACP or Codex app-server) the app no longer speaks. Remove any that start a protocol server: no chat starts this CLI until you confirm them.'

/**
 * Every argument on a numbered line of its own, as a JSON string, so where one ends is never in doubt (a
 * quote inside shows as `\"`; a newline or a bidi character cannot reach here). Cancel is the default and
 * the escape answer, and the checkbox starts unticked.
 */
export function customAgentDialogOptions(confirmation: CustomAgentConfirmation): CustomAgentDialogOptions {
  const { args } = confirmation
  const argLines =
    args.length === 0 ? 'Arguments: none' : ['Arguments:', ...args.map((arg, index) => `  ${index + 1}. ${JSON.stringify(arg)}`)].join('\n')
  const detail = [
    `Program: ${confirmation.executablePath}`,
    argLines,
    ...(confirmation.action === 'review' ? [REVIEW_NOTE] : []),
    "It runs in a chat's terminal whenever a chat uses it, with {folder} replaced by the chat's folder.",
    'Nothing is saved until you tick the box and choose Run and save.'
  ].join('\n\n')
  const verb = DIALOG_VERBS[confirmation.action]
  return {
    type: 'question',
    title: `${verb} a custom CLI`,
    message: `Run this command and save it as ${JSON.stringify(confirmation.name)}?`,
    detail,
    buttons: ['Run and save', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    checkboxLabel: 'I have checked this command',
    checkboxChecked: false
  }
}

/** The shape of the native open dialog for a custom CLI's program (assignable to Electron's options). */
interface ExecutableDialogOptions {
  title: string
  properties: ('openFile' | 'showHiddenFiles' | 'noResolveAliases')[]
  filters: { name: string; extensions: string[] }[]
}

/**
 * Files only, hidden folders such as `~/.local/bin` reachable; Windows lists its programs first.
 * Links are kept as picked (`noResolveAliases`, macOS): `~/.local/bin/claude` is stored, not the
 * versioned file it points to today, so an update that replaces the target keeps the CLI working.
 */
export function customExecutableDialogOptions(platform: string): ExecutableDialogOptions {
  const all = { name: 'All files', extensions: ['*'] }
  return {
    title: 'Choose the program of the custom CLI',
    properties: ['openFile', 'showHiddenFiles', 'noResolveAliases'],
    filters: platform === 'win32' ? [{ name: 'Programs', extensions: ['exe', 'cmd'] }, all] : [all]
  }
}
