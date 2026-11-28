import { countMutants } from './gates/mutationGate.js';
import { requireCount, shardRunCount, type Position } from './partition.js';
import { scopeAndAst, type RunFireguardDeps } from './runFireguard.js';

/**
 * Grading seconds each CI shard aims for. A shard job adds about 12 s of setup, and the scope/plan
 * and merge jobs about 45 s more, so a typical pull request's Fireguard returns in about 2 minutes
 * (PR replay of #110 at 120 s per shard: 134 s grading step, 145 s shard job, run 46179646792).
 */
export const GRADING_TARGET_SECONDS = 75;
/** Most grading shards one pull request may start; past it, shards run over the target. */
export const MAX_GRADING_SHARDS = 40;

/**
 * Seconds per unit of grading work on one CI shard (ubuntu-latest, FIREGUARD_CONCURRENCY=1,
 * VITEST_MAX_WORKERS=2), fitted by least squares to the "Grade disjoint flake runs and production
 * modules" step of all 68 shard jobs of PR runs 46139982809, 46110799286, 46058107052,
 * 46118788858 and 46103701366 against each shard report's flake runs, graded test files and
 * mutants. Per run, the fit's total is within 15% of the measured grading time of the large runs.
 */
export const SHARD_TIMING = {
  /** Snapshot, warm Vitest start and reporting, once per shard with work. */
  setupSeconds: 13,
  /** One graded test file in one flake run. */
  testFileRunSeconds: 1.16,
  /** One mutant on a changed line. */
  mutantSeconds: 2.66,
};

/** The units a whole (unsharded) grade executes: every one of them runs on exactly one shard. */
export interface GradingWork {
  gradedTestFiles: number;
  flakeRuns: number;
  mutants: number;
}

export interface GradingPlan {
  work: GradingWork;
  targetSeconds: number;
  maxShards: number;
  count: number;
  /** Estimated grading seconds summed over every shard of the plan. */
  estimatedSeconds: number;
  /** Estimated grading seconds of the plan's longest shard (the first: round-robin shares). */
  estimatedShardSeconds: number;
  /** The GitHub Actions matrix: one entry per shard. */
  matrix: { include: Position[] };
}

/** Estimated grading seconds of one shard: its round-robin share of the flake runs and mutants. */
export function estimateShardSeconds(work: GradingWork, shard: Position): number {
  const runs = shardRunCount(work.flakeRuns, shard);
  const mutants = shardRunCount(work.mutants, shard);
  if (runs + mutants === 0) return 0;
  return SHARD_TIMING.setupSeconds + runs * work.gradedTestFiles * SHARD_TIMING.testFileRunSeconds +
    mutants * SHARD_TIMING.mutantSeconds;
}

/**
 * The fewest shards whose longest one is estimated within the target, capped at the maximum and
 * at the units there are to split. Only the split changes: every unit still runs.
 */
export function planGrading(work: GradingWork): GradingPlan {
  for (const value of Object.values(work)) requireCount(value, 'grading work');
  const limit = Math.min(MAX_GRADING_SHARDS, Math.max(1, work.flakeRuns, work.mutants));
  let count = 1;
  while (count < limit && estimateShardSeconds(work, { index: 1, count }) > GRADING_TARGET_SECONDS) count += 1;
  const include = Array.from({ length: count }, (_, i) => ({ index: i + 1, count }));
  return {
    work,
    targetSeconds: GRADING_TARGET_SECONDS,
    maxShards: MAX_GRADING_SHARDS,
    count,
    estimatedSeconds: Math.round(include.reduce((sum, shard) => sum + estimateShardSeconds(work, shard), 0)),
    estimatedShardSeconds: Math.round(estimateShardSeconds(work, include[0]!)),
    matrix: { include },
  };
}

/**
 * Sizes the CI grade of this diff from what it will execute: the configured flake runs of its
 * graded tests (once the AST gate passes) and its mutants on changed lines. Runs no test.
 */
export async function planFireguard(
  deps: Pick<RunFireguardDeps, 'config' | 'getDiffEntries' | 'readFile' | 'getChangedLines'>
): Promise<GradingPlan> {
  const { scope, ast } = await scopeAndAst(deps);
  if (!ast?.pass) return planGrading({ gradedTestFiles: 0, flakeRuns: 0, mutants: 0 });
  const modules = await Promise.all(
    scope.changedModules.map(async (path) => ({ path, source: await deps.readFile(path) }))
  );
  const mutants = modules.length === 0 ? 0
    : countMutants({ modules, changedLines: await deps.getChangedLines?.(scope.changedModules) });
  return planGrading({
    gradedTestFiles: scope.gradedTestFiles.length,
    flakeRuns: deps.config.thresholds.agenticFlakinessRuns,
    mutants,
  });
}
