import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMutationGate, scoreMutations } from '../src/gates/mutationGate.js';
import { createMutationApplier } from '../src/processAdapters.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { RunOnceResult } from '../src/types.js';

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

/** Hand-written applier: records each call and either kills or spares every mutant. */
function recorder(kills: boolean) {
  const calls: Call[] = [];
  const applyAndTest = async (input: Call): Promise<RunOnceResult> => {
    calls.push({ file: input.file, relatedTests: input.relatedTests });
    return { ok: !kills };
  };
  return { calls, applyAndTest };
}

function callsFor(file: string, relatedTests: string[], count: number): Call[] {
  return Array.from({ length: count }, () => ({ file, relatedTests }));
}

const SCOPED: Record<string, string[]> = {
  'src/add.ts': ['src/add.test.ts'],
  'src/sign.ts': ['src/other.test.ts', 'src/sign.test.ts'],
};

describe('runMutationGate scoping', () => {
  it('runs each module against only the tests the lookup selects', async () => {
    const { calls, applyAndTest } = recorder(true);
    const gate = await runMutationGate({
      config: DEFAULT_CONFIG,
      modules: MODULES,
      relatedTests: ALL_TESTS,
      relatedTestsFor: (path) => SCOPED[path] ?? [],
      applyAndTest,
    });
    expect(calls).toEqual([
      ...callsFor('src/add.ts', ['src/add.test.ts'], 1),
      ...callsFor('src/sign.ts', ['src/other.test.ts', 'src/sign.test.ts'], 3),
    ]);
    expect(gate.moduleTests).toEqual({ 'src/add.ts': 1, 'src/sign.ts': 2 });
    expect(gate.modules).toEqual(['src/add.ts', 'src/sign.ts']);
    expect(gate.killed).toBe(4);
    expect(gate.total).toBe(4);
  });

  it('runs every module against relatedTests when no lookup is supplied', async () => {
    const { calls, applyAndTest } = recorder(true);
    const gate = await runMutationGate({
      config: DEFAULT_CONFIG,
      modules: MODULES,
      relatedTests: ALL_TESTS,
      applyAndTest,
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
    const { calls, applyAndTest } = recorder(true);
    const gate = await runMutationGate({
      config: DEFAULT_CONFIG,
      modules: MODULES,
      relatedTests: ALL_TESTS,
      relatedTestsFor: (path) => (path === 'src/add.ts' ? [] : ['src/sign.test.ts']),
      applyAndTest,
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

  it('fails the gate when scoped modules lose their tests', async () => {
    const { calls, applyAndTest } = recorder(true);
    const gate = await runMutationGate({
      config: DEFAULT_CONFIG,
      modules: MODULES,
      relatedTests: ALL_TESTS,
      relatedTestsFor: (path) => (path === 'src/add.ts' ? ['src/add.test.ts'] : []),
      applyAndTest,
    });
    expect(calls).toHaveLength(1);
    expect(gate.killed).toBe(1);
    expect(gate.survived).toBe(3);
    expect(gate.score).toBe(25);
    expect(gate.pass).toBe(false);
  });

  it('treats an empty relatedTests fallback the same way', async () => {
    const { calls, applyAndTest } = recorder(true);
    const gate = await runMutationGate({
      config: DEFAULT_CONFIG,
      modules: MODULES,
      relatedTests: [],
      applyAndTest,
    });
    expect(calls).toEqual([]);
    expect(gate.survived).toBe(4);
    expect(gate.killed).toBe(0);
    expect(gate.pass).toBe(false);
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
        runOnce: async (files) => {
          runs.push(files);
          seen.push(await readFile(join(dir, 'src/add.ts'), 'utf8'));
          return { ok: false };
        },
      });
      const gate = await runMutationGate({
        config: DEFAULT_CONFIG,
        modules: MODULES,
        relatedTests: ALL_TESTS,
        relatedTestsFor: (path) => (path === 'src/add.ts' ? ['src/add.test.ts'] : []),
        applyAndTest,
      });
      expect(runs).toEqual([['src/add.test.ts']]);
      expect(seen).toEqual([ADD.replace('a + b', 'a - b')]);
      expect(await readFile(join(dir, 'src/add.ts'), 'utf8')).toBe(ADD);
      expect(await readFile(join(dir, 'src/sign.ts'), 'utf8')).toBe(SIGN);
      expect([gate.killed, gate.survived]).toEqual([1, 3]);
    });
  });
});
