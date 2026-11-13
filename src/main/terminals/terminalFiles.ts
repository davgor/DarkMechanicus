/**
 * The files main writes for a chat before its terminal starts, all under `userData/agents/`: the instructions,
 * `instructions/<chat id>.md`, rewritten at each start, and on macOS the chat's `dm` launcher,
 * `bin/<chat id>/dm` (see `dmLauncher.ts`). The Claude settings file is written by `claudeSettingsFile.ts` in the
 * same pre-start step, and only passed through here.
 */
import { join, posix } from 'node:path'
import { chatIdSchema, type ChatRole, type DarkMechanicusCli } from '../../shared/agents/chat'
import { cliInstructions } from '../agents/cliInstructions'
import { transferGuidance } from '../../mcp/transferKickoff'
import { kanbanGuidance } from '../agents/kanbanKickoff'
import { orchestratorGuidance } from '../agents/orchestratorKickoff'
import { skillBody } from '../../mcp/skills'
import { DM_LAUNCHER_NAME, dmLauncherScript, pinnedCliScript, writeDmLauncher } from './dmLauncher'
import { writePrivateFile } from './privateFile'

export interface TerminalFiles {
  /** The instructions file written for this start. */
  instructions: string
  /** Claude's settings file, when one was written for this chat; Claude starts without `--settings` otherwise. */
  claudeSettings?: string
  /**
   * OMP's per-chat session folder and config overlay (`ompSession.ts`), for an OMP chat, and the Skitarii extension
   * it is launched with (`ompSkitariiExtension.ts`).
   */
  omp?: { sessionDir: string; config: string; extension: string }
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
}

/**
 * The chat's instructions: how to run `dm`, then the shared collaboration policy for every chat.
 * Task-specific run, Linear transfer or Kanban guidance follows, so even a new session retains its task.
 */
export function terminalInstructions(options: InstructionOptions): string {
  const dm = options.launcherDir === null ? options.cli : { command: posix.join(options.launcherDir, DM_LAUNCHER_NAME), args: [], env: {} }
  const sections = [
    cliInstructions({ cli: dm, role: options.role, allowSave: options.allowSave, noLauncher: options.launcherDir === null }),
    skillBody('collaboration')
  ]
  if (options.orchestratesRun) sections.push(orchestratorGuidance())
  if (options.transferEpicId !== undefined) sections.push(transferGuidance(options.transferEpicId))
  if (options.cardId !== undefined) sections.push(kanbanGuidance(options.cardId))
  return sections.join('\n\n')
}

interface WriteOptions {
  userData: string
  chatId: string
  platform: NodeJS.Platform
  /** `resolveLaunchFolder`'s path: the launcher's `--repo`, and the folder the `dm` invocation must be pinned to. */
  folder: string
  cli: DarkMechanicusCli
  role: ChatRole
  allowSave: boolean
  orchestratesRun: boolean
  transferEpicId?: string
  cardId?: string
}

/** Writes the chat's instructions and, on macOS, its launcher, before a start; returns where they are. */
export async function writeTerminalFiles(options: WriteOptions): Promise<TerminalFiles> {
  const files = terminalFilePaths(options.userData, options.chatId, options.platform)
  pinnedCliScript(options.cli, options.folder)
  if (files.launcherDir !== null) {
    await writeDmLauncher(files.launcherDir, dmLauncherScript(options.cli, options.folder))
  }
  const { cli, role, allowSave, orchestratesRun, transferEpicId, cardId } = options
  const text = terminalInstructions({
    cli,
    role,
    allowSave,
    orchestratesRun,
    ...(transferEpicId === undefined ? {} : { transferEpicId }),
    ...(cardId === undefined ? {} : { cardId }),
    launcherDir: files.launcherDir
  })
  await writePrivateFile(files.instructions, text, 0o600)
  return files
}
