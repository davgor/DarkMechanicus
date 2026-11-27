/**
 * The models Start run offers per agent, as the app knows them without asking the agent: the CLI's own `/model`
 * picks among everything else once the chat runs (`docs/design/chat-shells.md`, question 4). Claude Code gets the
 * curated list of its aliases; Autonomous has no list command, so its model is typed; OMP (Skitarii) lists its
 * catalog itself (`agentChat:models`, normalized here as `ChatModelOption`); Codex, Cursor and a custom CLI start on
 * whatever model they pick themselves.
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

/**
 * How a model is chosen for an agent: from a list, typed (or left empty), from the CLI's own model catalog (OMP), or
 * not at all (the CLI picks).
 */
export type AgentModels = { kind: 'list'; models: readonly ModelOption[] } | { kind: 'free' } | { kind: 'catalog' } | { kind: 'cli' }

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
      return { kind: 'free' }
    case 'omp':
      return { kind: 'catalog' }
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

/**
 * One model of an OMP catalog, as both catalog paths give it: a live session's `get_available_models` (with
 * `identity`) and `omp models --json` before a chat starts (without it). `line` is the model's product line (family,
 * plus the variant word after the version: `opus`, `gpt astra`); `revision` its numeric dotted version with trailing
 * zero parts dropped (`5.5`, `6`), null when neither the identity nor the name carries one.
 */
export interface ChatModelOption {
  provider: string
  id: string
  name: string
  line: string
  revision: string | null
  /** The thinking levels the model takes, as OMP names them (`low` … `max`); empty when it has none. */
  efforts: string[]
  /** The model reads images. */
  images: boolean
  contextWindow: number | null
  /** OMP marks the model as a reasoning (thinking) model. */
  reasoning: boolean
  /** US dollars per million input tokens (`cost.input`); null when the catalog does not price it. */
  inputCost: number | null
}

/** The models of one provider, under its display label. */
interface ModelGroup {
  provider: string
  label: string
  models: ChatModelOption[]
}

/** A model picker's two parts: the latest model of each line first, then everything else by provider. */
interface FeaturedModels {
  featured: ChatModelOption[]
  more: ModelGroup[]
}

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {})
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')

const MAX_NAME_CHARS = 200
const MAX_EFFORTS = 16
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/
/** A name's version token, alone (`5.5`) or after its family (`GPT-6.1`). */
const VERSION_TOKEN = /^(?:([A-Za-z][A-Za-z0-9]*)-)?v?(\d+(?:\.\d+)*)$/
const REVISION = /^\d+(?:\.\d+)*$/
/** A dated snapshot (`claude-haiku-4-5-20251001`): never featured, the undated id of its line stands for it. */
const DATED_SNAPSHOT = /-\d{8}$/

const PROVIDER_LABELS: Readonly<Record<string, string>> = { anthropic: 'Claude', 'openai-codex': 'Codex' }

/** The provider as a picker shows it: Claude and Codex for OMP's two subscriptions, any other by its own name. */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider
}

/** `5.5.0` gives `5.5`, `6.0.0` gives `6`; anything not numeric and dotted gives null. */
function revisionOf(value: string): string | null {
  if (!REVISION.test(value)) {
    return null
  }
  const parts = value.split('.').map(Number)
  while (parts.length > 1 && parts.at(-1) === 0) {
    parts.pop()
  }
  return parts.join('.')
}

