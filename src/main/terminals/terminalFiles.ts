/**
 * The files main writes for a chat before its terminal starts, all under `userData/agents/`: the instructions,
 * `instructions/<chat id>.md`, rewritten at each start, and on macOS the chat's `dm` launcher,
 * `bin/<chat id>/dm` (see `dmLauncher.ts`). The Claude settings file is written by `claudeSettingsFile.ts` in the
 * same pre-start step, and only passed through here.
 *
 * An OMP chat whose grant is bound to its mailbox also gets, per launch, the private descriptor its Skitarii mail client
 * reads (`resources/skitarii/extension/dmClient.ts`): `omp/<chat id>/dm-client/<generation>.json`, inside the chat's
 * own OMP folder, so deleting the chat removes it. It is written after the grant is issued and before the spawn, removed
 * when that launch ends, and a new launch removes any a crash left behind.
 */
import { readdir, rm } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import {
  DM_CLIENT_DESCRIPTOR_DIR,
  DM_CLIENT_DESCRIPTOR_VERSION,
  type DmClientDescriptor
} from '../../../resources/skitarii/extension/dmClient'
import { chatIdSchema, type ChatRole, type DarkMechanicusCli } from '../../shared/agents/chat'
import type { ReachTarget } from '../agents/chatReach'
import { cliInstructions, skitariiMailGuidance } from '../agents/cliInstructions'
import type { ConversationTarget } from '../agents/conversationMessage'
import { transferGuidance } from '../../mcp/transferKickoff'
import { kanbanGuidance } from '../agents/kanbanKickoff'
import { orchestratorGuidance } from '../agents/orchestratorKickoff'
import { skillBody } from '../../mcp/skills'
import { dmClientRuntime } from '../desktop/cliConfig'
import { forgeAgentContext, forgeWorldAt } from '../desktop/forgeContext'
import type { WorldMailDescriptor } from '../../../resources/skitarii/extension/worldDmClient'
import { DM_LAUNCHER_NAME, dmLauncherScript, pinnedCliScript, writeDmLauncher } from './dmLauncher'
import { ompFilePaths } from './ompSession'
import { writePrivateFile } from './privateFile'

export interface TerminalFiles {
  /** The instructions file written for this start. */
  instructions: string
  /** Claude's settings file, when one was written for this chat; Claude starts without `--settings` otherwise. */
  claudeSettings?: string
  /**
   * OMP's per-chat session folder and config overlay (`ompSession.ts`), for an OMP chat, the Skitarii extension
   * it is launched with (`ompSkitariiExtension.ts`), and the launch's mail client descriptor when it has a mailbox.
   */
  omp?: { sessionDir: string; config: string; extension: string; dmClient?: string }
  /** The folder holding the chat's `dm` launcher (macOS); null on Windows, which has none. */
  launcherDir: string | null
}

/** Where a chat's files go. The chat id names files, so anything but a chat id is refused. */
export function terminalFilePaths(userData: string, chatId: string, platform: NodeJS.Platform): TerminalFiles {
  if (!chatIdSchema.safeParse(chatId).success) {
    throw new Error(`${JSON.stringify(chatId)} is not a chat id.`)
  }
  const agents = join(userData, 'agents')
  return { instructions: join(agents, 'instructions', `${chatId}.md`), launcherDir: platform === 'win32' ? null : join(agents, 'bin', chatId) }
}

interface InstructionOptions {
  forgeWorld?: boolean
  repositoryContext?: string
  cli: DarkMechanicusCli
  role: ChatRole
  allowSave: boolean
  /** The chat's launcher folder; null where there is no launcher and the `dm` invocation is named as it is. */
  launcherDir: string | null
  /** Whether the chat orchestrates a run (the chat Start run opened, with a `runId`): its guidance follows. */
  orchestratesRun: boolean
  /** The epic a Linear transfer chat moves (the chat's `transferEpicId`): the transfer guidance follows. Absent for every other chat. */
  transferEpicId?: string
  /** The Kanban card the chat Play opened carries (the chat's `cardId`): the card guidance follows. Absent for every other chat. */
  cardId?: string
  /** The board conversation this chat answers; its answer-only guidance follows. Absent for every unbound chat. */
  conversation?: ConversationTarget
  nameFirstPrompt?: boolean
  /** Whether the chat runs OMP (Skitarii), whose launch may get a mailbox: the Skitarii mail guidance follows the policy. */
  skitariiMail?: boolean
  /** A project-less chat's folders and token files (`chatReach.ts`); absent for a chat of a folder. */
  reach?: readonly ReachTarget[]
}

