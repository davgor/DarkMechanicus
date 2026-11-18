/**
 * `dm usage`: the host adapter for agents whose host writes its own session files (`HOST_USAGE_SUPPORT`). Run by the
 * orchestrator's session (its grant), it reads that host's session (the main file and every subagent's), attributes
 * each thread's usage to the run's buckets through the session links the transcript holds (`hostAttribution.ts`), and
 * records it through the same commands an external MCP host uses (`recordAttemptMetrics`, `recordRunMetrics`). It
 * adds no authority: the grant decides what may be recorded, exactly as for `dm call`.
 *
 * Reading the same session again records nothing new (each delivery keeps its identity), so it can run after every
 * row or at the end of the run. A host that cannot report usage runs `--unavailable <host>`, which records each
 * usage metric as `missing` (`host_unavailable`) for the run and for every executing attempt that reported nothing,
 * so the gap reads as unavailable instead of unreported, and never as an estimate.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DomainError } from '../core/errors'
import { attributeHostUsage, type ThreadShare } from '../core/space/hostAttribution'
import { detectHost, type HostTranscript, readClaudeTranscript, readOmpTranscript, type TranscriptFile } from '../core/space/hostTranscripts'
import type { CommandApi } from '../shared/domain/api'
import { HOST_USAGE_SUPPORT, type HostUsageSupport } from '../shared/domain/hostUsage'
import { type MetricReport, USAGE_METRICS } from '../shared/domain/metrics'
import { METRIC_DEFINITIONS } from '../shared/domain/space'
import type { UsageMode } from './args'

/** How long a thread must be quiet, with nothing running, before its last span (or Claude message) counts. */
const SETTLE_MS = 15 * 60_000
/** Activity intervals closer than this are one span (the host's own gap between a request and its tools). */
const GAP_TOLERANCE_MS = 5_000
const PER_CALL = 500
const HOST_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

type UsageApi = Pick<CommandApi, 'getRunMetrics' | 'recordAttemptMetrics' | 'recordRunMetrics'>

interface UsageReportView {
  runId: string
  host: string
  sessionId: string | null
  support: HostUsageSupport | null
  dryRun: boolean
  threads: ThreadShare[]
  notes: string[]
  /** Observation ids stored by this run of the command, and ids that were already stored (repeated deliveries). */
  created: number
  unchanged: number
}

function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

/** Every `.jsonl` file under `folder`, nested folders included (a subagent's own subagents). */
function jsonlFiles(folder: string): TranscriptFile[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.toLowerCase().endsWith('.jsonl'))
    .map((name) => ({ name: basename(name), text: readText(join(folder, name)) }))
}

/** Whether an OMP session file is a subagent's: its `session` header names the session that started it. */
function isOmpSubagent(text: string): boolean {
  for (const line of text.split(/\r?\n/, 20)) {
    if (!line.includes('"session"')) continue
    try {
      const header: unknown = JSON.parse(line)
      if (header !== null && typeof header === 'object' && 'type' in header && header.type === 'session') {
        return 'parentSession' in header && typeof header.parentSession === 'string' && header.parentSession !== ''
      }
    } catch {
      return false
    }
  }
  return false
}

/**
 * An OMP session from any of its files. OMP keeps a session's subagent files in the folder named after the file of the
 * session that started them (`<parent>/<name>.jsonl`), so the main file is found by walking up that layout; the
 * absolute `parentSession` paths are not followed, so a session folder read where it was copied still reads whole.
 */
function ompSession(path: string): HostTranscript {
  let main = path
  while (isOmpSubagent(readText(main)) && existsSync(`${dirname(main)}.jsonl`)) {
    main = `${dirname(main)}.jsonl`
  }
  const folder = main.replace(/\.jsonl$/i, '')
  const subagents = jsonlFiles(folder).filter((file) => detectHost(file.text) === 'omp')
  return readOmpTranscript({ name: basename(main), text: readText(main) }, subagents)
}

/** A Claude Code session from its main file (or a subagent's, under `<session>/subagents/`). */
function claudeSession(path: string, asOf: number): HostTranscript {
  const inSubagents = basename(dirname(path)) === 'subagents'
  const main = inSubagents ? `${dirname(dirname(path))}.jsonl` : path
  const subagents = jsonlFiles(join(main.replace(/\.jsonl$/i, ''), 'subagents'))
  return readClaudeTranscript({ name: basename(main), text: readText(main) }, subagents, { asOf, settleMs: SETTLE_MS })
}

interface Totals {
  created: number
  unchanged: number
}

/** One bucket's reports: an attempt's, or the run's orchestration or unattributed overhead. */
type RecordBucket = { attemptId: string; overhead: null; reports: MetricReport[] } | { attemptId: null; overhead: 'orchestration' | 'unattributed'; reports: MetricReport[] }

async function record(api: UsageApi, runId: string, buckets: RecordBucket[]): Promise<Totals> {
  const totals: Totals = { created: 0, unchanged: 0 }
  for (const bucket of buckets) {
    for (let start = 0; start < bucket.reports.length; start += PER_CALL) {
      const reports = bucket.reports.slice(start, start + PER_CALL)
      const result =
        bucket.attemptId !== null
          ? await api.recordAttemptMetrics({ attemptId: bucket.attemptId, reports })
          : await api.recordRunMetrics({ runId, overhead: bucket.overhead, reports })
      totals.created += result.created.length
      totals.unchanged += result.unchanged.length
    }
  }
  return totals
}

