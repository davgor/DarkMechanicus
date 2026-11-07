import { scoreMutations } from './gates/mutationGate.js';
import { computeGrade } from './grade.js';
import type { FireguardReport, ShardIdentity } from './types.js';

type Position = Pick<ShardIdentity, 'index' | 'count'>;

export function parseShard(value: string): Position {
  if (!/^\d+\/\d+$/.test(value)) throw new Error('shard must be index/count');
  const [index, count] = value.split('/').map(Number);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index! < 1 || count! < index!) {
    throw new Error('invalid shard index/count');
  }
  return { index: index!, count: count! };
}

/** Stable round-robin partition, including empty shards. */
export function partition<T>(items: readonly T[], shard: Position): T[] {
  parseShard(`${shard.index}/${shard.count}`);
  return items.filter((_, index) => index % shard.count === shard.index - 1);
}

/** Number of globally indexed flake runs owned by this round-robin shard. */
export function shardRunCount(budget: number, shard: Position): number {
  parseShard(`${shard.index}/${shard.count}`);
  requireCount(budget, 'configured runs');
  return Math.max(0, Math.ceil((budget - shard.index + 1) / shard.count));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${label}`);
}

/** Validate manifests before scoring; absence, truncation or a tool error cannot become a pass. */
export function mergeShards(
  reports: FireguardReport[],
  count: number,
  identity: Pick<ShardIdentity, 'head' | 'base'>
): FireguardReport {
  parseShard(`1/${count}`);
  if (reports.length !== count) throw new Error(`missing shard reports: expected ${count}, got ${reports.length}`);
  const ordered = [...reports].sort((a, b) => (a.shard?.index ?? 0) - (b.shard?.index ?? 0));
  const first = ordered[0]!;
  const config = first.shard?.config;
  if (!config) throw new Error('missing shard config');
  const seen = new Set<number>();
  for (const report of ordered) {
    const shard = report.shard;
    if (!shard || shard.count !== count) throw new Error('missing or mismatched shard manifest');
    parseShard(`${shard.index}/${shard.count}`);
    if (seen.has(shard.index)) throw new Error('duplicate shard index');
    seen.add(shard.index);
    if (shard.head !== identity.head || shard.base !== identity.base) throw new Error('shard commit mismatch');
    if (!same(shard.config, config)) throw new Error('shard config mismatch');
    if (!same(report.scope, first.scope)) throw new Error('shard scope mismatch');
    if (!same(report.gates.ast, first.gates.ast)) throw new Error('shard AST mismatch');
    if (report.skipped !== first.skipped) throw new Error('shard skip mismatch');
  }
  const gates: FireguardReport['gates'] = { ast: first.gates.ast };
  const combined: FireguardReport = { scope: first.scope, skipped: first.skipped,
    skipReason: first.skipReason, gates, grade: first.grade };
  if (first.scope.gradedTestFiles.length === 0) {
    combined.gates = {};
    combined.skipped = first.scope.changedModules.length === 0;
    combined.grade = combined.skipped
      ? { letter: 'A', score: 100, reasons: ['no graded unit tests to evaluate'] }
      : { letter: 'F', score: 0, reasons: ['production modules changed without graded unit test updates'] };
    return combined;
  }
  if (!gates.ast) throw new Error('missing AST gate');
  if (!gates.ast.pass) { combined.grade = computeGrade(gates); return combined; }

  const budget = config.thresholds.agenticFlakinessRuns;
  requireCount(budget, 'configured runs');
  const failedRuns: NonNullable<FireguardReport['gates']['flake']>['failedRuns'] = [];
  let runs = 0;
  for (const report of ordered) {
    const shard = report.shard!;
    const flake = report.gates.flake;
    if (!flake) throw new Error(`missing flake gate for shard ${shard.index}`);
    const assigned = shardRunCount(budget, shard);
    requireCount(flake.runs, 'executed runs');
    requireCount(flake.failures, 'failed runs');
    if (flake.configuredRuns !== assigned || flake.runs > assigned ||
        flake.failures !== flake.failedRuns.length || flake.failures > flake.runs ||
        (flake.pass && (flake.runs !== assigned || flake.failures !== 0)) ||
        (!flake.pass && flake.failures === 0) || !same(flake.files, first.scope.gradedTestFiles)) {
      throw new Error(`incomplete flake runs for shard ${shard.index}`);
    }
    for (const failure of flake.failedRuns) {
      if (!Number.isSafeInteger(failure.run) || failure.run < 1 || failure.run > assigned) {
        throw new Error('invalid failed run index');
      }
      failedRuns.push({ ...failure, run: (failure.run - 1) * count + shard.index });
    }
    runs += flake.runs;
  }
  failedRuns.sort((a, b) => a.run - b.run);
  gates.flake = { name: 'flake', pass: failedRuns.length === 0, runs, configuredRuns: budget,
    failures: failedRuns.length, flakeRate: failedRuns.length / budget || 0,
    files: first.scope.gradedTestFiles, failedRuns, failFast: true };
  if (gates.flake.pass && first.scope.changedModules.length > 0) {
    let killed = 0;
    let survived = 0;
    let unchangedLineMutants = 0;
    const survivors: NonNullable<FireguardReport['gates']['mutation']>['survivors'] = [];
    const moduleTests: Record<string, number> = {};
    for (const report of ordered) {
      const mutation = report.gates.mutation;
      const modules = partition(first.scope.changedModules, report.shard!);
      if (!mutation || !same(mutation.modules, modules)) throw new Error('missing mutation module partition');
      requireCount(mutation.killed, 'killed mutants');
      requireCount(mutation.survived, 'survived mutants');
      if (mutation.total !== mutation.killed + mutation.survived || mutation.survivors.length !== mutation.survived) {
        throw new Error('inconsistent mutation counts');
      }
      killed += mutation.killed;
      survived += mutation.survived;
      survivors.push(...mutation.survivors);
      Object.assign(moduleTests, mutation.moduleTests);
      unchangedLineMutants += mutation.unchangedLineMutants ?? 0;
    }
    gates.mutation = scoreMutations({ killed, survived, survivors: survivors.sort((a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line), modules: first.scope.changedModules,
      moduleTests: ordered.every((report) => report.gates.mutation?.moduleTests)
        ? Object.fromEntries(Object.entries(moduleTests).sort(([a], [b]) => a.localeCompare(b))) : undefined,
      unchangedLineMutants: ordered.every((report) => report.gates.mutation?.unchangedLineMutants !== undefined)
        ? unchangedLineMutants : undefined, minScore: config.thresholds.minMutationScore });
  }
  if (first.execution) combined.execution = { ...first.execution,
    lanes: ordered.reduce((sum, report) => sum + (report.execution?.lanes ?? 0), 0) };
  combined.grade = computeGrade(gates);
  return combined;
}
