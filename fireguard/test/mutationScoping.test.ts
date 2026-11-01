import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMutationGate, scoreMutations } from '../src/gates/mutationGate.js';
import type { RelatedTests } from '../src/importGraph.js';
import { createMutationApplier } from '../src/processAdapters.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { ApplyAndTest, RunOnceResult } from '../src/types.js';
import { deferred, settleMicrotasks } from './support.js';

/** One mutant: `+` -> `-`. */
const ADD = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
/** Three mutants: `<` -> `>`, inverted `if`, and `return 1` -> `return 2`. */
const SIGN = [
  'export function sign(n: number): number {',
  '  if (n < 0) {',
  '    return -1;',
  '  }',
  '  return 1;',
  '}',
  '',
].join('\n');

const MODULES = [
  { path: 'src/add.ts', source: ADD },
  { path: 'src/sign.ts', source: SIGN },
];
const ALL_TESTS = ['src/add.test.ts', 'src/sign.test.ts', 'src/other.test.ts'];

interface Call {
  file: string;
  relatedTests: string[];
}

/** Hand-written applier: records each call; `kills` decides from the tests a call ran. */
function recorder(kills: (relatedTests: string[]) => boolean) {
  const calls: Call[] = [];
  const applyAndTest: ApplyAndTest = async (input) => {
    calls.push({ file: input.file, relatedTests: input.relatedTests });
    return { ok: !kills(input.relatedTests) };
  };
  return { calls, applyAndTest };
}

const always = (): boolean => true;

function callsFor(file: string, relatedTests: string[], count: number): Call[] {
  return Array.from({ length: count }, () => ({ file, relatedTests }));
}

const SCOPED: Record<string, RelatedTests> = {
  'src/add.ts': { nearest: ['src/add.test.ts'], farther: [] },
  'src/sign.ts': { nearest: ['src/sign.test.ts'], farther: ['src/other.test.ts'] },
};
const NONE: RelatedTests = { nearest: [], farther: [] };

describe('runMutationGate scoping', () => {
  it('stops at the nearest tests when they kill the mutant', async () => {
    const { calls, applyAndTest } = recorder(always);
    const gate = await runMutationGate({
      config: DEFAULT_CONFIG,
      modules: MODULES,
      relatedTests: ALL_TESTS,
      relatedTestsFor: (path) => SCOPED[path] ?? NONE,
      appliers: [applyAndTest],
    });
    expect(calls).toEqual([
      ...callsFor('src/add.ts', ['src/add.test.ts'], 1),
      ...callsFor('src/sign.ts', ['src/sign.test.ts'], 3),
    ]);
    expect(gate.moduleTests).toEqual({ 'src/add.ts': 1, 'src/sign.ts': 2 });
    expect(gate.modules).toEqual(['src/add.ts', 'src/sign.ts']);
    expect(gate.killed).toBe(4);
    expect(gate.total).toBe(4);
  });

  it('runs the farther tests only for mutants the nearest tests leave alive', async () => {
    const { calls, applyAndTest } = recorder((tests) => tests.includes('src/other.test.ts'));
    const gate = await runMutationGate({
      config: DEFAULT_CONFIG,
      modules: MODULES,
      relatedTests: ALL_TESTS,
      relatedTestsFor: (path) => SCOPED[path] ?? NONE,
      appliers: [applyAndTest],
    });
    const signPair = [
      { file: 'src/sign.ts', relatedTests: ['src/sign.test.ts'] },
      { file: 'src/sign.ts', relatedTests: ['src/other.test.ts'] },
    ];
    expect(calls).toEqual([
      { file: 'src/add.ts', relatedTests: ['src/add.test.ts'] },
      ...signPair,
      ...signPair,
      ...signPair,
    ]);
    expect([gate.killed, gate.survived]).toEqual([3, 1]);
    expect(gate.survivors.map((survivor) => survivor.file)).toEqual(['src/add.ts']);
  });

  it('runs every module against relatedTests when no lookup is supplied', async () => {
    const { calls, applyAndTest } = recorder(always);
    const gate = await runMutationGate({
      config: DEFAULT_CONFIG,
      modules: MODULES,
      relatedTests: ALL_TESTS,
      appliers: [applyAndTest],
    });
    expect(calls).toEqual([
      ...callsFor('src/add.ts', ALL_TESTS, 1),
      ...callsFor('src/sign.ts', ALL_TESTS, 3),
    ]);
    expect(gate.moduleTests).toBeUndefined();
    expect(gate.killed).toBe(4);
  });
});

