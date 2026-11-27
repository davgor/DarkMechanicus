/**
 * The program behind an agent executable the person connected (Claude Code or OMP). On Windows that may be an npm
 * `.cmd` shim, which is never launched: its one cmd.exe parse refuses the quotes the agent's arguments hold, so the
 * shim is followed to the script or program it runs.
 */
import { readFileSync } from 'node:fs'
import { win32 } from 'node:path'

const SHIM_EXTENSION = /\.(?:cmd|bat)$/i
/** What an npm `.cmd` shim runs: a quoted path under `%dp0%`, the folder holding the shim. */
const SHIM_TARGET = /"%dp0%\\([^"]+\.(?:js|exe))"/gi
export const SHIM_HELP =
  'Dark Mechanicus cannot launch Claude Code through that .cmd shim. Connect claude.exe instead (the native installer puts it in %USERPROFILE%\\.local\\bin).'

/**
 * The program to run. Node cannot start `.cmd` shims without a shell, and a shell would have to quote the agent's
 * arguments (JSON, a model name) for cmd.exe, which cannot be done safely. So a shim that matches the npm template is
 * followed to the script or program it runs. Any other path, including a `.cmd` that is not an npm shim or cannot be
 * read, is returned as given: the launcher decides whether that program may start.
 */
export function resolveAgentExecutable(path: string, platform: string, readFile: (path: string) => string = readShimFile): string {
  if (platform !== 'win32' || !SHIM_EXTENSION.test(path)) {
    return path
  }
  let text: string
  try {
    text = readFile(path)
  } catch {
    return path
  }
  const target = [...text.matchAll(SHIM_TARGET)].at(-1)?.[1]
  return target === undefined ? path : win32.join(win32.dirname(path), target)
}

export function readShimFile(path: string): string {
  return readFileSync(path, 'utf8')
}
