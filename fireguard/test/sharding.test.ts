import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { runFireguard, type RunFireguardDeps } from '../src/runFireguard.js';
import { mergeShards, partition, parseShard, shardRunCount } from '../src/sharding.js';
import type { FireguardReport } from '../src/types.js';
import { fakeLanes, git, initRepo, memorySource, withTempDir } from './support.js';

const files: Record<string, string> = {
  'src/a.ts': 'export function a(n: number) { return n + 1; }',
  'src/b.ts': 'export function b(n: number) { return n * 2; }',
  'src/c.ts': 'export function c(n: number) { return n - 1; }',
  'src/a.test.ts': "import { a } from './a'; it('a', () => expect(a(2)).toBe(3));",
  'src/b.test.ts': "import { b } from './b'; it('b', () => expect(b(2)).toBe(4));",
};
const identity = { head: 'head-commit', base: 'base-commit' };

function harness(shard?: { index: number; count: number }, fail = false) {
  const runs: string[][] = [];
  const mutants: string[] = [];
  const deps: RunFireguardDeps = {
    config: DEFAULT_CONFIG,
    shard: shard && { ...shard, ...identity },
    getDiffEntries: async () => Object.keys(files).map((path) => ({ status: 'M', path })),
    readFile: async (path) => files[path]!,
    openLanes: async () => fakeLanes(async ({ file }) => {
      mutants.push(file);
      return { ok: false };
    }, {
      source: memorySource(files),
      runOnce: async (tests) => { runs.push(tests); return { ok: !fail, error: 'fixture failure' }; },
    }),
  };
  return { deps, runs, mutants };
}

async function reports() {
  return Promise.all([1, 2].map((index) => runFireguard(harness({ index, count: 2 }).deps)));
}

