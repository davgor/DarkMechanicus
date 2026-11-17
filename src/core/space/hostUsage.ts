/**
 * Normalizes provider and host token usage into metric reports at the measurement boundary.
 *
 * Each provider defines its categories its own way (`shared/domain/hostUsage.ts`): cached input can sit inside input
 * (OpenAI, Codex, Gemini) or apart from it (Anthropic, OMP), reasoning inside output (OpenAI, Codex; Anthropic and OMP
 * without reporting it) or apart from it (Gemini). A report keeps the provider's own number and states its definition
 * in its attributes (`includesCachedInput`, `subsetOf`, `includesReasoning`), so nothing is re-derived by guesswork.
 * `tokens_total` is the provider's own total when it reports one, or the sum of categories known to be disjoint; when
 * neither holds (an unknown token field could be another category) it is reported unavailable instead of invented.
 * A category the provider does not report (Anthropic reasoning) is reported `missing` (`host_unavailable`), never 0.
 *
 * Fields a format does not define are kept, flattened, as `raw.<path>` attributes of the `tokens_total` report (as many
 * as the 20-attribute budget and the ledger's screens allow; `rawOmitted` counts the rest). A host-computed price is
 * kept as `listPriceUsd` with `costBasis: list_price` and the account's `billing`: it is never a marginal cost, and a
 * subscription's usage costs nothing extra per token.
 *
 * Streams: samples are added up per stream (cumulative reports count the stream total so far, by sample count), and a
 * provider's own cumulative totals (Codex `total_token_usage`) are first turned into deltas (`cumulativeDeltas`), so a
 * repeated or regressed total is never counted twice.
 */
import type { UsageBilling, UsageFormat } from '../../shared/domain/hostUsage'
import type { MetricReport } from '../../shared/domain/metrics'
import type { Measurement, MetricAttributes, MetricKind, UsageCoverage } from '../../shared/domain/space'
import { attributeRefusal } from './ledger'

type RawValue = string | number | boolean | null

const CATEGORIES = ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const
type Category = (typeof CATEGORIES)[number]

interface FormatDefinition {
  /** The dotted path of each category in the raw usage object; null when the format has no such field. */
  paths: Record<Category, string | null> & { total: string | null; listPrice: string | null }
  /** Path prefixes that are known but carry no category (the parts of a host's list price). */
  knownPrefixes: readonly string[]
  /** Whether the input count includes cached input (so cached input is its subset). */
  includesCachedInput: boolean
  /** Whether the output count includes reasoning (so reasoning, reported or not, is its subset). */
  includesReasoning: boolean
}

const FORMATS: Readonly<Record<UsageFormat, FormatDefinition>> = {
  anthropic_messages: {
    paths: {
      input: 'input_tokens',
      cachedInput: 'cache_read_input_tokens',
      cacheWrite: 'cache_creation_input_tokens',
      output: 'output_tokens',
      reasoning: null,
      total: null,
      listPrice: null
    },
    knownPrefixes: [],
    includesCachedInput: false,
    includesReasoning: true
  },
  openai_chat: {
    paths: {
      input: 'prompt_tokens',
      cachedInput: 'prompt_tokens_details.cached_tokens',
      cacheWrite: null,
      output: 'completion_tokens',
      reasoning: 'completion_tokens_details.reasoning_tokens',
      total: 'total_tokens',
      listPrice: null
    },
    knownPrefixes: [],
    includesCachedInput: true,
    includesReasoning: true
  },
  openai_responses: {
    paths: {
      input: 'input_tokens',
      cachedInput: 'input_tokens_details.cached_tokens',
      cacheWrite: null,
      output: 'output_tokens',
      reasoning: 'output_tokens_details.reasoning_tokens',
      total: 'total_tokens',
      listPrice: null
    },
    knownPrefixes: [],
    includesCachedInput: true,
    includesReasoning: true
  },
  gemini: {
    paths: {
      input: 'promptTokenCount',
      cachedInput: 'cachedContentTokenCount',
      cacheWrite: null,
      output: 'candidatesTokenCount',
      reasoning: 'thoughtsTokenCount',
      total: 'totalTokenCount',
      listPrice: null
    },
    knownPrefixes: [],
    includesCachedInput: true,
    includesReasoning: false
  },
  codex: {
    paths: {
      input: 'input_tokens',
      cachedInput: 'cached_input_tokens',
      cacheWrite: null,
      output: 'output_tokens',
      reasoning: 'reasoning_output_tokens',
      total: 'total_tokens',
      listPrice: null
    },
    knownPrefixes: [],
    includesCachedInput: true,
    includesReasoning: true
  },
  omp: {
    paths: {
      input: 'input',
      cachedInput: 'cacheRead',
      cacheWrite: 'cacheWrite',
      output: 'output',
      reasoning: null,
      total: 'totalTokens',
      listPrice: 'cost.total'
    },
    knownPrefixes: ['cost.'],
    includesCachedInput: false,
    includesReasoning: true
  }
}

