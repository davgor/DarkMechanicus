import { describe, it, expect, vi } from 'vitest';
import { runFireguard } from '../src/runFireguard.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { fakeLanes } from './support.js';

const killAll = async () => fakeLanes(async () => ({ ok: false }));
const revision = { base: 'base-commit', head: 'head-commit' };


describe('runFireguard', () => {
  it('fails closed with F when modules change without graded test updates', async () => {
    const report = await runFireguard({
      config: DEFAULT_CONFIG,
      revision,
      getDiffEntries: async () => [{ status: 'M', path: 'src/data/jobs.ts' }],
      readFile: async () => '',
      openLanes: killAll,
    });
    expect(report.skipped).toBe(false);
    expect(report.revision).toEqual(revision);
    expect(report.grade.letter).toBe('F');
    expect(report.grade.reasons.join(' ')).toMatch(/without graded unit test/i);
    expect(report.gates.mutation).toBeUndefined();
  });

  it('grades modified unit tests (not only newly added files)', async () => {
    const solidTest = `
import { describe, it, expect } from 'vitest';
import { add } from './add';
describe('add', () => {
  it('works', () => { expect(add(1, 2)).toBe(3); });
});
`;
    const report = await runFireguard({
      config: {
        ...DEFAULT_CONFIG,
        thresholds: { ...DEFAULT_CONFIG.thresholds, agenticFlakinessRuns: 2 },
      },
      revision,
      getDiffEntries: async () => [
        { status: 'M', path: 'src/add.test.ts' },
        { status: 'M', path: 'src/add.ts' },
      ],
      readFile: async (path) =>
        path.endsWith('.test.ts')
          ? solidTest
          : 'export function add(a:number,b:number){return a+b;}',
      openLanes: killAll,
    });
    expect(report.skipped).toBe(false);
    expect(report.revision).toEqual(revision);
    expect(report.scope.gradedTestFiles).toEqual(['src/add.test.ts']);
    expect(report.gates.ast?.pass).toBe(true);
    expect(report.grade.letter).not.toBe('F');
  });

  it('fail-fasts on AST before flake/mutation', async () => {
    const openLanes = vi.fn(killAll);
    const slop = `
import { it, expect, vi } from 'vitest';
const fn = vi.fn(() => 1);
it('slop', () => { expect(fn()).toBe(1); });
it('empty', () => { fn(); });
`;
    const report = await runFireguard({
      config: DEFAULT_CONFIG,
      revision,
      getDiffEntries: async () => [
        { status: 'A', path: 'src/slop.test.ts' },
        { status: 'A', path: 'src/slop.ts' },
      ],
      readFile: async (path) => (path.endsWith('.test.ts') ? slop : 'export const x = 1;'),
      openLanes,
    });
    expect(report.grade.letter).toBe('F');
    expect(report.revision).toEqual(revision);
    expect(report.gates.ast?.pass).toBe(false);
    expect(report.gates.flake).toBeUndefined();
    expect(openLanes).not.toHaveBeenCalled();
  });

  it('grades Gate 1 alone with astOnly and never opens lanes', async () => {
    const openLanes = vi.fn(killAll);
    const solid = `
import { it, expect } from 'vitest';
import { add } from './add';
it('works', () => { expect(add(1, 2)).toBe(3); });
`;
    const empty = `${solid}it('empty', () => { add(1, 2); });\n`;
    const grade = (source: string) =>
      runFireguard({
        config: DEFAULT_CONFIG,
        revision,
        astOnly: true,
        getDiffEntries: async () => [
          { status: 'A', path: 'src/add.test.ts' },
          { status: 'A', path: 'src/add.ts' },
        ],
        readFile: async (path) => (path.endsWith('.test.ts') ? source : 'export const add = (a: number, b: number) => a + b;'),
        openLanes,
      });
    const passing = await grade(solid);
    expect(passing.gates.ast?.pass).toBe(true);
    expect(passing.gates.flake).toBeUndefined();
    expect(passing.gates.mutation).toBeUndefined();
    expect(passing.grade.letter).not.toBe('F');
    const failing = await grade(empty);
    expect(failing.gates.ast?.emptyTests).toEqual([{ file: 'src/add.test.ts', line: 5, name: 'empty' }]);
    expect(failing.grade.letter).toBe('F');
    expect(openLanes).not.toHaveBeenCalled();
  });

  it('runs flake then mutation and returns a passing grade for solid work', async () => {
    const solidTest = `
import { describe, it, expect } from 'vitest';
import { add } from './add';
describe('add', () => {
  it('works', () => { expect(add(1, 2)).toBe(3); });
});
`;
    const solidMod = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
    const report = await runFireguard({
      config: {
        ...DEFAULT_CONFIG,
        thresholds: { ...DEFAULT_CONFIG.thresholds, agenticFlakinessRuns: 3 },
      },
      revision,
      getDiffEntries: async () => [
        { status: 'A', path: 'src/add.test.ts' },
        { status: 'A', path: 'src/add.ts' },
      ],
      readFile: async (path) => (path.endsWith('.test.ts') ? solidTest : solidMod),
      openLanes: killAll,
    });
    expect(report.gates.ast?.pass).toBe(true);
    expect(report.revision).toEqual(revision);
    expect(report.gates.flake?.pass).toBe(true);
    expect(report.gates.mutation?.pass).toBe(true);
    expect(report.grade.letter).not.toBe('F');
  });

  it('identifies a skipped run with no changed tests or modules', async () => {
    const report = await runFireguard({
      config: DEFAULT_CONFIG,
      revision,
      getDiffEntries: async () => [],
      readFile: async () => '',
      openLanes: killAll,
    });
    expect(report).toMatchObject({ revision, skipped: true, grade: { letter: 'A' } });
  });
});