describe('CI workload sharding', () => {
  it('partitions uneven and empty workloads exhaustively without duplicates', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    expect([1, 2, 3].map((index) => partition(input, { index, count: 3 })))
      .toEqual([['a', 'd'], ['b', 'e'], ['c']]);
    expect(partition([], { index: 2, count: 3 })).toEqual([]);
    expect(partition(['a'], { index: 2, count: 3 })).toEqual([]);
    expect(parseShard('2/3')).toEqual({ index: 2, count: 3 });
    expect([1, 2, 3].map((index) => shardRunCount(100, { index, count: 3 }))).toEqual([34, 33, 33]);
    expect(shardRunCount(1, { index: 3, count: 3 })).toBe(0);
    for (const value of ['0/2', '3/2', '1/0', '1.5/2', 'oops']) {
      expect(() => parseShard(value)).toThrow();
    }
  });

  it('combines raw workloads and counts into the unsharded verdict, never averages scores', async () => {
    const whole = harness();
    const expected = await runFireguard(whole.deps);
    const shards = [harness({ index: 1, count: 2 }), harness({ index: 2, count: 2 })];
    const partial = await Promise.all(shards.map(({ deps }) => runFireguard(deps)));
    const combined = mergeShards(partial, 2, identity);
    expect(shards.map(({ runs }) => runs.length)).toEqual([50, 50]);
    expect(shards.flatMap(({ runs }) => runs)).toEqual(whole.runs);
    expect(shards.flatMap(({ mutants }) => mutants).sort()).toEqual(whole.mutants.sort());
    expect(combined.gates).toEqual(expected.gates);
    expect(combined.grade).toEqual(expected.grade);
    expect(combined.gates.mutation).toMatchObject({ total: 3, killed: 2, survived: 1, score: 67 });
    expect(combined.gates.ast?.assertionCount).toBe(2);
  });

  it('handles empty module partitions and diffs with no grading work', async () => {
    const shards = await Promise.all([1, 2, 3, 4].map(async (index) => {
      const { deps } = harness({ index, count: 4 });
      deps.getDiffEntries = async () => [{ status: 'M', path: 'src/a.test.ts' }];
      return runFireguard(deps);
    }));
    expect(mergeShards(shards, 4, identity).gates.flake).toMatchObject({ runs: 100, configuredRuns: 100 });
    const empty = await Promise.all([1, 2].map(async (index) => {
      const { deps } = harness({ index, count: 2 });
      deps.getDiffEntries = async () => [];
      return runFireguard(deps);
    }));
    expect(mergeShards(empty, 2, identity)).toMatchObject({ skipped: true, grade: { letter: 'A' } });
    const sparse = await Promise.all([1, 2, 3, 4].map(async (index) => {
      const { deps } = harness({ index, count: 4 });
      deps.getDiffEntries = async () => ['src/a.ts', 'src/a.test.ts'].map((path) => ({ status: 'M', path }));
      return runFireguard(deps);
    }));
    expect(sparse.map((report) => report.gates.mutation?.modules))
      .toEqual([['src/a.ts'], [], [], []]);
    expect(mergeShards(sparse, 4, identity).gates.mutation).toMatchObject({ killed: 1, total: 1 });
  });

  it('fails closed for missing, duplicate, mismatched and incomplete shards', async () => {
    const partial = await reports();
    expect(() => mergeShards(partial.slice(0, 1), 2, identity)).toThrow(/missing/i);
    expect(() => mergeShards([partial[0]!, partial[0]!], 2, identity)).toThrow(/duplicate/i);
    expect(() => mergeShards(partial, 2, { ...identity, head: 'different' })).toThrow(/commit/i);
    expect(() => mergeShards(partial, 2, { ...identity, base: 'different' })).toThrow(/commit/i);
    const differentConfig = partial.map((report) => structuredClone(report));
    differentConfig[1]!.shard!.config.thresholds.minMutationScore = 1;
    expect(() => mergeShards(differentConfig, 2, identity)).toThrow(/config/i);
    const changed = structuredClone(partial);
    changed[1]!.scope.gradedTestFiles = [];
    expect(() => mergeShards(changed, 2, identity)).toThrow(/scope/i);
    const incomplete = structuredClone(partial);
    delete incomplete[1]!.gates.flake;
    expect(() => mergeShards(incomplete, 2, identity)).toThrow(/flake/i);
    const wrongBudget = structuredClone(partial);
    wrongBudget[1]!.gates.flake!.runs = 1;
    expect(() => mergeShards(wrongBudget, 2, identity)).toThrow(/runs/i);
    const missingModules = structuredClone(partial);
    missingModules[0]!.gates.mutation!.modules = [];
    expect(() => mergeShards(missingModules, 2, identity)).toThrow(/module/i);
  });

  it('propagates failed flake shards and retains global failure indices', async () => {
    const first = await runFireguard(harness({ index: 1, count: 2 }).deps);
    const second = await runFireguard(harness({ index: 2, count: 2 }, true).deps);
    const combined: FireguardReport = mergeShards([first, second], 2, identity);
    expect(combined.grade.letter).toBe('F');
    expect(combined.gates.flake).toMatchObject({ configuredRuns: 100, runs: 51, failures: 1 });
    expect(combined.gates.flake?.failedRuns).toEqual([{ run: 2, error: 'fixture failure' }]);
    expect(combined.gates.mutation).toBeUndefined();
  });

  it('keeps shard-local mutation failures provisional and reports merge tool errors as exit 2', async () => {
    await withTempDir(async (dir) => {
      initRepo(dir);
      await writeFile(join(dir, 'tracked'), 'base');
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'base');
      const base = git(dir, 'rev-parse', 'HEAD');
      const directory = join(dir, 'reports');
      await mkdir(directory);
      let output = '';
      const shardCode = await runCli({
        cwd: dir, argv: ['--shard', '1/2', '--json-out', join(directory, '1.json')],
        env: { FIREGUARD_BASE_REF: base }, stdout: (text) => { output += text; },
        runFireguardFn: async (deps) => runFireguard({ ...harness().deps, shard: deps.shard, config: deps.config }),
      });
      expect(shardCode).toBe(0);
      expect(output).toContain('final grade deferred');
      let error = '';
      const mergeCode = await runCli({
        cwd: dir, argv: ['--merge-shards', directory, '--shard-count', '2'],
        env: { FIREGUARD_BASE_REF: base }, stderr: (text) => { error += text; },
      });
      expect(mergeCode).toBe(2);
      expect(error).toContain('missing shard reports');
    });
  });
});