/** Keeps a board-bound chat answering its named record instead of assuming execution authority. */
function conversationGuidance(conversation: ConversationTarget): string {
  const reply =
    'cardId' in conversation
      ? `add_kanban_message ${JSON.stringify({ cardId: conversation.cardId })}`
      : `add_comment ${JSON.stringify(
          conversation.ticketId === undefined
            ? { epicId: conversation.epicId }
            : { epicId: conversation.epicId, ticketId: conversation.ticketId }
        )}`
  return [
    '=== Board conversation guidance ===',
    'This chat is bound to a board conversation and exists to answer the person there.',
    `Reply on the record with ${reply}.`,
    'Answer only: do not start or take over a run, claim work or save a plan unless the person explicitly asks.'
  ].join('\n')
}

/** The guidance for what the chat is for: Skitarii mail, the run it orchestrates, the epic it transfers, the card it carries. */
function taskGuidance(options: InstructionOptions): string[] {
  return [
    ...(options.skitariiMail === true ? [skitariiMailGuidance()] : []),
    ...(options.skitariiMail === true && options.forgeWorld === true ? ['## Forge World mail\n\nThis chat has one local mailbox per available member project. Native dm_agent_identity and dm_agent_peers list them with project names. Set the project argument on dm_message_send, dm_inbox_read, dm_inbox_ack and dm_call to select that member. Inbox sequence cursors and message ids belong to their project; retain the project when replying or acknowledging. A project selector never adds a grant. Read get_project for the chosen member before planning or delivering work.'] : []),
    ...(options.orchestratesRun ? [orchestratorGuidance()] : []),
    ...(options.transferEpicId === undefined ? [] : [transferGuidance(options.transferEpicId)]),
    ...(options.cardId === undefined ? [] : [kanbanGuidance(options.cardId)]),
    ...(options.conversation === undefined ? [] : [conversationGuidance(options.conversation)])
  ]
}

/**
 * The chat's instructions: how to run `dm`, then the shared collaboration policy for every chat.
 * Task-specific run, Linear transfer or Kanban guidance follows, so even a new session retains its task.
 */
export function terminalInstructions(options: InstructionOptions): string {
  const dm = options.launcherDir === null ? options.cli : { command: posix.join(options.launcherDir, DM_LAUNCHER_NAME), args: [], env: {} }
  const sections = [
    cliInstructions({ cli: dm, role: options.role, allowSave: options.allowSave, noLauncher: options.launcherDir === null, ...(options.reach === undefined ? {} : { reach: options.reach }), ...(options.forgeWorld === undefined ? {} : { forgeWorld: options.forgeWorld }) }),
    skillBody('collaboration'),
    ...(options.repositoryContext ? [options.repositoryContext] : []),
    ...(options.forgeWorld ? ['This world-level chat has no project mailbox. Use the per-project dm commands above; open a project-level agent when its Skitarii mailbox is needed.'] : []),
    ...taskGuidance(options)
  ]
  // A project-less chat that reaches no folder has no dm line to name itself with.
  if (options.nameFirstPrompt && options.reach?.length !== 0) sections.push([
    '## First-message chat naming',
    'Before acting on the first user message, infer its intent with your selected model and report a concise semantic title, normally 2–5 words and never more than five.',
    options.reach === undefined
      ? 'Use the dm invocation above with: call name_chat \'{"title":"your inferred intent label"}\'.'
      : 'Use the dm line of any folder above with: call name_chat \'{"title":"your inferred intent label"}\'.',
    'Do not copy the prompt, take its first words, truncate it, or use a canned category. For example, a conversational question about sign-in after expiry can become "Repair expired-session sign-in".',
    'This is metadata only: keep and act on the complete original user message exactly once. Never ask the user to resend it for naming. A manual name always wins; applied:false means leave it alone.',
    'If your model cannot infer the intent, report the real problem using call name_chat \'{"error":"concise real inference failure"}\'; never substitute a prefix. Do not claim naming succeeded unless the command succeeds.'
  ].join('\n'))
  return sections.join('\n\n')
}

