/**
 * How a hosted chat reaches Dark Mechanicus: the `dm` CLI it runs, built for the app it is running
 * in. Pure: no Electron imports. The mirror of `mcpConfig.ts`, which did the same for the MCP
 * server the adapters used to hand the vendor.
 */
import { join } from 'node:path'

export interface CliConfigOptions {
  /** `app.isPackaged`. */
  packaged: boolean
  /** `process.execPath`: the app executable, used as the Node runtime when packaged. */
  execPath: string
  /** `app.getAppPath()`: the project root in development, `…/resources/app.asar` when packaged. */
  appPath: string
  /** Canonical folder the chat works in; the CLI is pinned to it. */
  repoPath: string
  /** The Dark Mechanicus home directory the app resolved, so the CLI finds the same projects. */
  dmHome?: string
}

/**
 * The exact invocation a chat is allowed to make. `command` and `args` are compared literally when
 * a chat's command is checked against it (`ownCliCommand.ts`), so nothing here may be relative or
 * depend on the agent's environment.
 */
export interface CliLaunch {
  command: string
  /** The script and the repository it is pinned to, in this order. */
  args: string[]
  env: Record<string, string>
}

export function buildCliConfig(options: CliConfigOptions): CliLaunch {
  const command = options.packaged ? options.execPath : 'node'
  const env = {
    ...(options.packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(options.dmHome === undefined ? {} : { DARKMECHANICUS_HOME: options.dmHome })
  }
  return { command, args: [join(options.appPath, 'out', 'main', 'cli.js'), '--repo', options.repoPath], env }
}

