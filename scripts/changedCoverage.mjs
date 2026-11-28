/**
 * Changed-file coverage: `npm run coverage:changed -- --base <ref> [--json-out <path>]`.
 *
 * Runs only the tests related to the source files changed since the merge base of `<ref>` and HEAD (committed,
 * uncommitted and untracked changes; `vitest related`), with coverage limited to those source files, then prints
 * statements/branches/functions/lines for each changed source file and for them together, flagging any below the
 * `vitest.config.ts` coverage thresholds. An early signal for ticket and row checks, in minutes; it never replaces the
 * full `npm run coverage` gate.
 *
 * Exit codes: 0 every changed file and the aggregate meet the thresholds; 1 one is below them, or a related test
 * failed; 2 tool error. `--json-out` writes the result as JSON (the stable shape `summarizeCoverage` returns).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { minimatch } from 'minimatch'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const METRICS = /** @type {const} */ (['statements', 'branches', 'functions', 'lines'])

/** @param {string[]} argv */
export function parseArgs(argv) {
  const options = { base: 'main', jsonOut: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]
    if (arg === '--base' || arg === '--json-out') {
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      if (arg === '--base') options.base = value
      else options.jsonOut = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

/**
 * Splits changed paths into the source files coverage measures (the config's coverage `include` minus `exclude`) and
 * the changed test files, which run too even when no changed source is theirs.
 * @param {string[]} paths repository-relative, forward slashes
 * @param {{ include: string[], exclude: string[], tests: string[] }} globs
 */
export function selectChangedFiles(paths, globs) {
  const matches = (path, patterns) => patterns.some((pattern) => minimatch(path, pattern, { dot: true }))
  const unique = [...new Set(paths)].sort()
  return {
    sources: unique.filter((path) => matches(path, globs.include) && !matches(path, globs.exclude)),
    tests: unique.filter((path) => matches(path, globs.tests))
  }
}

/** @param {{ total: number, covered: number }} metric */
function percent({ total, covered }) {
  return total === 0 ? 100 : Math.round((covered / total) * 10_000) / 100
}

/**
 * Per-file and aggregate metrics for the changed sources from an istanbul `coverage-summary.json`, flagging each
 * metric below its threshold. A changed source absent from the summary was never loaded by a related test: it counts
 * as uncovered and is flagged.
 * @param {Record<string, Record<string, { total: number, covered: number }>>} summary keys are absolute paths or `total`
 * @param {string[]} sources repository-relative changed sources
 * @param {Record<string, number>} thresholds percentages per metric
 * @param {string} root the repository root the summary's absolute paths are under
 */
export function summarizeCoverage(summary, sources, thresholds, root) {
  const byPath = new Map(Object.entries(summary)
    .filter(([key]) => key !== 'total')
    .map(([key, value]) => [relative(root, key).split('\\').join('/'), value]))
  const totals = Object.fromEntries(METRICS.map((metric) => [metric, { total: 0, covered: 0 }]))
  const files = sources.map((path) => {
    const entry = byPath.get(path)
    const metrics = Object.fromEntries(METRICS.map((metric) => {
      const { total, covered } = entry?.[metric] ?? { total: 1, covered: 0 }
      totals[metric].total += total
      totals[metric].covered += covered
      return [metric, { total, covered, pct: percent({ total, covered }) }]
    }))
    return { path, tested: entry !== undefined, metrics, below: belowThresholds(metrics, thresholds) }
  })
  const aggregateMetrics = Object.fromEntries(METRICS.map((metric) => [metric, { ...totals[metric], pct: percent(totals[metric]) }]))
  const aggregate = { metrics: aggregateMetrics, below: files.length === 0 ? [] : belowThresholds(aggregateMetrics, thresholds) }
  return { thresholds, files, aggregate, pass: aggregate.below.length === 0 && files.every((file) => file.below.length === 0) }
}

/**
 * @param {Record<string, { pct: number }>} metrics
 * @param {Record<string, number>} thresholds
 */
function belowThresholds(metrics, thresholds) {
  return METRICS.filter((metric) => thresholds[metric] !== undefined && metrics[metric].pct < thresholds[metric])
}

/** @param {ReturnType<typeof summarizeCoverage>} result */
export function formatReport(result) {
  const cell = (metric, below) => `${metric.pct.toFixed(2)}%${below ? '*' : ''} (${metric.covered}/${metric.total})`
  const row = (label, metrics, below) => `${label}\n  ${METRICS.map((name) => `${name} ${cell(metrics[name], below.includes(name))}`).join('  ')}`
  const lines = [`Changed-file coverage (thresholds: ${METRICS.map((name) => `${name} ${result.thresholds[name]}%`).join(', ')}; * = below)`]
  if (result.files.length === 0) {
    lines.push('No changed source files under coverage.')
    return lines.join('\n')
  }
  for (const file of result.files) {
    lines.push(row(`${file.below.length > 0 ? 'BELOW' : 'ok   '} ${file.path}${file.tested ? '' : ' (no related test loaded it)'}`, file.metrics, file.below))
  }
  lines.push(row(`${result.aggregate.below.length > 0 ? 'BELOW' : 'ok   '} all ${result.files.length} changed source files`, result.aggregate.metrics, result.aggregate.below))
  lines.push(result.pass ? 'PASS: every changed file and the aggregate meet the thresholds.' : 'FAIL: changed-file coverage is below the thresholds (marked BELOW).')
  return lines.join('\n')
}

/** @param {string[]} args */
function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** Paths changed since the merge base of `base` and HEAD: committed, uncommitted and untracked, deletions excluded. */
function changedPaths(base) {
  const [mergeBase] = git(['merge-base', base, 'HEAD'])
  return [
    ...git(['diff', '--name-only', '--diff-filter=ACMR', mergeBase]),
    ...git(['ls-files', '--others', '--exclude-standard'])
  ]
}

/** The coverage include/exclude/thresholds and test globs vitest.config.ts declares. */
export async function loadVitestConfig() {
  const { loadConfigFromFile } = await import('vite')
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, join(ROOT, 'vitest.config.ts'), ROOT, 'silent')
  const test = loaded?.config.test
  if (!test?.coverage?.thresholds) throw new Error('vitest.config.ts declares no coverage thresholds')
  return {
    include: test.coverage.include ?? [],
    exclude: test.coverage.exclude ?? [],
    tests: [...new Set((test.projects ?? []).flatMap((project) => project.test?.include ?? []))],
    thresholds: test.coverage.thresholds
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const config = await loadVitestConfig()
  const { sources, tests } = selectChangedFiles(changedPaths(options.base), config)
  let result = summarizeCoverage({}, [], config.thresholds, ROOT)
  let testsFailed = false
  if (sources.length > 0) {
    const reports = mkdtempSync(join(tmpdir(), 'dm-changed-coverage-'))
    try {
      const run = spawnSync(process.execPath, [
        join(ROOT, 'node_modules/vitest/vitest.mjs'), 'related', '--run', '--passWithNoTests',
        '--coverage.enabled', '--coverage.reportOnFailure', '--coverage.reporter=json-summary', `--coverage.reportsDirectory=${reports}`,
        ...sources.map((path) => `--coverage.include=${path}`),
        // Thresholds are judged here per file; vitest's own check would judge only the run's total.
        ...METRICS.map((metric) => `--coverage.thresholds.${metric}=0`),
        ...sources, ...tests
      ], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
      if (run.error) throw run.error
      testsFailed = run.status !== 0
      const summaryPath = join(reports, 'coverage-summary.json')
      const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : {}
      result = summarizeCoverage(summary, sources, config.thresholds, ROOT)
    } finally {
      rmSync(reports, { recursive: true, force: true })
    }
  }
  console.log(`\nBase ${options.base}: ${sources.length} changed source file(s), ${tests.length} changed test file(s).`)
  console.log(formatReport(result))
  if (testsFailed) console.error('FAIL: a related test failed; its coverage above is incomplete.')
  if (options.jsonOut) writeFileSync(options.jsonOut, `${JSON.stringify({ base: options.base, testsFailed, ...result }, null, 2)}\n`)
  return testsFailed || !result.pass ? 1 : 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`coverage:changed error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  })
}
