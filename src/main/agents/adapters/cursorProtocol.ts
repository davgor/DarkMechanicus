/**
 * What `agent acp` and the Cursor CLI say, read into the chat contract's terms. Pure functions:
 * the model id rules, the `agent models` output, the permission options of
 * `session/request_permission` and the descriptions of tool calls.
 *
 * Sources (read 2026-10-04): the Cursor ACP page (https://cursor.com/docs/cli/acp: option ids
 * `allow-once`, `allow-always`, `reject-once`, and the `outcome` envelope of the answer), the ACP
 * specification (https://agentclientprotocol.com/protocol/tool-calls: option kinds `allow_once`,
 * `allow_always`, `reject_once`, `reject_always` and the tool kinds). What `agent models` prints is
 * not documented anywhere; `parseModelList` is written for `<id> - <label>` lines and tolerates the
 * other plausible shapes (see its comment).
 */
import type { ApprovalCategory, ApprovalDecision, ModelOption } from '../../../shared/agents/chat'
import { clipMasked } from '../claimTokenMask'

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** `text` cut to `max` with an ellipsis, claim tokens masked first so a cut inside one cannot leave part of its secret. */
export function clip(text: string, max: number): string {
  return clipMasked(text, max)
}

// ---- Model ids ----

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

// ---- `agent models` ----

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')
const MARKERS = /\s*\((?:current|default)(?:\s*,\s*(?:current|default))*\)\s*$/i
const SEPARATED = /^(\S+)(?:\s+-\s+|\t+)(.+)$/
const BARE = /^[a-z0-9][a-z0-9._/+-]*(?:\[[A-Za-z0-9._/+=,-]*\])?$/

function modelOfLine(line: string): ModelOption | null {
  const separated = SEPARATED.exec(line)
  const id = separated?.[1] ?? line
  const label = (separated?.[2] ?? id).replace(MARKERS, '').trim()
  const looksLikeId = separated === null ? BARE.test(id) : !/[.:]$/.test(id)
  return looksLikeId && isSafeModelId(id) ? { id, label: label === '' ? id : label } : null
}

/**
 * The models in the output of `agent models` (or `agent --list-models`). Assumed, because no
 * documentation or sample was found: one model per line as `<id> - <label>`, optionally ending in
 * `(current)` and/or `(default)`; tab separated and bare-id lines are accepted too. A bare line only
 * counts when it is a lowercase id, so a header such as `Available models` or `Loading...` is not
 * mistaken for a model. Ids that cannot be passed to `--model` safely are left out, and each id
 * appears once.
 */
export function parseModelList(output: string): ModelOption[] {
  const seen = new Set<string>()
  const models: ModelOption[] = []
  for (const raw of output.replace(ANSI_ESCAPE, '').split(/\r?\n/)) {
    const model = modelOfLine(raw.trim())
    if (model !== null && !seen.has(model.id)) {
      seen.add(model.id)
      models.push(model)
    }
  }
  return models
}

// ---- Permission options ----

interface PermissionOption {
  optionId: string
  /** The ACP option kind, or null when the agent sent none this client knows. */
  kind: string | null
}

const OPTION_KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always'])

/** Which option kinds answer a decision, best first: allowing for the chat settles for once, refusing for always. */
const KINDS_FOR: Record<ApprovalDecision, string[]> = {
  allow_once: ['allow_once'],
  allow_chat: ['allow_always', 'allow_once'],
  deny: ['reject_once', 'reject_always']
}

/** The ids Cursor documents, for options that carry no kind and for requests that list none. */
const IDS_FOR: Record<ApprovalDecision, string[]> = {
  allow_once: ['allow-once'],
  allow_chat: ['allow-always', 'allow-once'],
  deny: ['reject-once', 'reject-always']
}

function readOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry: unknown) => {
    const option = objectOf(entry)
    const optionId = option?.optionId
    if (option === null || typeof optionId !== 'string') {
      return []
    }
    const kind = typeof option.kind === 'string' && OPTION_KINDS.has(option.kind) ? option.kind : null
    return [{ optionId, kind }]
  })
}

/**
 * The option that carries out `decision`, or null when the agent offered none that does (the caller
 * then answers `cancelled`, which never allows anything). Options are matched by their ACP kind; an
 * option without a known kind is matched by the id Cursor documents. A request that lists no
 * options at all is answered with the documented id. An allowance is never taken from a refusal's
 * options or the other way round.
 */
