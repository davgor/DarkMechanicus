import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  GRADING_TARGET_SECONDS,
  MAX_GRADING_SHARDS,
  estimateShardSeconds,
  planFireguard,
  planGrading,
  type GradingWork,
} from '../src/plan.js';
import { runFireguard, type RunFireguardDeps } from '../src/runFireguard.js';
import { shardRunCount } from '../src/partition.js';
import { fakeLanes, git, initRepo, memorySource, withTempDir } from './support.js';

const files: Record<string, string> = {
  'src/a.ts': 'export function a(n: number) { return n + 1; }',
  'src/d.ts': 'export function d(n: number) {\n  if (n > 1) return n + 2;\n  return n - 3;\n}\n',
  'src/a.test.ts': "import { a } from './a'; it('a', () => expect(a(2)).toBe(3));",
  'src/d.test.ts': "import { d } from './d'; it('d', () => expect(d(2)).toBe(4));",
  'src/empty.test.ts': "it('nothing', () => {});",
};

function deps(paths: string[], changedLines?: Map<string, Set<number>>): RunFireguardDeps {
  return {
    config: DEFAULT_CONFIG,
    revision: { head: 'head', base: 'base' },
    getDiffEntries: async () => paths.map((path) => ({ status: 'M', path })),
    readFile: async (path) => files[path]!,
    getChangedLines: changedLines && (async () => changedLines),
    openLanes: async () => fakeLanes(async () => ({ ok: false }), { source: memorySource(files) }),
  };
}

const work = (gradedTestFiles: number, flakeRuns: number, mutants: number): GradingWork =>
  ({ gradedTestFiles, flakeRuns, mutants });

function positions(count: number) {
  return Array.from({ length: count }, (_, i) => ({ index: i + 1, count }));
}

describe('grading plan sizing', () => {
  it('plans one shard and no grading time for a diff with no grading work', () => {
    const plan = planGrading(work(0, 0, 0));
    expect(plan).toMatchObject({ count: 1, estimatedSeconds: 0, estimatedShardSeconds: 0 });
    expect(plan.matrix).toEqual({ include: [{ index: 1, count: 1 }] });
  });

  it('plans the fewest shards that each meet the target for a small diff', () => {
    const plan = planGrading(work(2, 100, 5));
    expect(plan.count).toBeGreaterThan(1);
    expect(plan.count).toBeLessThan(MAX_GRADING_SHARDS / 2);
    expect(plan.estimatedShardSeconds).toBeLessThanOrEqual(GRADING_TARGET_SECONDS);
    expect(estimateShardSeconds(plan.work, { index: 1, count: plan.count - 1 }))
      .toBeGreaterThan(GRADING_TARGET_SECONDS);
    expect(plan.matrix.include).toEqual(positions(plan.count));
  });

  it('plans more shards as permutation volume grows, each within the target, up to the cap', () => {
    const small = planGrading(work(2, 100, 5));
    const medium = planGrading(work(4, 100, 40));
    const large = planGrading(work(79, 100, 1700));
    expect(small.count).toBeLessThan(medium.count);
    expect(medium.count).toBeLessThan(large.count);
    for (const plan of [small, medium]) {
      expect(plan.estimatedShardSeconds).toBeLessThanOrEqual(GRADING_TARGET_SECONDS);
      for (const shard of positions(plan.count)) {
        expect(estimateShardSeconds(plan.work, shard)).toBeLessThanOrEqual(GRADING_TARGET_SECONDS);
      }
    }
    // Past the cap, the plan reports its honest estimate instead of dropping work.
    expect(large).toMatchObject({ count: MAX_GRADING_SHARDS, maxShards: 40 });
    expect(large.estimatedShardSeconds).toBeGreaterThan(GRADING_TARGET_SECONDS);
  });

  it('never plans more shards than there are units of work to split', () => {
    expect(planGrading(work(400, 3, 0)).count).toBe(3);
    expect(planGrading(work(1, 1, 0)).count).toBe(1);
  });
});

