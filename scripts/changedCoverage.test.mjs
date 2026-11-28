import { describe, expect, it } from 'vitest'
import { formatReport, parseArgs, selectChangedFiles, summarizeCoverage } from './changedCoverage.mjs'

const ROOT = '/repo'
const THRESHOLDS = { lines: 97, branches: 95, functions: 96, statements: 97 }
const GLOBS = {
  include: ['src/**/*.{ts,tsx}'],
  exclude: ['**/*.test.ts', '**/*.test.tsx', '**/__mocks__/**', 'out/**', 'src/test/**'],
  tests: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs']
}

/** A branch's `git diff --name-only` against its merge base, plus an untracked file. */
const FIXTURE_DIFF = [
  'src/core/plan/rows.ts',
  'src/renderer/src/home/Board.tsx',
  'src/core/plan/rows.test.ts',
  'src/test/hermeticEnv.ts',
  'src/main/__mocks__/electron.ts',
  'scripts/changedCoverage.mjs',
  'scripts/changedCoverage.test.mjs',
  'docs/project-guide.md',
  'src/core/plan/rows.ts'
]

const metric = (covered, total) => ({ total, covered, skipped: 0, pct: total === 0 ? 100 : (covered / total) * 100 })
const entry = (statements, branches, functions, lines) => ({
  statements: metric(...statements), branches: metric(...branches), functions: metric(...functions), lines: metric(...lines)
})

/** An istanbul json-summary with absolute keys, a total, and an unchanged file the run also loaded. */
const FIXTURE_SUMMARY = {
  total: entry([0, 0], [0, 0], [0, 0], [0, 0]),
  '/repo/src/core/plan/rows.ts': entry([100, 100], [38, 40], [10, 10], [100, 100]),
  '/repo/src/renderer/src/home/Board.tsx': entry([50, 50], [20, 20], [5, 5], [50, 50]),
  '/repo/src/core/unchanged.ts': entry([0, 10], [0, 10], [0, 1], [0, 10])
}

describe('parseArgs', () => {
  it('reads --base and --json-out, defaulting the base to main', () => {
    expect(parseArgs([])).toEqual({ base: 'main', jsonOut: undefined })
    expect(parseArgs(['--base', 'origin/sprint/x', '--json-out', 'cov.json'])).toEqual({ base: 'origin/sprint/x', jsonOut: 'cov.json' })
  })

  it('refuses a flag without a value and an unknown argument', () => {
    expect(() => parseArgs(['--base'])).toThrow('--base requires a value')
    expect(() => parseArgs(['--base', '--json-out', 'x'])).toThrow('--base requires a value')
    expect(() => parseArgs(['--all'])).toThrow('Unknown argument: --all')
  })
})

describe('selectChangedFiles', () => {
  it('measures changed sources under coverage include minus exclude, and runs changed tests too', () => {
    expect(selectChangedFiles(FIXTURE_DIFF, GLOBS)).toEqual({
      sources: ['src/core/plan/rows.ts', 'src/renderer/src/home/Board.tsx'],
      tests: ['scripts/changedCoverage.test.mjs', 'src/core/plan/rows.test.ts']
    })
  })

  it('selects nothing for a diff outside coverage and tests', () => {
    expect(selectChangedFiles(['README.md', 'skills/worker.md'], GLOBS)).toEqual({ sources: [], tests: [] })
  })
})

describe('summarizeCoverage', () => {
  const result = summarizeCoverage(FIXTURE_SUMMARY, ['src/core/plan/rows.ts', 'src/renderer/src/home/Board.tsx'], THRESHOLDS, ROOT)

  it('reports per-file metrics and flags each metric below its threshold', () => {
    expect(result.files[0]).toEqual({
      path: 'src/core/plan/rows.ts',
      tested: true,
      metrics: {
        statements: { total: 100, covered: 100, pct: 100 },
        branches: { total: 40, covered: 38, pct: 95 },
        functions: { total: 10, covered: 10, pct: 100 },
        lines: { total: 100, covered: 100, pct: 100 }
      },
      below: []
    })
    expect(result.files[1].below).toEqual([])
  })

  it('aggregates covered/total over only the changed files and flags the aggregate', () => {
    expect(result.aggregate).toEqual({
      metrics: {
        statements: { total: 150, covered: 150, pct: 100 },
        branches: { total: 60, covered: 58, pct: 96.67 },
        functions: { total: 15, covered: 15, pct: 100 },
        lines: { total: 150, covered: 150, pct: 100 }
      },
      below: []
    })
    expect(result.pass).toBe(true)
  })

  it('flags a file one branch under the threshold, and the aggregate it pulls under', () => {
    const summary = { '/repo/src/a.ts': entry([10, 10], [18, 20], [2, 2], [10, 10]) }
    const flagged = summarizeCoverage(summary, ['src/a.ts'], THRESHOLDS, ROOT)
    expect(flagged.files[0].below).toEqual(['branches'])
    expect(flagged.aggregate.below).toEqual(['branches'])
    expect(flagged.pass).toBe(false)
  })

  it('counts a changed source no related test loaded as uncovered and flags every metric', () => {
    const untested = summarizeCoverage(FIXTURE_SUMMARY, ['src/core/plan/rows.ts', 'src/core/orphan.ts'], THRESHOLDS, ROOT)
    expect(untested.files[1]).toMatchObject({ path: 'src/core/orphan.ts', tested: false, below: ['statements', 'branches', 'functions', 'lines'] })
    expect(untested.aggregate.metrics.functions).toEqual({ total: 11, covered: 10, pct: 90.91 })
    expect(untested.pass).toBe(false)
  })

  it('treats a metric with nothing to cover as 100%', () => {
    const summary = { '/repo/src/types.ts': entry([0, 0], [0, 0], [0, 0], [0, 0]) }
    expect(summarizeCoverage(summary, ['src/types.ts'], THRESHOLDS, ROOT)).toMatchObject({ pass: true, aggregate: { below: [] } })
  })

  it('passes with no changed sources', () => {
    expect(summarizeCoverage({}, [], THRESHOLDS, ROOT)).toMatchObject({ files: [], pass: true, aggregate: { below: [] } })
  })
})

describe('formatReport', () => {
  it('prints each file and the aggregate, marking metrics below threshold', () => {
    const summary = { '/repo/src/a.ts': entry([10, 10], [18, 20], [2, 2], [10, 10]) }
    const text = formatReport(summarizeCoverage(summary, ['src/a.ts', 'src/b.ts'], THRESHOLDS, ROOT))
    expect(text).toContain('thresholds: statements 97%, branches 95%, functions 96%, lines 97%')
    expect(text).toContain('BELOW src/a.ts\n  statements 100.00% (10/10)  branches 90.00%* (18/20)  functions 100.00% (2/2)  lines 100.00% (10/10)')
    expect(text).toContain('BELOW src/b.ts (no related test loaded it)')
    expect(text).toContain('BELOW all 2 changed source files\n  statements 90.91%* (10/11)')
    expect(text).toMatch(/FAIL: changed-file coverage is below the thresholds/)
  })

  it('says so when no changed source is under coverage', () => {
    expect(formatReport(summarizeCoverage({}, [], THRESHOLDS, ROOT))).toContain('No changed source files under coverage.')
  })

  it('reports a pass', () => {
    const text = formatReport(summarizeCoverage(FIXTURE_SUMMARY, ['src/core/plan/rows.ts'], THRESHOLDS, ROOT))
    expect(text).toContain('ok    src/core/plan/rows.ts')
    expect(text).toContain('PASS: every changed file and the aggregate meet the thresholds.')
  })
})
