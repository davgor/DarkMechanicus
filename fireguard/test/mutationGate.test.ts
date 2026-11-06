import { describe, it, expect } from 'vitest';
import {
  generateMutants,
  runMutationGate,
  scoreMutations,
  touchesLines,
} from '../src/gates/mutationGate.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const source = `
export function clamp(n: number, min: number, max: number): number {
  if (n < min) {
    return min;
  }
  if (n > max) {
    return max;
  }
  return n + 0;
}
`;

describe('generateMutants', () => {
  it('produces conditional, operator, and return mutants', () => {
    const mutants = generateMutants('src/clamp.ts', source);
    expect(mutants.length).toBeGreaterThan(0);
    const kinds = new Set(mutants.map((m) => m.kind));
    expect(kinds.has('conditional-inversion') || kinds.has('operator-swap')).toBe(true);
    expect(mutants.every((m) => m.mutatedSource !== source)).toBe(true);
    expect(mutants.every((m) => m.file === 'src/clamp.ts')).toBe(true);
  });
});

describe('scoreMutations', () => {
  it('computes kill rate and pass against threshold', () => {
    const result = scoreMutations({
      killed: 3,
      survived: 1,
      minScore: 75,
      survivors: [{ file: 'a.ts', line: 1, description: 'x' }],
      modules: ['a.ts'],
    });
    expect(result.score).toBe(75);
    expect(result.pass).toBe(true);
  });

  it('fails below threshold and treats zero mutants as pass with 100', () => {
    expect(
      scoreMutations({
        killed: 1,
        survived: 1,
        minScore: 75,
        survivors: [],
        modules: ['a.ts'],
      }).pass
    ).toBe(false);
    const empty = scoreMutations({
      killed: 0,
      survived: 0,
      minScore: 75,
      survivors: [],
      modules: [],
    });
    expect(empty.pass).toBe(true);
    expect(empty.score).toBe(100);
  });
});

describe('runMutationGate', () => {
  it('kills mutants when the runner reports test failure', async () => {
    const gate = await runMutationGate({
      config: DEFAULT_CONFIG,
      modules: [{ path: 'src/clamp.ts', source }],
      relatedTests: ['src/clamp.test.ts'],
      appliers: [
        async ({ mutatedSource }) => {
          // "tests" fail (kill) when mutation removes the < check
          const killed = !mutatedSource.includes('n < min');
          return { ok: !killed, error: killed ? 'expected fail' : undefined };
        },
      ],
    });
    expect(gate.total).toBeGreaterThan(0);
    expect(gate.killed + gate.survived).toBe(gate.total);
  });
});

const MULTI_LINE = [
  'export function inRange(n: number): boolean {',
  '  if (',
  '    n > 0 &&',
  '    n < 10',
  '  ) {',
  '    return true;',
  '  }',
  '  return false;',
  '}',
  '',
].join('\n');

describe('generateMutants lines', () => {
  it('spans a mutant over every line of the code it replaces', () => {
    const lines = generateMutants('src/r.ts', MULTI_LINE).map((m) => [m.description, m.line, m.endLine]);
    expect(lines).toEqual([
      ['invert if condition', 3, 4],
      ['swap operator to <', 3, 3],
      ['swap operator to >', 4, 4],
      ['invert boolean return to false', 6, 6],
      ['invert boolean return to true', 8, 8],
    ]);
  });

  it('touches a line set when any replaced line is in it', () => {
    const [ifMutant] = generateMutants('src/r.ts', MULTI_LINE);
    expect(touchesLines(ifMutant!, new Set([4]))).toBe(true);
    expect(touchesLines(ifMutant!, new Set([2, 5]))).toBe(false);
  });
});

describe('runMutationGate changed lines', () => {
  it('runs only mutants that touch a changed line and counts the rest', async () => {
    const applied: string[] = [];
    const gate = await runMutationGate({
      config: DEFAULT_CONFIG,
      modules: [
        { path: 'src/r.ts', source: MULTI_LINE },
        { path: 'src/clamp.ts', source },
      ],
      relatedTests: ['src/r.test.ts'],
      changedLines: new Map([['src/r.ts', new Set([4, 8])]]),
      appliers: [
        async ({ mutatedSource }) => {
          applied.push(mutatedSource);
          return { ok: false };
        },
      ],
    });
    // The if (lines 3-4), `<` -> `>` (line 4) and `return false` (line 8); clamp.ts has no changed line.
    expect(applied).toHaveLength(3);
    expect([gate.total, gate.killed, gate.score]).toEqual([3, 3, 100]);
    expect(gate.unchangedLineMutants).toBe(2 + generateMutants('src/clamp.ts', source).length);
  });
});
