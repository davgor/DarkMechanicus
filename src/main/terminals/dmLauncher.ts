/**
 * The chat's `dm` command on macOS: a launcher main writes at each start, `userData/agents/bin/<chat id>/dm`.
 *
 * Packaged, `dm` is the app executable run with `ELECTRON_RUN_AS_NODE=1`. Put in the terminal's environment, that
 * switch would make every Electron program the agent or the person starts there run as Node, so the launcher
 * sets it for its own process alone and `exec`s the runtime. Every path it embeds (the runtime, `cli.js`, the
 * folder) is single-quoted with `'` written as `'\''`, the one quoting `/bin/sh` reads with no expansion at all,
 * and the agent's arguments arrive as `"$@"`, so they never pass through the script's text. Its folder goes first
 * on the terminal's `PATH`, and the instructions name it by its absolute path.
 */
import { join } from 'node:path'
import type { DarkMechanicusCli } from '../../shared/agents/chat'
import { writePrivateFile } from './privateFile'

/** The launcher's file name in its chat's folder. */
export const DM_LAUNCHER_NAME = 'dm'

/**
 * The script of a `dm` invocation pinned to `folder`: the invocation must be exactly `[<script>, '--repo', folder]`,
 * as `buildCliConfig` makes it for the chat's folder. Anything else throws, so nothing names another folder.
 */
export function pinnedCliScript(cli: Pick<DarkMechanicusCli, 'args'>, folder: string): string {
  const [script, flag, repo, ...rest] = cli.args
  if (script === undefined || flag !== '--repo' || repo !== folder || rest.length > 0) {
    throw new Error(`The dm command is not pinned to this chat's folder with --repo ${folder}.`)
  }
  return script
}

/** `text` single-quoted for `/bin/sh` (and bash and zsh): read with no expansion at all, `'` written as `'\''`. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}

/** The launcher's text for the chat's `dm` invocation, which must be pinned to `folder`. */
export function dmLauncherScript(cli: Pick<DarkMechanicusCli, 'command' | 'args'>, folder: string): string {
  const script = pinnedCliScript(cli, folder)
  return [
    '#!/bin/sh',
    '# The Dark Mechanicus dm command for one chat, written by the app at each start.',
    'ELECTRON_RUN_AS_NODE=1',
    'export ELECTRON_RUN_AS_NODE',
    `exec ${shellQuote(cli.command)} ${shellQuote(script)} --repo ${shellQuote(folder)} "$@"`,
    ''
  ].join('\n')
}

/** Writes the launcher into `dir` (made 0700), replacing the last start's, as a 0700 file; returns its path. */
export async function writeDmLauncher(dir: string, text: string): Promise<string> {
  const path = join(dir, DM_LAUNCHER_NAME)
  await writePrivateFile(path, text, 0o700)
  return path
}
