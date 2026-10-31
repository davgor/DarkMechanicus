/**
 * `session/request_permission` read into the chat contract's terms: what the request asks to do, and
 * which of its options carries out the person's decision.
 *
 * Source: the ACP specification (https://agentclientprotocol.com/protocol/tool-calls, read 2026-10-04:
 * option kinds `allow_once`, `allow_always`, `reject_once`, `reject_always`, the tool kinds, and the
 * `outcome` envelope of the answer, with `allow-once` and `reject-once` as the option ids of its example).
 */
import type { ApprovalCategory, ApprovalDecision } from '../../../../shared/agents/chat'
import { clip, objectOf, type Json } from './acpJson'
import { stringOf, summarizeInput, toolNameOf } from './acpToolCalls'

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

/** The conventional option ids (the kind, hyphenated), for options that carry no kind and for requests that list none. */
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
 * option without a known kind is matched by the conventional id. A request that lists no options at
 * all is answered with the conventional id. An allowance is never taken from a refusal's options or
 * the other way round.
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

/** A Map, not an object: a kind comes from the agent and must not reach `constructor` or `__proto__`. */
const CATEGORY_BY_KIND = new Map<string, ApprovalCategory>([
  ['execute', 'command'],
  ['edit', 'file_edit'],
  ['delete', 'file_edit'],
  ['move', 'file_edit']
])

const MAX_SUMMARY_CHARS = 300

export interface PermissionDetails {
  /** The tool call the request is about; null when the request did not say. */
  toolCallId: string | null
  category: ApprovalCategory
  tool: string
  summary: string
  input: Record<string, Json> | undefined
}

/** What a `session/request_permission` asks to do, for the approval request item; `agentName` speaks for a request without a title. */
export function describePermission(params: unknown, agentName: string): PermissionDetails {
  const call = objectOf(objectOf(params)?.toolCall) ?? {}
  const kind = stringOf(call.kind)
  const title = stringOf(call.title)
  return {
    toolCallId: stringOf(call.toolCallId),
    category: CATEGORY_BY_KIND.get(kind ?? '') ?? 'other',
    tool: toolNameOf(call),
    summary: title === null ? `${agentName} asks to use a tool` : clip(title, MAX_SUMMARY_CHARS),
    input: summarizeInput(call.rawInput)
  }
}
