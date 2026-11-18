/**
 * What the metric observation ledger stores beyond the SPACE contract (`contract.ts`): the storage rules that keep
 * credentials, claim secrets, machine-local paths and chat text out of a record that is exported to the repository,
 * and the payload identity that makes recording an observation idempotent. The recording service
 * (`services/observations.ts`) and the portable record schema (`repo/portable.ts`) apply the same rules, so a
 * record the ledger refuses is never imported either.
 */
import type { EvidenceRef, MetricKind, MetricObservation } from '../../shared/domain/space'
import { contentHash } from '../canonical'
import { holdsSecretText } from '../storedSecrets'
import { defectProblem } from './defects'

export const LEDGER_LIMITS = {
  /** Observations one recording call may carry. */
  perCall: 500,
  /** Observations one epic (or the project level) may hold: the most a reconcile reads back from one folder. */
  perFolder: 50_000,
  /** Every free text (actor, estimate method, usage parent, evidence detail, attribute) is one line of at most this. */
  text: 200
} as const

/**
 * Metrics that measure execution itself. A carry-forward attempt ran nothing (it points at work accepted earlier),
 * so these are refused on it: the usage stays with the attempt that did the work and is never counted twice.
 */
export const EXECUTION_METRICS: Readonly<Partial<Record<MetricKind, true>>> = {
  tokens_input: true,
  tokens_cached_input: true,
  tokens_output: true,
  tokens_reasoning: true,
  tokens_total: true,
  active_ms: true,
  elapsed_ms: true,
  wait_ms: true,
  corrective_effort_ms: true,
  activity_volume: true
}

/** Words that make a name a credential wherever they appear in it (`secretKey`, `db_password`, `pwdHash`). */
const CREDENTIAL_WORDS: Record<string, true> = {
  secret: true,
  secrets: true,
  password: true,
  passwd: true,
  pwd: true,
  passphrase: true,
  credential: true,
  credentials: true,
  apikey: true,
  privatekey: true,
  authorization: true,
  cookie: true,
  bearer: true
}

/** Adjacent words that make a name a credential wherever they appear in it (`apiKeyValue`, `refresh_token_id`). */
const CREDENTIAL_PAIRS: Record<string, true> = {
  'api key': true,
  'secret key': true,
  'private key': true,
  'access key': true,
  'signing key': true,
  'session key': true,
  'auth header': true,
  'auth token': true,
  'access token': true,
  'refresh token': true,
  'session token': true,
  'id token': true,
  'client secret': true
}

/** The last word of an attribute name that would carry chat text: refused for a string value. */
const TRANSCRIPT_WORDS: Record<string, true> = {
  transcript: true,
  prompt: true,
  completion: true,
  conversation: true,
  chat: true,
  message: true,
  messages: true,
  content: true
}

/** Provider keys, auth headers, JWTs, private key blocks and `name=value` secrets, wherever they appear in a text. */
const CREDENTIAL_TEXT = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b[Bb]asic\s+(?=[A-Za-z0-9+/]*(?:[0-9+/=]|[a-z][A-Z]))[A-Za-z0-9+/]{8,}={0,2}/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|npm|xox[abprs])[-_][A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret)\s*[=:]\s*\S/i
]

/** Where a path can start: the start of the text, whitespace, a quote, a bracket or a separator (never `:`, so `a:/b` is text). */
const START = `(?:^|[\\s"'(\\[{<=,;|>])`

/**
 * Absolute paths and home references of this machine: any absolute POSIX path of two or more segments (`/c/Users/`,
 * `/nix/store/`, `/data/x/`) or a known system root, a drive path (`C:\`, `C:/Users/`), a UNC path, a home-relative
 * path, an environment-variable home (`$HOME`, `%USERPROFILE%`, `$env:`) or a file URL.
 */
