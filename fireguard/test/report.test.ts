import { describe, it, expect } from 'vitest';
import { formatHumanReport, formatJsonReport } from '../src/report.js';
import type { FireguardReport } from '../src/types.js';

const failingReport: FireguardReport = {
  grade: { letter: 'F', score: 0, reasons: ['ast gate failed'] },
  gates: {
    ast: {
      name: 'ast',
      pass: false,
      assertionCount: 1,
      mockCount: 4,
      mockToAssertRatio: 4,
      tautologicalCount: 1,
      tautologicalRatio: 1,
      emptyTests: [],
      findings: [
        {
          file: 'src/x.test.ts',
          line: 12,
          rule: 'mock-ratio',
          message: 'mock/assert ratio 4 > 1.5',
        },
      ],
    },
  },
  scope: {
    baseRef: 'main',
    gradedTestFiles: ['src/x.test.ts'],
    changedModules: ['src/x.ts'],
  },
  skipped: false,
};

describe('report', () => {
  it('formats a human report that surfaces the letter grade', () => {
    const text = formatHumanReport(failingReport);
    expect(text).toContain('FIREGUARD GRADE: F');
    expect(text).toContain('score 0');
    expect(text).toContain('src/x.test.ts:12');
    expect(text).toContain('mock-ratio');
  });

  it('formats JSON with grade and gates', () => {
    const json = JSON.parse(formatJsonReport(failingReport)) as FireguardReport;
    expect(json.grade.letter).toBe('F');
    expect(json.gates.ast?.pass).toBe(false);
  });
});

function mutationReport(moduleTests?: Record<string, number>): FireguardReport {
  return {
    grade: { letter: 'F', score: 0, reasons: ['mutation gate failed'] },
    gates: {
      mutation: {
        name: 'mutation',
        pass: false,
        killed: 2,
        survived: 1,
        total: 3,
        score: 67,
        survivors: [
          { file: 'src/orphan.ts', line: 2, description: 'operator-swap: swap operator to *' },
        ],
        modules: ['src/add.ts', 'src/orphan.ts'],
        moduleTests,
      },
    },
    scope: {
      baseRef: 'main',
      gradedTestFiles: ['src/add.test.ts'],
      changedModules: ['src/add.ts', 'src/orphan.ts'],
    },
    skipped: false,
  };
}

describe('report mutation scoping', () => {
  it('lists how many graded tests each module ran against', () => {
    const text = formatHumanReport(mutationReport({ 'src/add.ts': 3, 'src/orphan.ts': 0 }));
    expect(text).toContain(
      '  tests per module: src/add.ts=3, src/orphan.ts=0 (no graded test imports it)'
    );
    expect(text).toContain('  score=67% killed=2 survived=1 total=3');
    expect(text).toContain('  - survivor src/orphan.ts:2 operator-swap: swap operator to *');
  });

  it('leaves the per-module line out when mutants were not scoped', () => {
    expect(formatHumanReport(mutationReport())).not.toContain('tests per module');
    expect(formatHumanReport(mutationReport({}))).not.toContain('tests per module');
  });

  it('keeps moduleTests in the JSON report', () => {
    const report = mutationReport({ 'src/add.ts': 1 });
    const json = JSON.parse(formatJsonReport(report)) as FireguardReport;
    expect(json.gates.mutation?.moduleTests).toEqual({ 'src/add.ts': 1 });
  });
});
