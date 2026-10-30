/** Launch specs for tests: a built-in's (its preset arguments) and a custom CLI's. Not shipped. */
import type { AgentProtocol, BuiltInAgentKind } from '../../../shared/desktop/api'
import { BUILT_IN_LAUNCH_ARGS, type AgentLaunchSpec } from '../launchSpec'

const PROTOCOLS: Readonly<Record<BuiltInAgentKind, AgentProtocol>> = { claude: 'claude', codex: 'codex', cursor: 'acp', autonomous: 'acp' }

export function builtInSpec(kind: BuiltInAgentKind, executablePath: string): AgentLaunchSpec {
  return { kind, displayName: kind, protocol: PROTOCOLS[kind], executablePath, args: BUILT_IN_LAUNCH_ARGS[kind] }
}

export function customSpec(protocol: AgentProtocol, executablePath: string, args: readonly string[]): AgentLaunchSpec {
  return { kind: 'custom', displayName: 'My CLI', protocol, executablePath, args }
}