export function chooseOptionId(options: unknown, decision: ApprovalDecision): string | null {
  const offered = readOptions(options)
  if (offered.length === 0) {
    return IDS_FOR[decision][0] ?? null
  }
  for (const kind of KINDS_FOR[decision]) {
    const match = offered.find((option) => option.kind === kind)
    if (match !== undefined) {
      return match.optionId
    }
  }
  const unkinded = offered.filter((option) => option.kind === null)
  const byId = IDS_FOR[decision].find((id) => unkinded.some((option) => option.optionId === id))
  return byId ?? null
}

// ---- Tool calls ----

/** Maps, not objects: a kind comes from the agent and must not reach `constructor` or `__proto__`. */
const CATEGORY_BY_KIND = new Map<string, ApprovalCategory>([
  ['execute', 'command'],
  ['edit', 'file_edit'],
  ['delete', 'file_edit'],
  ['move', 'file_edit']
])

const TOOL_BY_KIND = new Map<string, string>([
  ['read', 'Read'],
  ['search', 'Search'],
  ['execute', 'Shell'],
  ['edit', 'Edit'],
  ['delete', 'Delete'],
  ['move', 'Move'],
  ['fetch', 'Fetch'],
  ['think', 'Think'],
  ['switch_mode', 'Switch mode']
])

const MAX_SUMMARY_CHARS = 300
const MAX_TOOL_NAME_CHARS = 80
const MAX_INPUT_STRING_CHARS = 2000
const MAX_INPUT_ENTRIES = 50
const MAX_INPUT_DEPTH = 4

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** An MCP call names its server and tool in its raw input (Cursor's `providerIdentifier` and `toolName`). */
function mcpToolName(call: Record<string, unknown>): string | null {
  const input = objectOf(call.rawInput)
  const provider = stringOf(input?.providerIdentifier)
  const tool = stringOf(input?.toolName)
  return provider !== null && tool !== null ? `${provider}:${tool}` : null
}

/** What to call a tool in the transcript, and what an allowance for the chat covers: its MCP name, its kind, or its title. */
export function toolNameOf(call: Record<string, unknown>): string {
  const kind = stringOf(call.kind)
  const title = stringOf(call.title)
  const named = mcpToolName(call) ?? TOOL_BY_KIND.get(kind ?? '')
  return named ?? (title === null ? 'tool' : clip(title, MAX_TOOL_NAME_CHARS))
}

function shrink(value: unknown, depth: number): Json {
  if (typeof value === 'string') {
    return clip(value, MAX_INPUT_STRING_CHARS)
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value
  }
  if (depth >= MAX_INPUT_DEPTH) {
    return '…'
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_INPUT_ENTRIES).map((item: unknown) => shrink(item, depth + 1))
  }
  const entries = Object.entries(objectOf(value) ?? {}).slice(0, MAX_INPUT_ENTRIES)
  return Object.fromEntries(entries.map(([key, item]) => [key, shrink(item, depth + 1)]))
}

/** The raw input of a tool call, cut down to what is worth storing; undefined when it has none. */
export function summarizeInput(rawInput: unknown): Record<string, Json> | undefined {
  const input = objectOf(rawInput)
  return input === null ? undefined : (shrink(input, 0) as Record<string, Json>)
}

interface PermissionDetails {
  /** The tool call the request is about; null when the request did not say. */
  toolCallId: string | null
  category: ApprovalCategory
  tool: string
  summary: string
  input: Record<string, Json> | undefined
}

/** What a `session/request_permission` asks to do, for the approval request item. */
export function permissionDetails(params: unknown): PermissionDetails {
  const call = objectOf(objectOf(params)?.toolCall) ?? {}
  const kind = stringOf(call.kind)
  const title = stringOf(call.title)
  return {
    toolCallId: stringOf(call.toolCallId),
    category: CATEGORY_BY_KIND.get(kind ?? '') ?? 'other',
    tool: toolNameOf(call),
    summary: title === null ? 'Cursor asks to use a tool' : clip(title, MAX_SUMMARY_CHARS),
    input: summarizeInput(call.rawInput)
  }
}
