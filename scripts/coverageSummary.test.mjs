import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { evaluateCoverage, formatMarkdown, parseArgs } from './coverageSummary.mjs'

const SCRIPT = fileURLToPath(new URL('./coverageSummary.mjs', import.meta.url))
const THRESHOLDS = { lines: 97, branches: 95, functions: 96, statements: 97 }
const metric = (covered, total) => ({ covered, total, skipped: 0, pct: Math.floor((covered / total) * 10_000) / 100 })
const summary = (branches) => ({
  total: { lines: metric(9750, 10_000), statements: metric(9800, 10_000), functions: metric(970, 1000), branches },
  'src/a.ts': { lines: metric(1, 10) }
})

describe('evaluateCoverage', () => {
  it('passes when every global metric meets its threshold, at the threshold too', () => {
    const result = evaluateCoverage(summary(metric(950, 1000)), THRESHOLDS)
    expect(result.pass).toBe(true)
    expect(result.metrics.find((entry) => entry.name === 'branches')).toEqual(
      { name: 'branches', covered: 950, total: 1000, pct: 95, threshold: 95, pass: true })
  })

  it('fails on one metric below its threshold, judged on the total rather than any file', () => {
    const result = evaluateCoverage(summary(metric(949, 1000)), THRESHOLDS)
    expect(result.pass).toBe(false)
    expect(result.metrics.filter((entry) => !entry.pass).map((entry) => entry.name)).toEqual(['branches'])
    expect(formatMarkdown(result)).toContain('| branches | 949 | 1000 | 94.9% | 95% | **BELOW** |')
    expect(formatMarkdown(result)).toContain('FAIL: merged coverage is below a vitest.config.ts threshold.')
  })

  it('refuses a summary without a global metric', () => {
    expect(() => evaluateCoverage({ total: { lines: metric(1, 1) } }, THRESHOLDS)).toThrow('coverage summary has no total statements')
  })

  it('parses its two options and refuses anything else', () => {
    expect(parseArgs([])).toEqual({ summary: 'coverage/coverage-summary.json', markdownOut: undefined })
    expect(parseArgs(['--summary', 's.json', '--markdown-out', 'out.md'])).toEqual({ summary: 's.json', markdownOut: 'out.md' })
    expect(() => parseArgs(['--summary'])).toThrow('--summary requires a value')
    expect(() => parseArgs(['--shard', '1/2'])).toThrow('Unknown argument: --shard')
  })
})

describe('coverage summary CLI against vitest.config.ts', () => {
  let directory

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
    directory = undefined
  })

  function run(content) {
    directory = mkdtempSync(join(tmpdir(), 'dm-coverage-summary-'))
    const summaryPath = join(directory, 'coverage-summary.json')
    const markdownPath = join(directory, 'step-summary.md')
    if (content !== undefined) writeFileSync(summaryPath, JSON.stringify(content))
    const result = spawnSync(process.execPath, [SCRIPT, '--summary', summaryPath, '--markdown-out', markdownPath], { encoding: 'utf8' })
    const markdown = content === undefined ? '' : readFileSync(markdownPath, 'utf8')
    return { status: result.status, stderr: result.stderr, markdown }
  }

  it('publishes the table and exits 0 at the configured thresholds', () => {
    const { status, markdown } = run(summary(metric(950, 1000)))
    expect(status).toBe(0)
    for (const [name, threshold] of Object.entries(THRESHOLDS)) expect(markdown).toMatch(new RegExp(`\\| ${name} \\|.*\\| ${threshold}% \\| pass \\|`))
  })

  it('exits 1 when the merged coverage misses a configured threshold', () => {
    const { status, markdown } = run(summary(metric(949, 1000)))
    expect(status).toBe(1)
    expect(markdown).toContain('**BELOW**')
  })

  it('exits 2 when the merge left no summary', () => {
    const { status, stderr } = run(undefined)
    expect(status).toBe(2)
    expect(stderr).toContain('coverage summary error')
  })
})
