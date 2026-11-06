import { describe, it, expect } from 'vitest';
import { runFireguard, type RunFireguardDeps } from '../src/runFireguard.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type {
  ApplyAndTest,
  DiffEntry,
  Lanes,
  RunOnceResult,
  TestRunner,
  WorkspaceSource,
} from '../src/types.js';
import { deferred, fakeLanes, memorySource, settleMicrotasks, type Deferred } from './support.js';

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

const ALL_TESTS = ['src/add.test.ts', 'src/barrel.test.ts', 'src/twice.test.ts'];

interface Call {
  file: string;
  relatedTests: string[];
}

interface HarnessOptions {
  /** Decides a mutant run; kills every mutant by default. */
  apply?: ApplyAndTest;
  /** The lanes' flake runner; passes by default. */
  runOnce?: TestRunner;
  /** Where the lanes read sources; the in-memory workspace with import-graph probes by default. */
  source?: WorkspaceSource;
  deps?: Partial<RunFireguardDeps>;
}

function harness(changed: string[], options: HarnessOptions = {}) {
  const calls: Call[] = [];
  const lanes = { opened: 0, closed: 0 };
  const apply: ApplyAndTest = options.apply ?? (async () => ({ ok: false }));
  const deps: RunFireguardDeps = {
    config: {
      ...DEFAULT_CONFIG,
      thresholds: { ...DEFAULT_CONFIG.thresholds, agenticFlakinessRuns: 1 },
    },
    getDiffEntries: async () => changed.map((path): DiffEntry => ({ status: 'M', path })),
    readFile: async (path) => FILES[path] ?? '',
    openLanes: async (): Promise<Lanes> => {
      lanes.opened += 1;
      return fakeLanes(
        async (input) => {
          calls.push({ file: input.file, relatedTests: input.relatedTests });
          return apply(input);
        },
        {
          runOnce: options.runOnce,
          source: options.source ?? memorySource(FILES),
          close: async () => {
            lanes.closed += 1;
          },
        }
      );
    },
    ...options.deps,
  };
  return { deps, calls, lanes };
}

const CHANGED = [...ALL_TESTS, 'src/add.ts', 'src/twice.ts'];

describe('runFireguard mutation scoping', () => {
  it('runs each changed module against the nearest graded tests that import it first', async () => {
    const { deps, calls } = harness(CHANGED);
    const report = await runFireguard(deps);
    expect(calls).toEqual([
      { file: 'src/add.ts', relatedTests: ['src/add.test.ts'] },
      { file: 'src/twice.ts', relatedTests: ['src/twice.test.ts'] },
    ]);
    expect(report.gates.mutation?.moduleTests).toEqual({ 'src/add.ts': 2, 'src/twice.ts': 1 });
    expect(report.gates.mutation?.pass).toBe(true);
    expect(report.grade.letter).not.toBe('F');
  });

  it('runs the farther importers of a module only when the nearest ones miss the mutant', async () => {
    const { deps, calls } = harness(CHANGED, {
      apply: async (input) => ({ ok: !input.relatedTests.includes('src/barrel.test.ts') }),
    });
    const report = await runFireguard(deps);
    expect(calls).toEqual([
      { file: 'src/add.ts', relatedTests: ['src/add.test.ts'] },
      { file: 'src/add.ts', relatedTests: ['src/barrel.test.ts'] },
      { file: 'src/twice.ts', relatedTests: ['src/twice.test.ts'] },
    ]);
    expect([report.gates.mutation?.killed, report.gates.mutation?.survived]).toEqual([1, 1]);
  });

  it('fails a changed module that no graded test imports', async () => {
    const { deps, calls } = harness([...CHANGED, 'src/orphan.ts']);
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
    const { deps, calls } = harness(CHANGED, { source: { readFile: async (p) => FILES[p] ?? '' } });
    const report = await runFireguard(deps);
    expect(calls).toEqual([
      { file: 'src/add.ts', relatedTests: ALL_TESTS },
      { file: 'src/twice.ts', relatedTests: ALL_TESTS },
    ]);
    expect(report.gates.mutation?.moduleTests).toBeUndefined();
  });

  it('needs both file probes before it scopes anything', async () => {
    const { fileExists, readFileSync, readFile } = memorySource(FILES);
    const existsOnly = harness(CHANGED, { source: { readFile, fileExists } });
    await runFireguard(existsOnly.deps);
    const readOnly = harness(CHANGED, { source: { readFile, readFileSync } });
    await runFireguard(readOnly.deps);
    expect(existsOnly.calls.map((call) => call.relatedTests)).toEqual([ALL_TESTS, ALL_TESTS]);
    expect(readOnly.calls.map((call) => call.relatedTests)).toEqual([ALL_TESTS, ALL_TESTS]);
  });
});