const LOCAL_PATH = [
  new RegExp(`${START}\\/[^\\s/\\\\]+\\/`),
  new RegExp(`${START}\\/(?:Users|home|root|tmp|etc|var|opt|private|Volumes|Library|Applications|System|mnt|data|nix|srv|media|proc|dev)\\b`, 'i'),
  new RegExp(`${START}[A-Za-z]:(?:\\\\|\\/[^\\s/\\\\]+[\\\\/])`),
  new RegExp(`${START}\\\\\\\\[^\\\\\\s]+\\\\`),
  new RegExp(`${START}~[\\\\/]`),
  /\$\{?(?:HOME|USERPROFILE|TMPDIR|TEMP|TMP|APPDATA|LOCALAPPDATA|XDG_[A-Z_]+)\b\}?/,
  /%(?:USERPROFILE|HOMEPATH|HOMEDRIVE|APPDATA|LOCALAPPDATA|TEMP|TMP|PROGRAMDATA)%/i,
  /\$env:/i,
  /\bfile:\/\//i
]

function nameWords(name: string): string[] {
  return name
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .map((word) => word.toLowerCase().replace(/\d+$/, ''))
    .filter((word) => word !== '')
}

/** Whether a name is a credential's: a credential word or pair anywhere in it, or `token` as its last word. */
function isCredentialName(name: string): boolean {
  const words = nameWords(name)
  return (
    words.at(-1) === 'token' ||
    words.some((word, index) => CREDENTIAL_WORDS[word] === true || CREDENTIAL_PAIRS[`${words[index - 1] ?? ''} ${word}`] === true)
  )
}

/**
 * Why `text` cannot be stored, or null. Every free text is one line of at most 200 characters, so no chat fits; it
 * holds no claim or grant token, credential or machine-local path. Experiment evidence details and event notes follow
 * the same rule (`src/core/plan/experiments.ts`).
 */
export function textProblem(text: string): string | null {
  if (/[\r\n\u2028\u2029]/.test(text) || text.length > LEDGER_LIMITS.text) {
    return `is not one line of at most ${LEDGER_LIMITS.text} characters; chat text is never stored`
  }
  if (holdsSecretText(text)) {
    return 'holds a claim or grant token'
  }
  if (CREDENTIAL_TEXT.some((pattern) => pattern.test(text))) {
    return 'holds what looks like a credential'
  }
  if (LOCAL_PATH.some((pattern) => pattern.test(text))) {
    return 'holds a machine-local path'
  }
  return null
}

export interface LedgerProblem {
  path: string
  message: string
}

function attributeProblem(name: string, value: unknown): LedgerProblem | null {
  const path = `attributes.${name}`
  if (isCredentialName(name)) {
    return { path, message: 'An observation never stores a credential' }
  }
  const nameIssue = textProblem(name)
  if (nameIssue !== null) {
    return { path, message: `The attribute name ${nameIssue}` }
  }
  if (typeof value !== 'string') {
    return null
  }
  if (TRANSCRIPT_WORDS[nameWords(name).at(-1) ?? ''] === true) {
    return { path, message: 'An attribute named like chat text is never stored' }
  }
  const issue = textProblem(value)
  return issue === null ? null : { path, message: `The value ${issue}` }
}

/**
 * Why the ledger would refuse an attribute, or null: lets a normalizer keep a provider's unknown fields that can be
 * stored and leave out the rest, instead of one refused field failing a whole all-or-none batch.
 */
export function attributeRefusal(name: string, value: unknown): string | null {
  return attributeProblem(name, value)?.message ?? null
}

/** The free-text fields of an observation outside its attributes, with their paths. */
function freeTexts(observation: MetricObservation): [string, string | null][] {
  return [
    ['source.actor', observation.source.actor],
    ['measurement.method', observation.measurement.state === 'estimated' ? observation.measurement.method : null],
    ['usage.parentActor', observation.usage?.parentActor ?? null],
    ...observation.evidence.map((ref, index): [string, string | null] => [`evidence.${index}.detail`, ref.detail])
  ]
}