interface WriteOptions {
  /** A trusted conflict resolver may start with unreadable repository metadata, on its existing scope. */
  forgeResolver?: boolean
  userData: string
  chatId: string
  platform: NodeJS.Platform
  /**
   * `resolveLaunchFolder`'s path: the launcher's `--repo`, and the folder the `dm` invocation must be pinned to; for a
   * project-less chat (`reach` set), its scratch folder, and the invocation is pinned to none.
   */
  folder: string
  cli: DarkMechanicusCli
  role: ChatRole
  allowSave: boolean
  orchestratesRun: boolean
  transferEpicId?: string
  cardId?: string
  conversation?: ConversationTarget
  nameFirstPrompt?: boolean
  skitariiMail?: boolean
  /** A project-less chat's folders and token files (`chatReach.ts`); absent for a chat of a folder. */
  reach?: readonly ReachTarget[]
}

/** Writes the chat's instructions and, on macOS, its launcher, before a start; returns where they are. */
function isWorldLaunch(options: WriteOptions): boolean {
  return options.reach !== undefined && (options.forgeResolver === true || forgeWorldAt(options.folder) !== undefined)
}

export async function writeTerminalFiles(options: WriteOptions): Promise<TerminalFiles> {
  const files = terminalFilePaths(options.userData, options.chatId, options.platform)
  const pin = options.reach === undefined ? options.folder : null
  pinnedCliScript(options.cli, pin)
  if (files.launcherDir !== null) {
    await writeDmLauncher(files.launcherDir, dmLauncherScript(options.cli, pin))
  }
  const { cli, role, allowSave, orchestratesRun, transferEpicId, cardId, conversation, nameFirstPrompt, skitariiMail, reach } = options
  const text = terminalInstructions({
    forgeWorld: isWorldLaunch(options),
    repositoryContext: forgeAgentContext(options.folder, options.forgeResolver),
    cli,
    role,
    allowSave,
    orchestratesRun,
    ...(nameFirstPrompt === undefined ? {} : { nameFirstPrompt }),
    ...(skitariiMail === undefined ? {} : { skitariiMail }),
    ...(transferEpicId === undefined ? {} : { transferEpicId }),
    ...(cardId === undefined ? {} : { cardId }),
    ...(conversation === undefined ? {} : { conversation }),
    ...(reach === undefined ? {} : { reach }),
    launcherDir: files.launcherDir
  })
  await writePrivateFile(files.instructions, text, 0o600)
  return files
}

/**
 * What the mail client's child inherits from the chat's process, by name: what the runtime, Git and the person's
 * locale need. Nothing else passes on, so provider keys and runtime injection (`NODE_OPTIONS`, `BUN_*`, `LD_PRELOAD`)
 * stay behind; `PATH` is inherited for Git, never searched for the runtime.
 */
