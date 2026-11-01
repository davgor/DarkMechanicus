/**
 * The files main writes for a chat before its terminal starts, all under `userData/agents/`: the instructions,
 * `instructions/<chat id>.md`, rewritten at each start, and on macOS the chat's `dm` launcher,
 * `bin/<chat id>/dm` (see `dmLauncher.ts`). The Claude settings file is written by `claudeSettingsFile.ts` in the
 * same pre-start step, and only passed through here.
 */
import { join, posix } from 'node:path'
import { chatIdSchema, type ChatRole, type DarkMechanicusCli } from '../../shared/agents/chat'
import { cliInstructions } from '../agents/cliInstructions'
import { orchestratorGuidance } from '../agents/orchestratorKickoff'
import { DM_LAUNCHER_NAME, dmLauncherScript, pinnedCliScript, writeDmLauncher } from './dmLauncher'
import { writePrivateFile } from './privateFile'

export interface TerminalFiles {
  /** The instructions file written for this start. */
  instructions: string
  /** Claude's settings file, when one was written for this chat; Claude starts without `--settings` otherwise. */
  claudeSettings?: string
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
}

/**
 * The chat's instructions: how to run `dm`, named by the launcher's absolute path where there is one; then, for the
 * chat Start run opened, the orchestrator and worker guidance (`orchestratorGuidance`).
 */
export function terminalInstructions(options: InstructionOptions): string {
  const dm = options.launcherDir === null ? options.cli : { command: posix.join(options.launcherDir, DM_LAUNCHER_NAME), args: [], env: {} }
  const text = cliInstructions({ cli: dm, role: options.role, allowSave: options.allowSave })
  return options.orchestratesRun ? `${text}\n\n${orchestratorGuidance()}` : text
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
}

/** Writes the chat's instructions and, on macOS, its launcher, before a start; returns where they are. */
export async function writeTerminalFiles(options: WriteOptions): Promise<TerminalFiles> {
  const files = terminalFilePaths(options.userData, options.chatId, options.platform)
  pinnedCliScript(options.cli, options.folder)
  if (files.launcherDir !== null) {
    await writeDmLauncher(files.launcherDir, dmLauncherScript(options.cli, options.folder))
  }
  const { cli, role, allowSave, orchestratesRun } = options
  const text = terminalInstructions({ cli, role, allowSave, orchestratesRun, launcherDir: files.launcherDir })
  await writePrivateFile(files.instructions, text, 0o600)
  return files
}