describe('runMutationGate without related tests', () => {
  it('counts mutants of an unreached module as survived and never applies them', async () => {
    const { calls, applyAndTest } = recorder(always);
    const gate = await runMutationGate({
      config: DEFAULT_CONFIG,
      modules: MODULES,
      relatedTests: ALL_TESTS,
      relatedTestsFor: (path) =>
        path === 'src/add.ts' ? NONE : { nearest: ['src/sign.test.ts'], farther: [] },
      appliers: [applyAndTest],
    });
    expect(calls).toEqual(callsFor('src/sign.ts', ['src/sign.test.ts'], 3));
    expect(gate.killed).toBe(3);
    expect(gate.survived).toBe(1);
    expect(gate.survivors).toEqual([
      { file: 'src/add.ts', line: 2, description: 'operator-swap: swap operator to -' },
    ]);
    expect(gate.moduleTests).toEqual({ 'src/add.ts': 0, 'src/sign.ts': 1 });
    expect(gate.score).toBe(75);
    expect(gate.pass).toBe(true);
  });

  it('runs a module reached only by farther tests against those tests', async () => {
    const { calls, applyAndTest } = recorder(always);
    const gate = await runMutationGate({
      config: DEFAULT_CONFIG,
      modules: [MODULES[0]!],
      relatedTests: ALL_TESTS,
      relatedTestsFor: () => ({ nearest: [], farther: ['src/other.test.ts'] }),
      appliers: [applyAndTest],
    });
    expect(calls).toEqual(callsFor('src/add.ts', ['src/other.test.ts'], 1));
    expect(gate.moduleTests).toEqual({ 'src/add.ts': 1 });
    expect(gate.killed).toBe(1);
  });

  it('fails the gate when scoped modules lose their tests', async () => {
    const { calls, applyAndTest } = recorder(always);
    const gate = await runMutationGate({
      config: DEFAULT_CONFIG,
      modules: MODULES,
      relatedTests: ALL_TESTS,
      relatedTestsFor: (path) =>
        path === 'src/add.ts' ? { nearest: ['src/add.test.ts'], farther: [] } : NONE,
      appliers: [applyAndTest],
    });
    expect(calls).toHaveLength(1);
    expect(gate.killed).toBe(1);
    expect(gate.survived).toBe(3);
    expect(gate.score).toBe(25);
    expect(gate.pass).toBe(false);
  });

  it('treats an empty relatedTests fallback the same way', async () => {
    const { calls, applyAndTest } = recorder(always);
    const gate = await runMutationGate({
      config: DEFAULT_CONFIG,
      modules: MODULES,
      relatedTests: [],
      appliers: [applyAndTest],
    });
    expect(calls).toEqual([]);
    expect(gate.survived).toBe(4);
    expect(gate.killed).toBe(0);
    expect(gate.pass).toBe(false);
  });
});

