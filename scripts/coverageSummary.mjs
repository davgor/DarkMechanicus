/**
 * Merged coverage summary: `node scripts/coverageSummary.mjs [--summary <coverage-summary.json>] [--markdown-out <path>]`.
 *
 * Renders the global coverage of a `vitest --merge-reports --coverage` run (its `json-summary` report, by default
 * `coverage/coverage-summary.json`) against the `vitest.config.ts` coverage thresholds, as a Markdown table for the
 * CI job summary. The CI `coverage` job publishes it; vitest's own threshold check in the merge fails the job too.
 *
 * Exit codes: 0 every metric meets its threshold; 1 one is below it; 2 tool error (a missing or malformed summary).
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { METRICS, loadVitestConfig } from './changedCoverage.mjs'

/** @param {string[]} argv */
export function parseArgs(argv) {
  const options = { summary: 'coverage/coverage-summary.json', markdownOut: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]
    if (arg !== '--summary' && arg !== '--markdown-out') throw new Error(`Unknown argument: ${arg}`)
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    if (arg === '--summary') options.summary = value
    else options.markdownOut = value
    index += 1
  }
  return options
}

/**
 * The global metrics (the summary's `total`, with istanbul's own `pct`, which vitest checks) against the thresholds.
 * @param {{ total?: Record<string, { total: number, covered: number, pct: number }> }} summary
 * @param {Record<string, number>} thresholds percentages per metric
 */
export function evaluateCoverage(summary, thresholds) {
  const metrics = METRICS.map((name) => {
    const metric = summary.total?.[name]
    if (!metric || !Number.isFinite(metric.pct) || !Number.isFinite(metric.total) || !Number.isFinite(metric.covered)) {
      throw new Error(`coverage summary has no total ${name}`)
    }
    const threshold = thresholds[name]
    return { name, covered: metric.covered, total: metric.total, pct: metric.pct, threshold,
      pass: threshold === undefined || metric.pct >= threshold }
  })
  return { metrics, pass: metrics.every((metric) => metric.pass) }
}

/** @param {ReturnType<typeof evaluateCoverage>} result */
export function formatMarkdown(result) {
  return [
    '## Merged coverage (all test shards)',
    '',
    '| Metric | Covered | Total | % | Threshold | Status |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...result.metrics.map(({ name, covered, total, pct, threshold, pass }) =>
      `| ${name} | ${covered} | ${total} | ${pct}% | ${threshold === undefined ? '-' : `${threshold}%`} | ${pass ? 'pass' : '**BELOW**'} |`),
    '',
    result.pass ? 'PASS: merged coverage meets every vitest.config.ts threshold.' : 'FAIL: merged coverage is below a vitest.config.ts threshold.',
    ''
  ].join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const { thresholds } = await loadVitestConfig()
  const result = evaluateCoverage(JSON.parse(readFileSync(options.summary, 'utf8')), thresholds)
  const markdown = formatMarkdown(result)
  console.log(markdown)
  if (options.markdownOut) appendFileSync(options.markdownOut, markdown)
  return result.pass ? 0 : 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`coverage summary error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  })
}