const DM_CLIENT_INHERITED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP']
const DM_CLIENT_INHERITED_WINDOWS = ['PATHEXT', 'SystemRoot', 'windir', 'SystemDrive', 'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'HOMEDRIVE', 'HOMEPATH']

/** A launch generation names its descriptor, so it must be a plain id (`randomUUID`). */
const GENERATION = /^[A-Za-z0-9_-]{1,128}$/

/** The folder of a chat's descriptors: inside its own OMP folder (`ompFilePaths`). */
function dmClientDir(userData: string, chatId: string): string {
  return join(dirname(ompFilePaths(userData, chatId).config), DM_CLIENT_DESCRIPTOR_DIR)
}

export function dmClientDescriptorPath(userData: string, chatId: string, generation: string): string {
  if (!GENERATION.test(generation)) {
    throw new Error(`${JSON.stringify(generation)} is not a launch generation.`)
  }
  return join(dmClientDir(userData, chatId), `${generation}.json`)
}

interface DmClientOptions {
  userData: string
  chatId: string
  /** The launch it is for (`Live.generation`). */
  generation: string
  /** `resolveLaunchFolder`'s path, which the CLI must be pinned to. */
  folder: string
  /** The chat's `dm` invocation (`issueChatCli`); only its runtime and pinned script are written. */
  cli: DarkMechanicusCli
  platform: NodeJS.Platform
}

/** The descriptor for one launch: the pinned runtime and folder, and the inherited names; never a grant. */
function dmClientDescriptor(options: Omit<DmClientOptions, 'userData'>): DmClientDescriptor {
  const runtime = dmClientRuntime(options.cli, options.folder)
  return {
    version: DM_CLIENT_DESCRIPTOR_VERSION,
    chatId: options.chatId,
    generation: options.generation,
    folder: options.folder,
    command: runtime.command,
    args: [...runtime.args],
    cwd: options.folder,
    env: runtime.env,
    inherit: options.platform === 'win32' ? [...DM_CLIENT_INHERITED, ...DM_CLIENT_INHERITED_WINDOWS] : [...DM_CLIENT_INHERITED],
    ...(options.cli.env['DM_DESKTOP_PIPE'] === undefined ? {} : { recoveryAddress: options.cli.env['DM_DESKTOP_PIPE'] }),
  }
}

/** Writes the launch's descriptor (0600, in a 0700 folder) after removing the chat's earlier ones; returns its path. */
export async function writeDmClientDescriptor(options: DmClientOptions): Promise<string> {
  const path = dmClientDescriptorPath(options.userData, options.chatId, options.generation)
  const text = `${JSON.stringify(dmClientDescriptor(options), null, 2)}\n`
  const dir = dirname(path)
  const earlier = await readdir(dir).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === 'ENOENT') return []
    throw error
  })
  // One launch of a chat runs at a time, so any other descriptor here is a dead launch's.
  await Promise.all(earlier.map((name) => rm(join(dir, name), { force: true, recursive: true })))
  await writePrivateFile(path, text, 0o600)
  return path
}

/** Project-less recovery context only: deliberately not a valid generic DM client descriptor. */
export async function writeRecoveryClientDescriptor(options: Pick<DmClientOptions, 'userData' | 'chatId' | 'generation'> & { address: string }): Promise<string> {
  const path = dmClientDescriptorPath(options.userData, options.chatId, options.generation)
  const dir = dirname(path)
  const earlier = await readdir(dir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  await Promise.all(earlier.map(name => rm(join(dir, name), { force: true, recursive: true })))
  await writePrivateFile(path, JSON.stringify({ version: 1, chatId: options.chatId, generation: options.generation, recoveryAddress: options.address }), 0o600)
  return path
}

/** Each world route keeps its own folder pin and token file; no grant is copied into the descriptor. */
export async function writeWorldMailDescriptor(options: DmClientOptions & { reach: readonly ReachTarget[] }): Promise<string> {
  const path = dmClientDescriptorPath(options.userData, options.chatId, options.generation)
  const descriptor: WorldMailDescriptor = {
    version: 1, kind: 'forge-world', chatId: options.chatId, generation: options.generation, folder: options.folder,
    routes: options.reach.map(target => ({
      project: posix.basename(target.folder.replaceAll('\\', '/')),
      tokenFile: target.tokenFile,
      descriptor: dmClientDescriptor({ ...options, folder: target.folder, cli: { ...options.cli, args: [...options.cli.args, '--repo', target.folder] } }),
    })),
    ...(options.cli.env.DM_DESKTOP_PIPE === undefined ? {} : { recoveryAddress: options.cli.env.DM_DESKTOP_PIPE }),
  }
  const earlier = await readdir(dirname(path)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  await Promise.all(earlier.map(name => rm(join(dirname(path), name), { force: true, recursive: true })))
  await writePrivateFile(path, JSON.stringify(descriptor), 0o600)
  return path
}

/** Removes a launch's descriptor once it has ended; one already gone is fine. */
export async function removeDmClientDescriptor(path: string): Promise<void> {
  await rm(path, { force: true })
}
