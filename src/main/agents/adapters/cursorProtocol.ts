/**
 * What the Cursor CLI says, read into the chat contract's terms. Pure functions: the model id rules,
 * the `agent models` output, and how a permission request reads under Cursor's name. What `agent models`
 * prints is not documented anywhere; `parseModelList` is written for `<id> - <label>` lines and
 * tolerates the other plausible shapes (see its comment). The protocol itself is read in `acp/`.
 */
import type { ModelOption } from '../../../shared/agents/chat'
import { describePermission, type PermissionDetails } from './acp/acpPermissions'

/** How the chat names Cursor. */
export const CURSOR_NAME = 'Cursor'

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

// ---- Permission requests ----

/** What a Cursor `session/request_permission` asks to do, as a Cursor chat shows it. */
export function permissionDetails(params: unknown): PermissionDetails {
  return describePermission(params, CURSOR_NAME)
}
