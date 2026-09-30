import { describe, it, expect } from 'vitest';
import { runFireguard, type RunFireguardDeps } from '../src/runFireguard.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { DiffEntry } from '../src/types.js';

function testSource(name: string): string {
  return [
    "import { it, expect } from 'vitest';",
    `import { ${name} } from './${name}';`,
    `it('${name}', () => { expect(${name}(2)).toBe(4); });`,
  ].join('\n');
}

/** A tiny workspace: `barrel` re-exports `add`, `orphan` is imported by no test. */
const FILES: Record<string, string> = {
  'src/add.ts': 'export function add(n: number): number {\n  return n + 2;\n}\n',
  'src/twice.ts': 'export function twice(n: number): number {\n  return n * 2;\n}\n',
  'src/orphan.ts': 'export function half(n: number): number {\n  return n / 2;\n}\n',
  'src/barrel.ts': "export * from './add';\n",
  'src/add.test.ts': testSource('add'),
  'src/twice.test.ts': testSource('twice'),
  'src/barrel.test.ts': testSource('add').replace("'./add'", "'./barrel'"),
};

const ADD_TESTS = ['src/add.test.ts', 'src/barrel.test.ts'];
const ALL_TESTS = ['src/add.test.ts', 'src/barrel.test.ts', 'src/twice.test.ts'];

interface Call {
  file: string;
  relatedTests: string[];
}

function harness(changed: string[], overrides: Partial<RunFireguardDeps> = {}) {
  const calls: Call[] = [];
  const deps: RunFireguardDeps = {
    config: {
      ...DEFAULT_CONFIG,
      thresholds: { ...DEFAULT_CONFIG.thresholds, agenticFlakinessRuns: 1 },
    },
    getDiffEntries: async () => changed.map((path): DiffEntry => ({ status: 'M', path })),
    readFile: async (path) => FILES[path] ?? '',
    runOnce: async () => ({ ok: true }),
    applyAndTest: async (input) => {
      calls.push({ file: input.file, relatedTests: input.relatedTests });
      return { ok: false };
    },
    ...overrides,
  };
  return { deps, calls };
}

const WORKSPACE_PROBES = {
  fileExists: (path: string): boolean => Object.hasOwn(FILES, path),
  readFileSync: (path: string): string | null => FILES[path] ?? null,
};

const CHANGED = [...ALL_TESTS, 'src/add.ts', 'src/twice.ts'];

describe('runFireguard mutation scoping', () => {
  it('runs each changed module against only the graded tests that import it', async () => {
    const { deps, calls } = harness(CHANGED, WORKSPACE_PROBES);
    const report = await runFireguard(deps);
    expect(calls).toEqual([
      { file: 'src/add.ts', relatedTests: ADD_TESTS },
      { file: 'src/twice.ts', relatedTests: ['src/twice.test.ts'] },
    ]);
    expect(report.gates.mutation?.moduleTests).toEqual({ 'src/add.ts': 2, 'src/twice.ts': 1 });
    expect(report.gates.mutation?.pass).toBe(true);
    expect(report.grade.letter).not.toBe('F');
  });

  it('fails a changed module that no graded test imports', async () => {
    const { deps, calls } = harness([...CHANGED, 'src/orphan.ts'], WORKSPACE_PROBES);
    const report = await runFireguard(deps);
    expect(calls.map((call) => call.file)).toEqual(['src/add.ts', 'src/twice.ts']);
    expect(report.gates.mutation?.moduleTests?.['src/orphan.ts']).toBe(0);
    expect(report.gates.mutation?.survivors.map((s) => s.file)).toEqual(['src/orphan.ts']);
    expect(report.gates.mutation?.score).toBe(67);
    expect(report.grade.letter).toBe('F');
  });
});

describe('runFireguard without an import graph', () => {
  it('keeps running every graded test for every module', async () => {
    const { deps, calls } = harness(CHANGED);
    const report = await runFireguard(deps);
    expect(calls).toEqual([
      { file: 'src/add.ts', relatedTests: ALL_TESTS },
      { file: 'src/twice.ts', relatedTests: ALL_TESTS },
    ]);
    expect(report.gates.mutation?.moduleTests).toBeUndefined();
  });

  it('needs both file probes before it scopes anything', async () => {
    const existsOnly = harness(CHANGED, { fileExists: WORKSPACE_PROBES.fileExists });
    await runFireguard(existsOnly.deps);
    const readOnly = harness(CHANGED, { readFileSync: WORKSPACE_PROBES.readFileSync });
    await runFireguard(readOnly.deps);
    expect(existsOnly.calls.map((call) => call.relatedTests)).toEqual([ALL_TESTS, ALL_TESTS]);
    expect(readOnly.calls.map((call) => call.relatedTests)).toEqual([ALL_TESTS, ALL_TESTS]);
  });
});
