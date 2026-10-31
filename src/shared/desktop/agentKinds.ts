/**
 * The built-in agent kinds: what each is called in the UI and which executables it is expected
 * under, plus the shape of an agent id. Pure data, so the main process (probing a picked executable,
 * checking an IPC payload) and the renderer (cards with display names) read the same definitions.
 */
import { z } from 'zod'
import type { AgentId, BuiltInAgentKind } from './api'

interface AgentKindDefinition {
  displayName: string
  /** Bare executable names the CLI is expected under, most likely first (no extension). */
  executables: readonly string[]
  /** False when the app has no installer for it: Autonomous is installed and updated by its own managed installer. */
  downloadable: boolean
}

export const AGENT_KINDS = ['claude', 'codex', 'cursor', 'autonomous'] as const satisfies readonly BuiltInAgentKind[]

export const AGENT_DEFINITIONS: Readonly<Record<BuiltInAgentKind, AgentKindDefinition>> = {
  claude: { displayName: 'Claude Code', executables: ['claude'], downloadable: true },
  codex: { displayName: 'Codex', executables: ['codex'], downloadable: true },
  cursor: { displayName: 'Cursor', executables: ['agent', 'cursor-agent'], downloadable: true },
  autonomous: { displayName: 'Autonomous', executables: ['a8s'], downloadable: false }
}

/** A custom agent's id: `cu_` and a ULID (26 lowercase Crockford base32 characters). */
const CUSTOM_AGENT_ID = /^cu_[0-9a-hjkmnp-tv-z]{26}$/

/** An agent id: a built-in kind's name (its id equals its kind), or a custom agent's `cu_` id. */
export const agentIdSchema = z.union([z.enum(AGENT_KINDS), z.string().regex(CUSTOM_AGENT_ID)]) satisfies z.ZodType<AgentId>

/** True when `id` names a built-in agent, whose id is its kind. */
export function isBuiltInAgentKind(id: string): id is BuiltInAgentKind {
  return (AGENT_KINDS as readonly string[]).includes(id)
}

/** Windows installs these as `.exe` or `.cmd` shims; elsewhere the bare name is the executable. */
export function expectedExecutableNames(kind: BuiltInAgentKind, platform: string): string[] {
  const { executables } = AGENT_DEFINITIONS[kind]
  return platform === 'win32'
    ? executables.flatMap((name) => [`${name}.exe`, `${name}.cmd`])
    : [...executables]
}