/** One raw usage object read apart into the provider's own categories. Null: the provider did not report it. */
export interface UsageBreakdown {
  format: UsageFormat
  input: number | null
  cachedInput: number | null
  cacheWrite: number | null
  output: number | null
  reasoning: number | null
  /** The provider's own total, else the sum of its disjoint categories; null when neither is possible. */
  total: number | null
  totalBasis: 'reported' | 'derived_disjoint' | null
  /** The list price the host computed (OMP `cost.total`) in US dollars: never a marginal cost. */
  listPriceUsd: number | null
  /** Fields the format does not define, flattened (`a.b`, array items by index), as the provider sent them. */
  unknown: Record<string, RawValue>
}

function flatten(value: unknown, prefix: string, into: Record<string, RawValue>): void {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    into[prefix] = value
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}.${index}`, into))
    return
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      flatten(item, prefix === '' ? key : `${prefix}.${key}`, into)
    }
  }
}

/** A token count: a non-negative whole number. Anything else is not a count and stays a raw field. */
function countOf(value: RawValue | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** An unknown top-level field that counts tokens could be another category, so no total is derived beside it. */
function looksLikeTokenCategory(path: string, value: RawValue): boolean {
  return !path.includes('.') && typeof value === 'number' && /token/i.test(path)
}

/** The sum of the categories when the format's categories are disjoint and every needed one was reported. */
function derivedTotal(definition: FormatDefinition, parts: Record<Category, number | null>): number | null {
  const needed: Category[] = ['input', 'output']
  if (!definition.includesCachedInput) {
    needed.push(...(['cachedInput', 'cacheWrite'] as const).filter((category) => definition.paths[category] !== null))
  }
  if (!definition.includesReasoning) {
    needed.push('reasoning')
  }
  let sum = 0
  for (const category of needed) {
    const value = parts[category]
    if (value === null) {
      return null
    }
    sum += value
  }
  return sum
}

/** The count at `path`, marking the path as read when it holds one. */
function readCount(fields: Record<string, RawValue>, path: string | null, read: Set<string>): number | null {
  const count = path === null ? null : countOf(fields[path])
  if (count !== null && path !== null) read.add(path)
  return count
}

/** A host-computed list price at `path` (a finite, non-negative number), or null. */
function listPriceOf(fields: Record<string, RawValue>, path: string | null): number | null {
  const value = path === null ? undefined : fields[path]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Reads one raw usage object of `format`. Malformed counts are kept as raw fields, never coerced to a number. */
export function breakdownOf(format: UsageFormat, usage: unknown): UsageBreakdown {
  const definition = FORMATS[format]
  const fields: Record<string, RawValue> = {}
  flatten(usage, '', fields)
  const read = new Set<string>()
  const parts = Object.fromEntries(CATEGORIES.map((category) => [category, readCount(fields, definition.paths[category], read)])) as Record<Category, number | null>
  const reported = readCount(fields, definition.paths.total, read)
  const listPriceUsd = listPriceOf(fields, definition.paths.listPrice)
  const priceParts = listPriceUsd === null ? [] : definition.knownPrefixes
  const unknown = Object.fromEntries(Object.entries(fields).filter(([path]) => !read.has(path) && !priceParts.some((prefix) => path.startsWith(prefix))))
  const blocked = Object.entries(unknown).some(([path, value]) => looksLikeTokenCategory(path, value))
  const derived = reported === null && !blocked ? derivedTotal(definition, parts) : null
  const totalBasis = reported !== null ? 'reported' : derived !== null ? 'derived_disjoint' : null
  return { format, ...parts, total: reported ?? derived, totalBasis, listPriceUsd, unknown }
}

/** One running total less the one before it (`base`, null for the first or after a restart), field by field. */
function deltaOf(current: UsageBreakdown, base: UsageBreakdown | null, last: boolean): UsageBreakdown {
  const minus = (key: Category | 'total'): number | null => {
    const now = current[key]
    const before = base === null ? 0 : base[key]
    return now === null || before === null ? null : Math.max(0, now - before)
  }
  const listPrice = current.listPriceUsd === null ? null : Math.max(0, current.listPriceUsd - (base?.listPriceUsd ?? 0))
  return {
    ...current,
    // Fields the format does not define are not known to be running totals: they are kept as the latest update states
    // them, on the last delta only, so adding the deltas up never sums them.
    unknown: last ? current.unknown : {},
    input: minus('input'),
    cachedInput: minus('cachedInput'),
    cacheWrite: minus('cacheWrite'),
    output: minus('output'),
    reasoning: minus('reasoning'),
    total: minus('total'),
    listPriceUsd: listPrice
  }
}

/**
 * Turns a provider's running totals (Codex `total_token_usage`) into per-update deltas, field by field for the token
 * categories and the list price. A repeated total adds nothing; a total below the previous one means the provider
 * started counting again (a new session), so the new total itself is the delta. The first total is a delta from zero.
 */
export function cumulativeDeltas(totals: readonly UsageBreakdown[]): UsageBreakdown[] {
  return totals.map((current, index) => {
    const previous = totals[index - 1] ?? null
    const restarted = previous !== null && previous.total !== null && current.total !== null && current.total < previous.total
    return deltaOf(current, restarted ? null : previous, index === totals.length - 1)
  })
}

interface CategoryTotal {
  value: number
  /** Samples that reported this category. */
  reported: number
}

/** A stream's samples added up. */
export interface UsageAggregate {
  format: UsageFormat
  samples: number
  categories: Record<Category | 'total', CategoryTotal>
  totalBases: Set<'reported' | 'derived_disjoint'>
  listPrice: CategoryTotal
  models: Set<string>
  unknown: Record<string, RawValue>
}

export function emptyAggregate(format: UsageFormat): UsageAggregate {
  const zero = (): CategoryTotal => ({ value: 0, reported: 0 })
  return {
    format,
    samples: 0,
    categories: { input: zero(), cachedInput: zero(), cacheWrite: zero(), output: zero(), reasoning: zero(), total: zero() },
    totalBases: new Set(),
    listPrice: zero(),
    models: new Set(),
    unknown: {}
  }
}

/**
 * Unknown fields add up when they are numbers (counts of the provider's own), take their latest value when a later
 * sample is the first to state them, and read `mixed` when samples state different non-numbers.
 */
function mergeUnknown(into: Record<string, RawValue>, fields: Record<string, RawValue>): void {
  for (const [path, value] of Object.entries(fields)) {
    const held = into[path]
    if (!(path in into)) {
      into[path] = value
    } else if (typeof held === 'number' && typeof value === 'number') {
      into[path] = held + value
    } else if (held !== value) {
      into[path] = 'mixed'
    }
  }
}

/** Adds one sample (of the aggregate's format) to a stream's aggregate. */
export function addSample(aggregate: UsageAggregate, sample: UsageBreakdown, model: string | null): void {
  if (sample.format !== aggregate.format) {
    throw new Error(`A ${aggregate.format} stream cannot take a ${sample.format} sample.`)
  }
  for (const key of [...CATEGORIES, 'total'] as const) {
    const value = sample[key]
    if (value !== null) {
      aggregate.categories[key].value += value
      aggregate.categories[key].reported += 1
    }
  }
  if (sample.totalBasis !== null) {
    aggregate.totalBases.add(sample.totalBasis)
  }
  if (sample.listPriceUsd !== null) {
    aggregate.listPrice.value += sample.listPriceUsd
    aggregate.listPrice.reported += 1
  }
  if (model !== null) {
    aggregate.models.add(model)
  }
  mergeUnknown(aggregate.unknown, sample.unknown)
  aggregate.samples += 1
}

/** Every sample reported it: observed; none did: unavailable from this host; some did: a partial (lower-bound) gap. */
function measurementOf(total: CategoryTotal, samples: number): Measurement {
  if (total.reported === samples) {
    return { state: 'observed', value: total.value }
  }
  return { state: 'missing', reason: total.reported === 0 ? 'host_unavailable' : 'partial_coverage' }
}

/** Who reported a stream and where it sits among nested sessions. */
export interface UsageStreamIdentity {
  /** The stream: one host session or subagent thread, as `host:<session>[/<thread>]`. */
  actor: string
  parentActor: string | null
  coverage: UsageCoverage
  billing: UsageBilling
}

/** Where a report sits in its stream: a cumulative position (sample count) or a delta's own event id. */
type UsagePosition = { accumulation: 'cumulative'; sequence: number; observedAt: string } | { accumulation: 'delta'; eventId: string; observedAt: string }

/**
 * The 20 attributes an observation may hold, less the two the server adds to a reported one (`overhead` on a run
 * bucket, `sourceEvent` on a delta), so a report never fails for its size.
 */
const ATTRIBUTE_BUDGET = 20 - 2

/**
 * Raw fields that fit what is left of the attribute budget and pass the ledger's screens, top-level fields first (the
 * deepest ones, such as array items, are dropped first); the rest are counted in `rawOmitted`, never failing the report.
 */
function rawAttributes(unknown: Record<string, RawValue>, room: number): MetricAttributes {
  const kept: MetricAttributes = {}
  let omitted = 0
  const depth = (path: string): number => path.split('.').length
  const entries = Object.entries(unknown).sort(([a], [b]) => depth(a) - depth(b) || a.localeCompare(b))
  for (const [path, value] of entries) {
    const name = `raw.${path}`
    if (Object.keys(kept).length < room - 1 && name.length <= 64 && attributeRefusal(name, value) === null) {
      kept[name] = value
    } else {
      omitted += 1
    }
  }
  return omitted === 0 ? kept : { ...kept, rawOmitted: omitted }
}

/** What every report of the stream says: its format and model (`mixed` when the stream used several). */
function baseAttributes(aggregate: UsageAggregate): MetricAttributes {
  const model = aggregate.models.size === 1 ? [...aggregate.models][0] : aggregate.models.size > 1 ? 'mixed' : undefined
  return { usageFormat: aggregate.format, ...(model === undefined ? {} : { model }) }
}

/** What the total says beyond its number: how it was obtained, the host's list price and how the account pays. */
function totalAttributes(aggregate: UsageAggregate, billing: UsageBilling): MetricAttributes {
  const { categories, samples, listPrice, totalBases } = aggregate
  const totalBasis = categories.total.reported === 0 ? 'not_derivable' : totalBases.size === 1 ? ([...totalBases][0] ?? 'mixed') : 'mixed'
  const price: MetricAttributes =
    listPrice.reported === 0 ? {} : { listPriceUsd: listPrice.reported === samples ? Number(listPrice.value.toFixed(6)) : null, costBasis: 'list_price' }
  return { totalBasis, ...price, billing }
}

/**
 * The token reports of one stream position: `tokens_input`, `tokens_cached_input`, `tokens_output`,
 * `tokens_reasoning` and `tokens_total`, host-sourced, each stating the provider's definition.
 */
export function tokenReports(aggregate: UsageAggregate, identity: UsageStreamIdentity, position: UsagePosition): MetricReport[] {
  const definition = FORMATS[aggregate.format]
  const base = baseAttributes(aggregate)
  const at = position.accumulation === 'cumulative' ? { sequence: position.sequence } : { eventId: position.eventId }
  const report = (metric: MetricKind, measurement: Measurement, attributes: MetricAttributes): MetricReport => ({
    metric,
    unit: 'tokens',
    source: { kind: 'host', actor: identity.actor },
    measurement,
    accumulation: position.accumulation,
    ...at,
    observedAt: position.observedAt,
    attributes: { ...base, ...attributes },
    usage: { coverage: identity.coverage, parentActor: identity.parentActor }
  })
  const { categories, samples } = aggregate
  const cacheWrite: MetricAttributes =
    definition.paths.cacheWrite === null ? {} : { cacheWriteTokens: categories.cacheWrite.reported === samples ? categories.cacheWrite.value : null }
  const total = totalAttributes(aggregate, identity.billing)
  const room = ATTRIBUTE_BUDGET - Object.keys(base).length - Object.keys(total).length
  const reasoning: Measurement = definition.paths.reasoning === null ? { state: 'missing', reason: 'host_unavailable' } : measurementOf(categories.reasoning, samples)
  return [
    report('tokens_input', measurementOf(categories.input, samples), { includesCachedInput: definition.includesCachedInput, ...cacheWrite }),
    report('tokens_cached_input', measurementOf(categories.cachedInput, samples), { subsetOf: definition.includesCachedInput ? 'tokens_input' : null }),
    report('tokens_output', measurementOf(categories.output, samples), { includesReasoning: definition.includesReasoning }),
    report('tokens_reasoning', reasoning, { subsetOf: definition.includesReasoning ? 'tokens_output' : null }),
    report('tokens_total', measurementOf(categories.total, samples), { ...total, ...rawAttributes(aggregate.unknown, room) })
  ]
}