function compareRevisions(a: string | null, b: string | null): number {
  if (a === b) {
    return 0
  }
  if (a === null || b === null) {
    return a === null ? -1 : 1
  }
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

/** The line and revision a model's name carries: the family before or in its version token, and the variant words after it. */
function nameParts(name: string): { family: string; variant: string[]; revision: string | null } | null {
  const words = name.split(/\s+/).filter((word) => word !== '')
  for (let index = 0; index < words.length; index++) {
    const match = VERSION_TOKEN.exec(words[index])
    if (match !== null) {
      return { family: match[1] ?? words[index - 1] ?? '', variant: words.slice(index + 1), revision: revisionOf(match[2]) }
    }
  }
  return null
}

/** The line and revision: `identity` (session path) first, the name's version token and variant words otherwise. */
function lineAndRevision(name: string, identity: ObjectValue): { line: string; revision: string | null } {
  const family = text(identity.family, MAX_NAME_CHARS).toLowerCase()
  const revision = revisionOf(text(identity.revision, MAX_NAME_CHARS))
  const parts = nameParts(name)
  if (parts === null) {
    return { line: family || name.toLowerCase(), revision }
  }
  const line = [family || parts.family, ...parts.variant].join(' ').trim().toLowerCase()
  return { line: line || name.toLowerCase(), revision: revision ?? parts.revision }
}

/** `thinking.efforts` on the session path, `thinking` itself on the sessionless one; only well-formed levels. */
function effortsOf(thinking: unknown): string[] {
  const efforts = Array.isArray(thinking) ? thinking : object(thinking).efforts
  return Array.isArray(efforts) ? efforts.filter((effort): effort is string => typeof effort === 'string' && EFFORT.test(effort)).slice(0, MAX_EFFORTS) : []
}

/** `cost.input`, in US dollars per million input tokens; null when the entry is unpriced or the price is not a number. */
function inputCostOf(cost: unknown): number | null {
  const input = object(cost).input
  return typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : null
}

/**
 * One catalog entry as a `ChatModelOption`, or null for an entry whose provider or id, alone or as `provider/id`, may
 * not go on a command line (`isSafeModelId`; never trimmed or cut to fit). Only `identity` is session-only, and the
 * name stands in for it.
 */
export function chatModelOption(value: unknown): ChatModelOption | null {
  const raw = object(value)
  const provider = typeof raw.provider === 'string' ? raw.provider : ''
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (provider.includes('/') || ![provider, id, `${provider}/${id}`].every(isSafeModelId)) {
    return null
  }
  const name = text(raw.name, MAX_NAME_CHARS) || id
  const contextWindow = raw.contextWindow
  return {
    provider,
    id,
    name,
    ...lineAndRevision(name, object(raw.identity)),
    efforts: effortsOf(raw.thinking),
    images: Array.isArray(raw.input) && raw.input.includes('image'),
    contextWindow: Number.isSafeInteger(contextWindow) && (contextWindow as number) > 0 ? (contextWindow as number) : null,
    reasoning: raw.reasoning === true,
    inputCost: inputCostOf(raw.cost)
  }
}

/** Every usable model of a catalog document (`{models: [...]}`), in catalog order; unsafe ids are dropped. */
export function chatModelOptions(catalog: unknown): ChatModelOption[] {
  const models = object(catalog).models
  return Array.isArray(models) ? models.map(chatModelOption).filter((option): option is ChatModelOption => option !== null) : []
}

/** Anthropic first, then every other provider alphabetically. */
function compareProviders(a: string, b: string): number {
  if (a === b) {
    return 0
  }
  if (a === 'anthropic' || b === 'anthropic') {
    return a === 'anthropic' ? -1 : 1
  }
  return a < b ? -1 : 1
}

/** By provider, then line, then the newest revision first; the id breaks ties, so the order never depends on the catalog's. */
function compareOptions(a: ChatModelOption, b: ChatModelOption): number {
  return compareProviders(a.provider, b.provider) || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0)
    || compareRevisions(b.revision, a.revision) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * The picker's main group, computed from the catalog alone so a new release takes its line's place with no code
 * change: the highest revision of each (provider, line), dated snapshots never, ordered by provider (Anthropic first)
 * and line. Everything else goes under `more`, grouped by provider in the same order.
 */
export function featuredModels(options: readonly ChatModelOption[]): FeaturedModels {
  const sorted = [...options].sort(compareOptions)
  const latest = new Map<string, ChatModelOption>()
  for (const option of sorted) {
    const key = `${option.provider}\u0000${option.line}`
    if (!DATED_SNAPSHOT.test(option.id) && !latest.has(key)) {
      latest.set(key, option)
    }
  }
  const featured = new Set(latest.values())
  const more: ModelGroup[] = []
  for (const option of sorted) {
    if (featured.has(option)) {
      continue
    }
    const group = more.at(-1)
    if (group?.provider === option.provider) {
      group.models.push(option)
    } else {
      more.push({ provider: option.provider, label: providerLabel(option.provider), models: [option] })
    }
  }
  return { featured: [...featured], more }
}
