/**
 * How an agent's process is started, for every protocol alike: the executable, then the spec's
 * arguments, then the arguments the protocol adds itself (the Claude SDK's flags, nothing for Codex,
 * the ACP flavor's `launchArgs`). The spec is built in main from the registry row, never from the renderer.
 *
 * In the spec's arguments, an argument that is exactly `{folder}` becomes the chat's canonical folder
 * (as `resolveLaunchFolder` returned it). One that holds `{folder}` inside a longer string is refused,
 * so a folder never has to be spliced into, or quoted inside, a larger argument.
 */
import type { AgentProtocol, AgentView, BuiltInAgentKind } from '../../shared/desktop/api'

const FOLDER_PLACEHOLDER = '{folder}'

export interface AgentLaunchSpec {
  /** Chooses the ACP flavor: a built-in's own, or the generic one for a custom CLI. */
  kind: AgentView['kind']
  /** How the agent is named in what the adapter says. */
  displayName: string
  protocol: AgentProtocol
  executablePath: string
  /** Before the protocol's own arguments; may hold whole-argument `{folder}` placeholders. */
  args: readonly string[]
}

/** The built-in Codex's arguments: the app-server subcommand. */
export const CODEX_APP_SERVER_ARGS: readonly string[] = ['app-server']

/** A built-in's arguments are a preset in code, whatever its row holds. */
export const BUILT_IN_LAUNCH_ARGS: Readonly<Record<BuiltInAgentKind, readonly string[]>> = {
  claude: [],
  codex: CODEX_APP_SERVER_ARGS,
  cursor: [],
  // docs/reports/autonomous-acp.md ("For the adapter"): ask before every write and shell command; never `write` or `yolo`.
  autonomous: ['start', FOLDER_PLACEHOLDER, '--mode', 'acp', '--approval-mode', 'always-ask']
}

/** The launch spec for a registry row: a built-in's preset arguments, or a custom CLI's own. */
export function launchSpecFor(agent: AgentView): AgentLaunchSpec {
  return {
    kind: agent.kind,
    displayName: agent.displayName,
    protocol: agent.protocol,
    executablePath: agent.executablePath,
    args: agent.kind === 'custom' ? [...agent.args] : BUILT_IN_LAUNCH_ARGS[agent.kind]
  }
}

/** `args` with each whole `{folder}` replaced by `folder`; throws for one that holds it inside a longer string. */
export function withFolder(args: readonly string[], folder: string): string[] {
  return args.map((arg) => {
    if (arg === FOLDER_PLACEHOLDER) {
      return folder
    }
    if (arg.includes(FOLDER_PLACEHOLDER)) {
      throw new Error(`The argument ${JSON.stringify(arg)} holds {folder} inside other text; {folder} must be an argument of its own.`)
    }
    return arg
  })
}
