/**
 * The models Start run offers per agent, as the app knows them without asking the agent: the CLI's own `/model`
 * picks among everything else once the chat runs (`docs/design/chat-shells.md`, question 4). Claude Code gets the
 * curated list of its aliases; Autonomous has no list command, so its model is typed; Codex, Cursor and a custom CLI
 * start on whatever model they pick themselves.
 *
 * `isSafeModelId` is which model ids may be passed to an agent CLI as an argument. A chat's model comes from the
 * renderer as any short string, so main checks it before it reaches a command line, a `.cmd` shim included
 * (`terminalLaunchSpec.ts`); Start run checks a typed one too, to say so before the run starts.
 */
import type { AgentView } from '../desktop/api'

/** A model a built-in agent takes, as the model choice shows it. */
export interface ModelOption {
  id: string
  label: string
}

/** How a model is chosen for an agent: from a list, typed (or left empty), or not at all (the CLI picks). */
export type AgentModels = { kind: 'list'; models: readonly ModelOption[] } | { kind: 'free' } | { kind: 'cli' }

/** "default" is the CLI's own choice, so it goes on no command line; the rest are its aliases. */
const CLAUDE_MODELS: readonly ModelOption[] = [
  { id: 'default', label: 'Default (recommended)' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' }
]

export function agentModels(kind: AgentView['kind']): AgentModels {
  switch (kind) {
    case 'claude':
      return { kind: 'list', models: CLAUDE_MODELS }
    case 'autonomous':
    case 'omp':
      return { kind: 'free' }
    default:
      return { kind: 'cli' }
  }
}

const MAX_MODEL_ID_CHARS = 200

/**
 * A model id may only hold characters that are literal inside a cmd.exe quote and that no option
 * parser reads as a flag: letters, digits, `. _ / + -`, and an optional trailing `[key=value,...]`
 * parameter list (Cursor writes ids such as `gpt-5.4[reasoning=medium,fast=false]`). Everything
 * else, including quotes, `%`, `^`, `&`, `|`, `<`, `>`, `!`, spaces and control characters, is
 * refused rather than escaped, and an id cannot start with `-`.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/+-]*(?:\[[A-Za-z0-9._/+=,-]*\])?$/

export function isSafeModelId(id: string): boolean {
  return id.length <= MAX_MODEL_ID_CHARS && MODEL_ID.test(id)
}
