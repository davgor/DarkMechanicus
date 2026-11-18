// DM-164 c5: one supported real-host observation beside the replay fixtures, through the shipped readers and
// normalizer (src/core/space/hostTranscripts.ts, hostUsage.ts at the commit under test).
// - real: a COPY (in %TEMP%) of one live OMP session file; prints only the host, the file's size and sha256, sample
//   counts and the normalized token/time numbers (no transcript text);
// - replay: the checked-in OMP (main + 3 subagents), Claude Code (main + 1 subagent, nested) and Codex (cumulative
//   running totals) fixtures;
// - missing provider: the support table, and a stream whose provider leaves categories out reads missing
//   (host_unavailable / partial_coverage), never 0.
// Run from the worktree: npx tsx docs/verification/DM-164/core/real-host.ts <copy of an OMP session .jsonl>
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readClaudeTranscript, readCodexTotals, readOmpTranscript, type HostTranscript } from '../../../../src/core/space/hostTranscripts'
import { addSample, breakdownOf, cumulativeDeltas, emptyAggregate, tokenReports } from '../../../../src/core/space/hostUsage'
import { HOST_USAGE_SUPPORT } from '../../../../src/shared/domain/hostUsage'

const fixtures = resolve(import.meta.dirname, '..', '..', '..', '..', 'src', 'core', 'space', 'fixtures', 'usage')
const at = new Date().toISOString()

/** Normalized token reports of every thread of a transcript, one line each, plus active time from its spans. */
function show(label: string, transcript: HostTranscript): void {
  for (const thread of transcript.threads) {
    const aggregate = emptyAggregate(thread.usage[0]?.breakdown.format ?? 'omp')
    for (const sample of thread.usage) addSample(aggregate, sample.breakdown, sample.model)
    const reports = tokenReports(aggregate, { actor: `${transcript.host}:${thread.name}`, parentActor: thread.parent, coverage: 'self', billing: 'unknown' }, { accumulation: 'cumulative', sequence: 1, observedAt: at })
    const tokens = reports.map((r) => `${r.metric.replace('tokens_', '')}=${r.measurement.state === 'missing' ? `missing(${r.measurement.reason})` : r.measurement.value}`).join(' ')
    const activeMs = thread.activity.reduce((sum, span) => sum + ((span.end ?? span.start) - span.start), 0)
    console.log(`${label} host=${transcript.host} thread=${thread.parent === null ? 'main' : `subagent(parent ${thread.parent})`} samples=${thread.usage.length} ${tokens} activeMs=${activeMs}`)
  }
}

const copy = process.argv[2]
if (copy === undefined) throw new Error('usage: real-host.ts <copy of an OMP session .jsonl>')
const text = readFileSync(copy, 'utf8')
console.log(`REAL  OMP session file copy: ${statSync(copy).size} bytes, sha256 ${createHash('sha256').update(text).digest('hex')}`)
show('REAL ', readOmpTranscript({ name: 'session.jsonl', text }, []))

const OMP = '2026-11-15T20-19-53-174Z_01a1e0dd-c6d6-7423-927a-00d64802c690'
const omp = (name: string) => ({ name, text: readFileSync(join(fixtures, 'omp', name.startsWith(OMP) ? name : join(OMP, name)), 'utf8') })
show('REPLAY', readOmpTranscript(omp(`${OMP}.jsonl`), ['DM-1Worker.jsonl', 'DM-1Helper.jsonl', 'DM-1Review.jsonl'].map(omp)))
const CLAUDE = '6f1c2a4e-9b3d-4c8a-a1e2-3f4b5c6d7e8f'
const claude = (path: string) => ({ name: path.split('/').at(-1) ?? path, text: readFileSync(join(fixtures, 'claude', path), 'utf8') })
show('REPLAY', readClaudeTranscript(claude(`${CLAUDE}.jsonl`), [claude(`${CLAUDE}/subagents/agent-a1b2c3.jsonl`)], { asOf: Date.parse('2027-01-01T00:00:00Z'), settleMs: 15 * 60_000 }))
const codexFile = 'rollout-2026-11-15T10-00-00-0199a2b3-c4d5-7e6f-8091-a2b3c4d5e6f7.jsonl'
const totals = readCodexTotals(readFileSync(join(fixtures, 'codex', codexFile), 'utf8')).map((entry) => entry.breakdown)
const deltas = cumulativeDeltas(totals)
console.log(`REPLAY host=codex cumulative running totals ${totals.map((t) => t.total).join(' -> ')}; deltas ${deltas.map((d) => d.total).join(' + ')} = ${deltas.reduce((s, d) => s + (d.total ?? 0), 0)} (each token counted once)`)

console.log(`MISSING support table: ${Object.entries(HOST_USAGE_SUPPORT).map(([kind, s]) => `${kind}: tokens ${s.tokens}, time ${s.activeTime}`).join('; ')}`)
const partial = emptyAggregate('omp')
addSample(partial, breakdownOf('omp', { input: 100, output: 20, totalTokens: 120 }), null)
addSample(partial, breakdownOf('omp', { input: 50 }), null)
const missing = tokenReports(partial, { actor: 'omp:demo', parentActor: null, coverage: 'self', billing: 'unknown' }, { accumulation: 'cumulative', sequence: 1, observedAt: at })
console.log(`MISSING a stream whose provider left categories out: ${missing.map((r) => `${r.metric}=${r.measurement.state === 'missing' ? `missing(${r.measurement.reason})` : r.measurement.value}`).join(' ')}`)