describe('runMutationGate lanes', () => {
  it('runs one mutant per lane at a time and keeps each verdict with its mutant', async () => {
    const busy = new Set<string>();
    const enter = (lane: string): void => {
      if (busy.has(lane)) throw new Error(`${lane} ran two mutants at once`);
      busy.add(lane);
    };
    // The slow lane spares the first mutant and holds it until the fast lane has finished the
    // other three: it spares the first of those and kills the last two.
    const release = deferred();
    let fastCalls = 0;
    const slow: ApplyAndTest = async () => {
      enter('slow');
      await release.promise;
      busy.delete('slow');
      return { ok: true };
    };
    const fast: ApplyAndTest = async () => {
      enter('fast');
      await Promise.resolve();
      busy.delete('fast');
      fastCalls += 1;
      if (fastCalls === 3) release.resolve();
      return { ok: fastCalls === 1 };
    };
    const gate = await runMutationGate({
      config: DEFAULT_CONFIG,
      modules: MODULES,
      relatedTests: ALL_TESTS,
      appliers: [slow, fast],
    });
    expect(fastCalls).toBe(3);
    expect([gate.killed, gate.survived]).toEqual([2, 2]);
    expect(gate.survivors).toEqual([
      { file: 'src/add.ts', line: 2, description: 'operator-swap: swap operator to -' },
      { file: 'src/sign.ts', line: 2, description: 'conditional-inversion: invert if condition' },
    ]);
  });

  it('stops handing out mutants once a lane throws and rejects after in-flight ones finish', async () => {
    let calls = 0;
    const release = deferred();
    const broken: ApplyAndTest = async () => {
      calls += 1;
      throw new Error('disk full');
    };
    const held: ApplyAndTest = async () => {
      calls += 1;
      await release.promise;
      return { ok: false };
    };
    let settled = false;
    const outcome = runMutationGate({
      config: DEFAULT_CONFIG,
      modules: MODULES,
      relatedTests: ALL_TESTS,
      appliers: [broken, held],
    }).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    void outcome.finally(() => {
      settled = true;
    });
    await settleMicrotasks();
    expect(settled).toBe(false);
    release.resolve();
    expect(await outcome).toBe('disk full');
    expect(calls).toBe(2);
  });
});

describe('scoreMutations per-module counts', () => {
  const totals = { killed: 1, survived: 0, minScore: 75, survivors: [], modules: ['src/a.ts'] };

  it('carries moduleTests through when supplied', () => {
    const result = scoreMutations({ ...totals, moduleTests: { 'src/a.ts': 2 } });
    expect(result.moduleTests).toEqual({ 'src/a.ts': 2 });
  });

  it('omits the key entirely when not supplied', () => {
    expect('moduleTests' in scoreMutations(totals)).toBe(false);
    expect('moduleTests' in scoreMutations({ ...totals, moduleTests: {} })).toBe(true);
  });
});

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'fireguard-scoping-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('runMutationGate with the workspace applier', () => {
  it('runs only related tests, never touches unreached modules, and restores sources', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, 'src'));
      await writeFile(join(dir, 'src/add.ts'), ADD, 'utf8');
      await writeFile(join(dir, 'src/sign.ts'), SIGN, 'utf8');
      const runs: string[][] = [];
      const seen: string[] = [];
      const applyAndTest = createMutationApplier({
        cwd: dir,
        runOnce: async (files): Promise<RunOnceResult> => {
          runs.push(files);
          seen.push(await readFile(join(dir, 'src/add.ts'), 'utf8'));
          return { ok: false };
        },
      });
      const gate = await runMutationGate({
        config: DEFAULT_CONFIG,
        modules: MODULES,
        relatedTests: ALL_TESTS,
        relatedTestsFor: (path) =>
          path === 'src/add.ts' ? { nearest: ['src/add.test.ts'], farther: [] } : NONE,
        appliers: [applyAndTest],
      });
      expect(runs).toEqual([['src/add.test.ts']]);
      expect(seen).toEqual([ADD.replace('a + b', 'a - b')]);
      expect(await readFile(join(dir, 'src/add.ts'), 'utf8')).toBe(ADD);
      expect(await readFile(join(dir, 'src/sign.ts'), 'utf8')).toBe(SIGN);
      expect([gate.killed, gate.survived]).toEqual([1, 3]);
    });
  });
});