/** The key that makes two evidence references the same citation. */
export function evidenceKey(ref: EvidenceRef): string {
  return `${ref.kind}\u0000${ref.id}\u0000${ref.detail ?? ''}`
}

/** Why the observation's provenance cannot be stored: a server source with an actor, or another without one. */
function sourceProblem(observation: MetricObservation): LedgerProblem | null {
  const { source } = observation
  if (source.kind === 'server' && source.actor !== null) {
    return { path: 'source.actor', message: 'A server-derived observation names no actor' }
  }
  if (source.kind !== 'server' && source.actor === null) {
    return { path: 'source.actor', message: `A ${source.kind} observation names the actor that measured it` }
  }
  if (observation.observedAt !== new Date(observation.observedAt).toISOString()) {
    return { path: 'observedAt', message: 'observedAt is stored in UTC with milliseconds (toISOString)' }
  }
  return null
}

/** Why the evidence list cannot be stored: a citation of the observation itself, or one listed twice. */
function evidenceProblem(observation: MetricObservation): LedgerProblem | null {
  const seen = new Set<string>()
  for (const [index, ref] of observation.evidence.entries()) {
    if (ref.kind === 'observation' && ref.id === observation.observationId) {
      return { path: `evidence.${index}`, message: 'An observation never cites itself' }
    }
    if (seen.has(evidenceKey(ref))) {
      return { path: `evidence.${index}`, message: 'Each evidence reference is listed once' }
    }
    seen.add(evidenceKey(ref))
  }
  return null
}

/** The records of a run's work a coordination defect may cite: what happened, not an opinion about it. */
const RUN_RECORD_KINDS: readonly EvidenceRef['kind'][] = ['attempt', 'run', 'check', 'report', 'comment', 'observation']

/**
 * Why a coordination defect cannot be stored: it cites no run record, or it is a clarification. Asking or answering
 * a question on purpose is not a coordination failure, so it is never recorded as one.
 */
function coordinationProblem(observation: MetricObservation): LedgerProblem | null {
  if (observation.metric !== 'coordination_defect') {
    return null
  }
  if (observation.intervention === 'clarification' || observation.attributes.kind === 'clarification') {
    return { path: 'attributes.kind', message: 'A purposeful clarification is not a coordination defect' }
  }
  if (!observation.evidence.some((ref) => RUN_RECORD_KINDS.includes(ref.kind))) {
    return { path: 'evidence', message: `A coordination defect cites the run record it happened in (${RUN_RECORD_KINDS.join(', ')})` }
  }
  return null
}

/**
 * Why the ledger refuses to store a contract-valid observation, or null. The server derives its own values, so a
 * server record names no actor; every other source names who measured it. `observedAt` is normalized to UTC, so one
 * instant has one form. Evidence never cites the observation itself or the same record twice. No text may carry a
 * claim or grant token, a credential or a machine-local path, and every text is a short single line, so no chat
 * transcript fits. An escaped defect record follows the defect vocabulary (`defectProblem`, `defects.ts`).
 */
export function ledgerProblem(observation: MetricObservation): LedgerProblem | null {
  const structural = sourceProblem(observation) ?? evidenceProblem(observation) ?? coordinationProblem(observation) ?? defectProblem(observation)
  if (structural !== null) {
    return structural
  }
  for (const [path, text] of freeTexts(observation)) {
    const issue = text === null ? null : textProblem(text)
    if (issue !== null) {
      return { path, message: `The text ${issue}` }
    }
  }
  for (const [name, value] of Object.entries(observation.attributes)) {
    const problem = attributeProblem(name, value)
    if (problem !== null) {
      return problem
    }
  }
  return null
}

/**
 * The identity of what an observation says: every field but `recordedAt`, which the server assigns when it first
 * stores the record (so two machines recording the same delivery hold one observation). A different payload under
 * the same id is a conflict.
 */
export function observationPayloadHash(observation: MetricObservation): string {
  const { recordedAt: _recordedAt, ...payload } = observation
  return contentHash(payload)
}
