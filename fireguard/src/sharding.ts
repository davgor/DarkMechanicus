import { scoreMutations } from './gates/mutationGate.js';
import { computeGrade } from './grade.js';
import { parseShard, requireCount, shardRunCount } from './partition.js';
import type { FireguardReport, MutationGateResult, ShardIdentity } from './types.js';

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Every shard collects the same mutants and runs its round-robin share: the shares must sum to
 * the one planned count, so a dropped, repeated or extra mutant fails the merge.
 */
function checkMutationShare(mutation: MutationGateResult | undefined, first: MutationGateResult,
  report: FireguardReport, modules: string[]): MutationGateResult {
  const shard = report.shard!;
  if (!mutation || !same(mutation.modules, modules)) throw new Error('missing mutation module scope');
  const planned = first.planned;
  if (planned === undefined || mutation.planned !== planned) throw new Error('mismatched planned mutant count');
  requireCount(planned, 'planned mutants');
  if (!same(mutation.moduleTests, first.moduleTests) ||
      mutation.unchangedLineMutants !== first.unchangedLineMutants) throw new Error('shard mutation scope mismatch');
  requireCount(mutation.killed, 'killed mutants');
  requireCount(mutation.survived, 'survived mutants');
  if (mutation.total !== mutation.killed + mutation.survived || mutation.survivors.length !== mutation.survived) {
    throw new Error('inconsistent mutation counts');
  }
  if (mutation.total !== shardRunCount(planned, shard)) {
    throw new Error(`incomplete mutant share for shard ${shard.index}`);
  }
  return mutation;
}

/** Validate manifests before scoring; absence, truncation or a tool error cannot become a pass. */
export function mergeShards(
  reports: FireguardReport[],
  count: number,
  identity: Pick<ShardIdentity, 'head' | 'base'>
): FireguardReport {
  parseShard(`1/${count}`);
  if (reports.length < count) throw new Error(`missing shard reports: expected ${count}, got ${reports.length}`);
  if (reports.length > count) throw new Error(`extra shard reports: expected ${count}, got ${reports.length}`);
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
    if (!report.revision || report.revision.head !== identity.head
      || report.revision.base !== identity.base) throw new Error('shard report revision commit mismatch');
    if (shard.head !== identity.head || shard.base !== identity.base) throw new Error('shard commit mismatch');
    if (!same(shard.config, config)) throw new Error('shard config mismatch');
    if (!same(report.scope, first.scope)) throw new Error('shard scope mismatch');
    if (!same(report.gates.ast, first.gates.ast)) throw new Error('shard AST mismatch');
    if (report.skipped !== first.skipped) throw new Error('shard skip mismatch');
  }
  const gates: FireguardReport['gates'] = { ast: first.gates.ast };
  const combined: FireguardReport = { revision: identity, scope: first.scope, skipped: first.skipped,
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
    const firstMutation = first.gates.mutation;
    if (!firstMutation) throw new Error('missing mutation module scope');
    let killed = 0;
    let survived = 0;
    const survivors: MutationGateResult['survivors'] = [];
    for (const report of ordered) {
      const mutation = checkMutationShare(report.gates.mutation, firstMutation, report, first.scope.changedModules);
      killed += mutation.killed;
      survived += mutation.survived;
      survivors.push(...mutation.survivors);
    }
    gates.mutation = scoreMutations({ killed, survived, survivors: survivors.sort((a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line), modules: first.scope.changedModules,
      moduleTests: firstMutation.moduleTests && Object.fromEntries(Object.entries(firstMutation.moduleTests)
        .sort(([a], [b]) => a.localeCompare(b))),
      unchangedLineMutants: firstMutation.unchangedLineMutants, minScore: config.thresholds.minMutationScore });
  }
  if (first.execution) combined.execution = { ...first.execution,
    lanes: ordered.reduce((sum, report) => sum + (report.execution?.lanes ?? 0), 0) };
  combined.grade = computeGrade(gates);
  return combined;
}