/** Each usage metric as missing because `host` cannot report it: no number, no estimate. */
function unavailableReports(host: string, observedAt: string): MetricReport[] {
  return USAGE_METRICS.map((metric): MetricReport => {
    const position = METRIC_DEFINITIONS[metric].accumulations.includes('cumulative') ? { accumulation: 'cumulative' as const, sequence: 0 } : { accumulation: 'delta' as const, eventId: 'host-unavailable' }
    return {
      metric,
      unit: METRIC_DEFINITIONS[metric].unit,
      source: { kind: 'host', actor: `${host}:unavailable` },
      measurement: { state: 'missing', reason: 'host_unavailable' },
      ...position,
      observedAt,
      attributes: { hostUsage: 'unavailable' }
    }
  })
}

async function reportUnavailable(api: UsageApi, mode: UsageMode, host: string, now: number): Promise<UsageReportView> {
  if (!HOST_LABEL.test(host)) {
    throw new DomainError('invalid_input', '--unavailable names the host in 1-40 letters, digits and . _ -.')
  }
  const run = await api.getRunMetrics({ runId: mode.runId })
  // Only buckets that hold nothing at all are marked: one with real numbers keeps them, and one already marked
  // unavailable is not sent again, so the command can run after every row (each delivery is sent once).
  const silent = (cells: readonly { coverage: string }[] | undefined): boolean => cells === undefined || cells.every((cell) => cell.coverage === 'unreported')
  const attempts = run.attempts.filter((attempt) => silent(attempt.usage))
  const orchestration = silent(run.overheadByKind.find((kind) => kind.overhead === 'orchestration')?.usage)
  const reports = unavailableReports(host, new Date(now).toISOString())
  const buckets: RecordBucket[] = [
    ...(orchestration ? [{ attemptId: null, overhead: 'orchestration' as const, reports }] : []),
    ...attempts.map((attempt) => ({ attemptId: attempt.attemptId, overhead: null, reports }))
  ]
  const totals = mode.dryRun ? { created: 0, unchanged: 0 } : await record(api, mode.runId, buckets)
  return {
    runId: mode.runId,
    host,
    sessionId: null,
    support: null,
    dryRun: mode.dryRun,
    threads: [],
    notes: [`Recorded as unavailable from ${host}: ${orchestration ? "the run's orchestration bucket and " : ''}${attempts.length} attempt(s) that reported nothing.`],
    ...totals
  }
}

/** Runs `dm usage` against a workspace opened with the caller's grant. */
export async function reportHostUsage(api: UsageApi, mode: UsageMode, now: number): Promise<UsageReportView> {
  if (mode.unavailable !== null) {
    return reportUnavailable(api, mode, mode.unavailable, now)
  }
  if (mode.sessionFile === null) {
    throw new DomainError(
      'invalid_input',
      'No host session file: pass --session-file <path> (OMP sets $PI_SESSION_FILE), or --unavailable <host> when your host cannot report usage; an external host can still send real numbers with record_attempt_metrics.'
    )
  }
  if (!existsSync(mode.sessionFile)) {
    throw new DomainError('not_found', 'The host session file does not exist.')
  }
  const host = detectHost(readText(mode.sessionFile))
  if (host === null) {
    throw new DomainError('invalid_input', 'The session file is neither an OMP nor a Claude Code session; report its usage with record_attempt_metrics, or record it unavailable with --unavailable <host>.')
  }
  const transcript = host === 'omp' ? ompSession(mode.sessionFile) : claudeSession(mode.sessionFile, now)
  const run = await api.getRunMetrics({ runId: mode.runId })
  const attribution = attributeHostUsage(
    transcript,
    { runId: run.runId, executing: new Set(run.attempts.map((attempt) => attempt.attemptId)), carriedForward: new Set(run.carriedForward) },
    { asOf: now, settleMs: SETTLE_MS, gapToleranceMs: GAP_TOLERANCE_MS, billing: mode.billing }
  )
  if (!attribution.linked) {
    throw new DomainError('unmet_prerequisite', `${attribution.notes.join(' ')} Run dm usage from the session that orchestrates the run.`)
  }
  const buckets = attribution.buckets.map(({ bucket, reports }): RecordBucket =>
    bucket.kind === 'attempt' ? { attemptId: bucket.attemptId, overhead: null, reports } : { attemptId: null, overhead: bucket.overhead === 'orchestration' ? 'orchestration' : 'unattributed', reports }
  )
  const totals = mode.dryRun ? { created: 0, unchanged: 0 } : await record(api, mode.runId, buckets)
  return {
    runId: mode.runId,
    host,
    sessionId: transcript.sessionId,
    support: HOST_USAGE_SUPPORT[host === 'omp' ? 'omp' : 'claude'],
    dryRun: mode.dryRun,
    threads: attribution.shares,
    notes: attribution.notes,
    ...totals
  }
}
