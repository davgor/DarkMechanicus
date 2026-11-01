/**
 * Claude's memory guards for a chat terminal (`docs/design/chat-shells.md`, "Claude's memory guards"): before
 * each Claude start main writes `userData/agents/settings/<chat id>.json`, which the launch passes with
 * `--settings <path>`. It holds, in Claude Code's own settings format (checked against the installed 2.1.291):
 *
 * - `autoMemoryDirectory`: the pinned folder of `claudeMemoryGuard.ts`, which moves the CLI's memory-folder
 *   carve-out to a folder nothing reads;
 * - a `PreToolUse` command hook on the write tools, running the app's hook script (`claudeMemoryHook.ts`, built
 *   to `out/main/` beside `cli.js`) with the app's runtime, the chat folder, the home folder and the temp folder.
 *
 * The runtime is the chat's `dm` runtime (the app executable when packaged), which needs `ELECTRON_RUN_AS_NODE`,
 * and the terminal's environment holds none. On macOS the hook command is therefore a launcher-style `/bin/sh`
 * script beside the settings, `<chat id>.memory-hook` (0700): it sets the switch for its own process, and every
 * path in it is single-quoted, as in the `dm` launcher. The hook command names it, single-quoted, because Claude
 * Code runs a hook command through a shell (`/bin/sh -c`). The CLI lets a call through when a hook exits with an
 * error, so the launcher prints the ask answer itself when the runtime cannot start or the script fails. On Windows
 * the hook uses the CLI's exec form (`command` and `args`), which Claude Code starts with no shell, so neither Git
 * Bash nor PowerShell parses a path; the command line is then built with libuv's quoting, which
 * `windowsCommandLine` reproduces, and `ELECTRON_RUN_AS_NODE` comes from the terminal's environment, where it stays
 * on Windows (`terminalEnv.ts`). There nothing stands between a hook that cannot start and the CLI, so such a
 * failure lets the write through (a known limitation; the moved `autoMemoryDirectory` still makes the CLI ask for
 * the real memory folders).
 */
import { join, posix, win32 } from 'node:path'
import { chatIdSchema, type DarkMechanicusCli } from '../../shared/agents/chat'
import { MEMORY_HOOK_ASK_OUTPUT, MEMORY_WRITE_TOOLS, pinnedMemoryFolder } from './claudeMemoryGuard'
import { pinnedCliScript, shellQuote } from './dmLauncher'
import { writePrivateFile } from './privateFile'

/** The hook script's file name, beside `cli.js` in `out/main/`. */
export const MEMORY_HOOK_SCRIPT = 'claudeMemoryHook.js'

/** A command hook in Claude Code's settings: a shell command, or in exec form a program and its arguments. */
type CommandHook = { type: 'command'; command: string; args?: string[] }

/** The settings file's content. */
export interface ClaudeSettings {
  autoMemoryDirectory: string
  hooks: { PreToolUse: [{ matcher: string; hooks: [CommandHook] }] }
}

interface ClaudeSettingsPaths {
  settings: string
  /** The macOS hook launcher; null on Windows, which has none. */
  hookLauncher: string | null
}

interface ClaudeSettingsOptions {
  userData: string
  chatId: string
  platform: NodeJS.Platform
  /** `resolveLaunchFolder`'s path: the folder the hook resolves relative paths from. */
  folder: string
  /** The chat's `dm` invocation, pinned to `folder`: its runtime runs the hook, whose script lies beside its own. */
  cli: Pick<DarkMechanicusCli, 'command' | 'args'>
  /** main's home folder and temp folder, which the path rules and the pinned memory folder start from. */
  home: string
  tmp: string
}

/** Where a chat's settings go. The chat id names files, so anything but a chat id is refused. */
export function claudeSettingsPaths(userData: string, chatId: string, platform: NodeJS.Platform): ClaudeSettingsPaths {
  if (!chatIdSchema.safeParse(chatId).success) {
    throw new Error(`${JSON.stringify(chatId)} is not a chat id.`)
  }
  const folder = join(userData, 'agents', 'settings')
  return { settings: join(folder, `${chatId}.json`), hookLauncher: platform === 'win32' ? null : join(folder, `${chatId}.memory-hook`) }
}

/**
 * The macOS launcher's text: `runtime` runs `script` with `args`, as Node, every path single-quoted; when that
 * fails (no runtime, a script that throws), the launcher prints the ask answer, so the call asks.
 */
export function memoryHookLauncherScript(runtime: string, script: string, args: readonly string[]): string {
  return [
    '#!/bin/sh',
    '# The Claude Code memory-folder hook for one chat, written by the app at each start.',
    'ELECTRON_RUN_AS_NODE=1',
    'export ELECTRON_RUN_AS_NODE',
    `${[runtime, script, ...args].map(shellQuote).join(' ')} || printf '%s\\n' ${shellQuote(MEMORY_HOOK_ASK_OUTPUT)}`,
    ''
  ].join('\n')
}

/** The hook script and its arguments, for a `dm` invocation that must be pinned to `options.folder`. */
function hookCommand(options: ClaudeSettingsOptions): { script: string; args: string[] } {
  const flavour = options.platform === 'win32' ? win32 : posix
  const script = flavour.join(flavour.dirname(pinnedCliScript(options.cli, options.folder)), MEMORY_HOOK_SCRIPT)
  return { script, args: [options.folder, options.home, options.tmp] }
}

export function claudeSettings(options: ClaudeSettingsOptions): ClaudeSettings {
  const { script, args } = hookCommand(options)
  const paths = claudeSettingsPaths(options.userData, options.chatId, options.platform)
  const hook: CommandHook =
    paths.hookLauncher === null ? { type: 'command', command: options.cli.command, args: [script, ...args] } : { type: 'command', command: shellQuote(paths.hookLauncher) }
  return {
    autoMemoryDirectory: pinnedMemoryFolder({ env: {}, home: options.home, tmp: options.tmp, platform: options.platform }),
    hooks: { PreToolUse: [{ matcher: MEMORY_WRITE_TOOLS, hooks: [hook] }] }
  }
}

/** Writes the chat's settings and, on macOS, the hook launcher they name, replacing the last start's; returns the settings path. */
export async function writeClaudeSettings(options: ClaudeSettingsOptions): Promise<string> {
  const settings = claudeSettings(options)
  const paths = claudeSettingsPaths(options.userData, options.chatId, options.platform)
  if (paths.hookLauncher !== null) {
    const { script, args } = hookCommand(options)
    await writePrivateFile(paths.hookLauncher, memoryHookLauncherScript(options.cli.command, script, args), 0o700)
  }
  await writePrivateFile(paths.settings, `${JSON.stringify(settings, null, 2)}\n`, 0o600)
  return paths.settings
}
