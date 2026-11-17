/**
 * How a hosted chat reaches Dark Mechanicus: the `dm` CLI it runs, built for the app it is running
 * in. Pure: no Electron imports. The mirror of `mcpConfig.ts`, which did the same for the MCP
 * server the adapters used to hand the vendor.
 */
import { isAbsolute, join } from 'node:path'

export interface CliConfigOptions {
  /** `process.execPath`: this build's Electron executable, used as the Node runtime. */
  execPath: string
  /** `app.getAppPath()`: the project root in development, `…/resources/app.asar` when packaged. */
  appPath: string
  /**
   * Canonical folder the chat works in; the CLI is pinned to it. Null for a project-less chat, whose CLI is pinned to
   * no folder: each call names its folder (`--repo`) and that folder's grant (`--token-file`).
   */
  repoPath: string | null
  /** The Dark Mechanicus home directory the app resolved, so the CLI finds the same projects. */
  dmHome?: string
}

/**
 * The exact `dm` invocation a chat may make. `command` and `args` go as they are into the chat's
 * instructions, its `dm` launcher and its Claude settings file, so nothing here may be relative or
 * depend on the agent's environment.
 */
export interface CliLaunch {
  command: string
  /** The script and the repository it is pinned to, in this order; the script alone for a project-less chat. */
  args: string[]
  env: Record<string, string>
}

export function buildCliConfig(options: CliConfigOptions): CliLaunch {
  const env = {
    ELECTRON_RUN_AS_NODE: '1',
    ...(options.dmHome === undefined ? {} : { DARKMECHANICUS_HOME: options.dmHome })
  }
  const script = join(options.appPath, 'out', 'main', 'cli.js')
  return { command: options.execPath, args: options.repoPath === null ? [script] : [script, '--repo', options.repoPath], env }
}

/**
 * What a Skitarii chat's mail client spawns (`resources/skitarii/extension/dmClient.ts`): the chat's `dm` invocation
 * with nothing taken from the agent's environment. The runtime is this build's own executable run as Node, packaged
 * or not (in development the project's Electron, never a `node` found on `PATH`), so `ELECTRON_RUN_AS_NODE=1` is set on
 * that child alone. The grant and the naming address in `cli.env` are dropped: the client takes the grant from the
 * chat's process at each call, and never writes it down.
 */
interface DmClientRuntime {
  command: string
  /** `[<absolute cli.js>, '--repo', folder]`. */
  args: [string, '--repo', string]
  env: { ELECTRON_RUN_AS_NODE: '1'; DARKMECHANICUS_HOME?: string }
}

/** An absolute path with no `..` segment, so nothing it names depends on where it is read from. */
function pinnedPath(path: string | undefined): path is string {
  return path !== undefined && path !== '' && isAbsolute(path) && !path.split(/[\\/]/).includes('..')
}

/** The script of `cli` when it is an absolute runtime running an absolute `cli.js` with `--repo folder`; throws otherwise. */
function pinnedScript(cli: CliLaunch, folder: string): string {
  const [script, flag, repo, ...rest] = cli.args
  const pinned = pinnedPath(script) && /(?:^|[\\/])cli\.js$/.test(script) && flag === '--repo' && repo === folder && rest.length === 0
  if (!pinned || !pinnedPath(cli.command) || !pinnedPath(folder)) {
    throw new Error(`The dm command is not an absolute runtime and CLI pinned to ${folder}.`)
  }
  return script
}

/** The mail client's runtime for `cli`, which must be `buildCliConfig`'s invocation pinned to `folder`; throws otherwise. */
export function dmClientRuntime(cli: CliLaunch, folder: string): DmClientRuntime {
  const script = pinnedScript(cli, folder)
  if (cli.env['ELECTRON_RUN_AS_NODE'] !== '1') {
    throw new Error('The dm command does not run the app executable as Node.')
  }
  const home = cli.env['DARKMECHANICUS_HOME']
  if (home !== undefined && !pinnedPath(home)) {
    throw new Error('The Dark Mechanicus home is not an absolute path.')
  }
  return { command: cli.command, args: [script, '--repo', folder], env: { ELECTRON_RUN_AS_NODE: '1', ...(home === undefined ? {} : { DARKMECHANICUS_HOME: home }) } }
}

