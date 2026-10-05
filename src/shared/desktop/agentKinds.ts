/**
 * The closed set of supported agent kinds: what each is called in the UI and which executables it is
 * expected under. Pure data, so the main process (probing a picked executable) and the renderer
 * (cards with display names) read the same definitions.
 */
import type { AgentKind } from './api'

interface AgentKindDefinition {
  displayName: string
  /** Bare executable names the CLI is expected under, most likely first (no extension). */
  executables: readonly string[]
}

export const AGENT_KINDS = ['claude', 'codex', 'cursor'] as const satisfies readonly AgentKind[]

export const AGENT_DEFINITIONS: Readonly<Record<AgentKind, AgentKindDefinition>> = {
  claude: { displayName: 'Claude Code', executables: ['claude'] },
  codex: { displayName: 'Codex', executables: ['codex'] },
  cursor: { displayName: 'Cursor', executables: ['agent', 'cursor-agent'] }
}

/** Windows installs these as `.exe` or `.cmd` shims; elsewhere the bare name is the executable. */
export function expectedExecutableNames(kind: AgentKind, platform: string): string[] {
  const { executables } = AGENT_DEFINITIONS[kind]
  return platform === 'win32'
    ? executables.flatMap((name) => [`${name}.exe`, `${name}.cmd`])
    : [...executables]
}
