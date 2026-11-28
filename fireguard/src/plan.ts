import { countMutants } from './gates/mutationGate.js';
import { requireCount, shardRunCount, type Position } from './partition.js';
import { scopeAndAst, type RunFireguardDeps } from './runFireguard.js';

/**
 * Estimated grading seconds each CI shard aims for. A shard job adds about 14 s of setup, the
 * scope/plan and merge jobs about 40 s and job hand-offs a few more, so a typical pull request's
 * Fireguard returns in about 2 minutes. The estimate is a mean fit; the longest shard measured up to
 * 20 s over it (#110 replay at 75 s: estimated 68 s, longest grading step 81 s, run 46180200415).
 */
export const GRADING_TARGET_SECONDS = 50;
/** Most grading shards one pull request may start; past it, shards run over the target. */
export const MAX_GRADING_SHARDS = 40;

/**
 * Seconds per unit of grading work on one CI shard (ubuntu-latest, FIREGUARD_CONCURRENCY=1,
 * VITEST_MAX_WORKERS=2), fitted by least squares to the "Grade disjoint flake runs and production
 * modules" step of all 84 shard jobs of the mutant-sharded runs 46180200415, 46179646792,
 * 46178522119 and 46178525828 against each shard report's flake runs, graded test files and mutants.
 */
export const SHARD_TIMING = {
  /** Snapshot, warm Vitest start and reporting, once per shard with work. */
  setupSeconds: 0.44,
  /** One flake run, whatever its files: fresh test workers and collection. */
  flakeRunSeconds: 4.71,
  /** One graded test file in one flake run. */
  testFileRunSeconds: 0.835,
  /** One mutant on a changed line. */
  mutantSeconds: 3.54,
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
  return SHARD_TIMING.setupSeconds +
    runs * (SHARD_TIMING.flakeRunSeconds + work.gradedTestFiles * SHARD_TIMING.testFileRunSeconds) +
    mutants * SHARD_TIMING.mutantSeconds;
}

/**
 * The fewest shards whose longest one is estimated within the target, capped at the maximum, at
 * `runnerBudget` (shards that can start at once beside the workflow's other jobs: more only queue
 * as a second wave behind them) and at the units there are to split. Only the split changes:
 * every unit still runs.
 */
export function planGrading(work: GradingWork, runnerBudget = MAX_GRADING_SHARDS): GradingPlan {
  for (const value of Object.values(work)) requireCount(value, 'grading work');
  requireCount(runnerBudget, 'runner budget');
  const maxShards = Math.max(1, Math.min(MAX_GRADING_SHARDS, runnerBudget));
  const limit = Math.min(maxShards, Math.max(1, work.flakeRuns, work.mutants));
  let count = 1;
  while (count < limit && estimateShardSeconds(work, { index: 1, count }) > GRADING_TARGET_SECONDS) count += 1;
  // A capped plan drops shards that would not shorten its longest one (100 runs over 21 or 20 shards
  // both leave 5 on the first), so it holds no runner it does not need.
  const longest = estimateShardSeconds(work, { index: 1, count });
  while (count > 1 && estimateShardSeconds(work, { index: 1, count: count - 1 }) === longest) count -= 1;
  const include = Array.from({ length: count }, (_, i) => ({ index: i + 1, count }));
  return {
    work,
    targetSeconds: GRADING_TARGET_SECONDS,
    maxShards,
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
  deps: Pick<RunFireguardDeps, 'config' | 'getDiffEntries' | 'readFile' | 'getChangedLines'>,
  runnerBudget = MAX_GRADING_SHARDS
): Promise<GradingPlan> {
  const { scope, ast } = await scopeAndAst(deps);
  if (!ast?.pass) return planGrading({ gradedTestFiles: 0, flakeRuns: 0, mutants: 0 }, runnerBudget);
  const modules = await Promise.all(
    scope.changedModules.map(async (path) => ({ path, source: await deps.readFile(path) }))
  );
  const mutants = modules.length === 0 ? 0
    : countMutants({ modules, changedLines: await deps.getChangedLines?.(scope.changedModules) });
  return planGrading({
    gradedTestFiles: scope.gradedTestFiles.length,
    flakeRuns: deps.config.thresholds.agenticFlakinessRuns,
    mutants,
  }, runnerBudget);
}