describe('runFireguard changed lines', () => {
  it('runs only mutants on lines the diff changed and reports the rest', async () => {
    // add.ts has one mutant (line 2, `+`), twice.ts one (line 2, `*`); only add.ts line 2 changed.
    const changedLines = new Map([['src/add.ts', new Set([2])]]);
    const { deps, calls } = harness(CHANGED, {
      deps: { getChangedLines: async () => changedLines },
    });
    const report = await runFireguard(deps);
    expect(calls.map((call) => call.file)).toEqual(['src/add.ts']);
    expect(report.gates.mutation?.total).toBe(1);
    expect(report.gates.mutation?.unchangedLineMutants).toBe(1);
  });

  it('asks for the changed lines of the changed modules', async () => {
    const asked: string[][] = [];
    const { deps } = harness(CHANGED, {
      deps: {
        getChangedLines: async (modules) => {
          asked.push(modules);
          return new Map();
        },
      },
    });
    const report = await runFireguard(deps);
    expect(asked).toEqual([['src/add.ts', 'src/twice.ts']]);
    expect([report.gates.mutation?.total, report.gates.mutation?.score]).toEqual([0, 100]);
  });

  it('runs every mutant without changed lines', async () => {
    const { deps } = harness(CHANGED);
    const report = await runFireguard(deps);
    expect(report.gates.mutation?.total).toBe(2);
    expect(report.gates.mutation?.unchangedLineMutants).toBeUndefined();
  });
});

describe('runFireguard lanes', () => {
  it('opens the lanes once for both gates, reports how they ran, and closes them', async () => {
    const { deps, lanes } = harness(CHANGED);
    const report = await runFireguard(deps);
    expect(lanes).toEqual({ opened: 1, closed: 1 });
    expect(report.gates.flake?.pass).toBe(true);
    expect(report.gates.mutation?.killed).toBe(2);
    expect(report.execution).toEqual({ lanes: 1, workspace: 'committed', runner: 'warm' });
  });

  it('runs no mutant when the flake gate fails, and still closes the lanes', async () => {
    const { deps, calls, lanes } = harness(CHANGED, {
      runOnce: async () => ({ ok: false, error: 'x' }),
    });
    const report = await runFireguard(deps);
    expect(report.gates.flake?.pass).toBe(false);
    expect(report.gates.mutation).toBeUndefined();
    expect(calls).toEqual([]);
    expect(lanes.closed).toBe(1);
    expect(report.grade.letter).toBe('F');
  });

  it('runs the flake gate without mutation when only tests changed', async () => {
    const { deps, calls } = harness(ALL_TESTS);
    const report = await runFireguard(deps);
    expect(report.gates.flake?.pass).toBe(true);
    expect(report.gates.mutation).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('starts no mutant until every flake run is done, even with free lanes', async () => {
    const held: Array<Deferred<RunOnceResult>> = [];
    const runOnce: TestRunner = () => {
      const run = deferred<RunOnceResult>();
      held.push(run);
      return run.promise;
    };
    const calls: string[] = [];
    const apply: ApplyAndTest = async (input) => {
      calls.push(input.file);
      return { ok: false };
    };
    const lanes: Lanes = {
      runners: [runOnce, runOnce],
      appliers: [apply, apply],
      execution: { lanes: 2, workspace: 'committed', runner: 'warm' },
      source: memorySource(FILES),
      close: async () => {},
    };
    const runs = { ...DEFAULT_CONFIG.thresholds, agenticFlakinessRuns: 3 };
    const { deps } = harness(CHANGED, {
      deps: { config: { ...DEFAULT_CONFIG, thresholds: runs }, openLanes: async () => lanes },
    });
    const report = runFireguard(deps);
    for (let i = 0; i < 5; i += 1) await settleMicrotasks();
    held[0]!.resolve({ ok: true });
    held[1]!.resolve({ ok: true });
    for (let i = 0; i < 5; i += 1) await settleMicrotasks();
    // One lane is free, but the third flake run is still under way.
    expect([held.length, calls.length]).toEqual([3, 0]);
    held[2]!.resolve({ ok: true });
    const done = await report;
    expect(calls).toEqual(['src/add.ts', 'src/twice.ts']);
    expect([done.gates.flake?.runs, done.gates.mutation?.killed]).toEqual([3, 2]);
  });

  it('closes the lanes when a mutant run throws', async () => {
    const { deps, lanes } = harness(CHANGED, {
      apply: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    await expect(runFireguard(deps)).rejects.toThrow('EACCES');
    expect(lanes.closed).toBe(1);
  });
});