describe('grading plan runner budget', () => {
  it('never plans more shards than the runner budget lets start at once', () => {
    const unbounded = planGrading(work(9, 100, 11));
    expect(unbounded.count).toBeGreaterThan(21);
    const budgeted = planGrading(work(9, 100, 11), 21);
    // 21 shards would leave 5 flake runs and a mutant on the first, as 20 do: the plan takes 20.
    expect(budgeted).toMatchObject({ count: 20, maxShards: 21 });
    expect(budgeted.matrix.include).toEqual(positions(20));
    expect(budgeted.estimatedShardSeconds).toBeGreaterThan(unbounded.estimatedShardSeconds);
    // A budget past the cap keeps the cap; an exhausted budget still grades on one shard.
    expect(planGrading(work(79, 100, 1700), 90).count).toBe(MAX_GRADING_SHARDS);
    expect(planGrading(work(9, 100, 11), 0)).toMatchObject({ count: 1, maxShards: 1 });
  });
});

describe('grading plan partition', () => {
  it('assigns every flake run and mutant of the plan to exactly one shard', () => {
    const plan = planGrading(work(30, 100, 301));
    const shards = positions(plan.count);
    expect(shards.reduce((sum, shard) => sum + shardRunCount(100, shard), 0)).toBe(100);
    expect(shards.reduce((sum, shard) => sum + shardRunCount(301, shard), 0)).toBe(301);
    expect(plan.estimatedSeconds).toBeGreaterThan(0);
  });

  it('rejects work that is not a count', () => {
    expect(() => planGrading(work(1, -1, 0))).toThrow(/work/);
    expect(() => planGrading(work(1, 1, 0.5))).toThrow(/work/);
  });
});

describe('planFireguard', () => {
  it('plans no grading work for a diff without graded tests or with a failing AST gate', async () => {
    expect((await planFireguard(deps(['src/a.ts']))).work).toEqual(work(0, 0, 0));
    expect((await planFireguard(deps([]))).work).toEqual(work(0, 0, 0));
    expect((await planFireguard(deps(['src/a.ts', 'src/empty.test.ts']))).work).toEqual(work(0, 0, 0));
  });

  it('counts the flake budget and exactly the mutants an unsharded run executes', async () => {
    const paths = ['src/a.ts', 'src/d.ts', 'src/a.test.ts', 'src/d.test.ts'];
    const plan = await planFireguard(deps(paths));
    expect(plan.work).toEqual(work(2, 100, 5));
    const report = await runFireguard(deps(paths));
    expect(report.gates.mutation?.total).toBe(plan.work.mutants);
    expect(report.gates.flake?.configuredRuns).toBe(plan.work.flakeRuns);
    const lines = new Map([['src/d.ts', new Set([3])]]);
    expect((await planFireguard(deps(paths, lines))).work).toEqual(work(2, 100, 1));
    expect((await runFireguard(deps(paths, lines))).gates.mutation?.total).toBe(1);
  });

  it('plans from the CLI against the committed diff', async () => {
    await withTempDir(async (dir) => {
      initRepo(dir);
      await writeFile(join(dir, 'tracked'), 'base');
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'base');
      const base = git(dir, 'rev-parse', 'HEAD');
      await mkdir(join(dir, 'src'));
      for (const path of ['src/d.ts', 'src/d.test.ts']) await writeFile(join(dir, path), files[path]!);
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'change');
      const out = join(dir, 'plan.json');
      let stdout = '';
      const code = await runCli({ cwd: dir, argv: ['--plan', '--json-out', out],
        env: { FIREGUARD_BASE_REF: base }, stdout: (text) => { stdout += text; } });
      expect(code).toBe(0);
      const plan = JSON.parse(readFileSync(out, 'utf8'));
      expect(plan.work).toEqual(work(1, 100, 4));
      expect(plan.matrix.include).toHaveLength(plan.count);
      expect(stdout).toContain(`fireguard plan: ${plan.count} grading shard`);
      const misuse = await runCli({ cwd: dir, argv: ['--plan', '--shard', '1/2'],
        env: { FIREGUARD_BASE_REF: base }, stderr: () => {} });
      expect(misuse).toBe(2);
      const budgetOut = join(dir, 'budget.json');
      expect(await runCli({ cwd: dir, argv: ['--plan', '--runner-budget', '2', '--json-out', budgetOut],
        env: { FIREGUARD_BASE_REF: base }, stdout: () => {} })).toBe(0);
      expect(JSON.parse(readFileSync(budgetOut, 'utf8'))).toMatchObject({ count: 2, maxShards: 2 });
      expect(await runCli({ cwd: dir, argv: ['--plan', '--runner-budget', 'many'],
        env: { FIREGUARD_BASE_REF: base }, stderr: () => {} })).toBe(2);
    });
  });
});
