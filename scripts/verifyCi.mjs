/**
 * Full Definition of Done on GitHub for the pushed branch head: `npm run verify:ci [-- --base <branch>]`.
 *
 * Refuses a dirty working tree, a detached HEAD, the default branch, and a HEAD that differs from the branch head on
 * origin. Otherwise it dispatches CI Checks (`pr-checks.yml`) for that exact commit, Fireguard grading it against
 * `--base` (default `main`), waits with `gh run watch`, and prints each Definition of Done check (lint, typecheck,
 * test, coverage, deadcode, build) plus Fireguard by name with the run URL, head SHA and merged coverage.
 *
 * Exit codes: 0 every check passed; 1 a check failed; 2 refused or a tool error (nothing dispatched, or no result).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateCoverage } from './coverageSummary.mjs'

const WORKFLOW = 'pr-checks.yml'

/** Each reported check, read from the job (and step) of that name in a CI Checks run. */
export const CHECKS = [
  { name: 'lint', job: 'lint' },
  { name: 'typecheck', job: 'build', step: 'typecheck' },
  { name: 'test', job: 'test' },
  { name: 'coverage', job: 'coverage' },
  { name: 'deadcode', job: 'deadcode' },
  { name: 'build', job: 'build', step: 'build' },
  { name: 'fireguard', job: 'fireguard' }
]

/** @param {string[]} argv */
export function parseArgs(argv) {
  if (argv.length === 0) return { base: 'main' }
  if (argv[0] !== '--base' || argv.length !== 2 || argv[1].startsWith('--')) {
    throw new Error('usage: npm run verify:ci [-- --base <branch>]')
  }
  return { base: argv[1] }
}

/**
 * Why this HEAD cannot be verified on GitHub, or undefined when it can.
 * @param {{ status: string, branch: string, head: string, remoteHead: string, defaultBranch: string }} state
 */
export function refusal({ status, branch, head, remoteHead, defaultBranch }) {
  if (status) return `the working tree has uncommitted changes; commit them and push first:\n${status}`
  if (!branch) return 'HEAD is detached; check out the branch to verify'
  if (branch === defaultBranch) return `${branch} is the default branch; CI Checks already runs on every push to it`
  if (!remoteHead) return `${branch} is not on origin; push it first (git push -u origin ${branch})`
  if (remoteHead !== head) return `HEAD ${head} is not the origin/${branch} head ${remoteHead}; push or pull first`
  return undefined
}

/**
 * Per-check results of `gh run view --json url,headSha,jobs`: `passed` only for a successful job or step.
 * @param {{ jobs: { name: string, conclusion: string, steps?: { name: string, conclusion: string }[] }[] }} run
 */
export function checkResults(run) {
  return CHECKS.map(({ name, job, step }) => {
    const found = run.jobs.find((entry) => entry.name === job)
    const target = step ? found?.steps?.find((entry) => entry.name === step) : found
    const conclusion = target ? target.conclusion || 'unfinished' : 'missing'
    return { name, status: conclusion === 'success' ? 'passed' : 'failed', conclusion }
  })
}

/** @param {ReturnType<typeof evaluateCoverage>} coverage */
export function formatCoverage(coverage) {
  return coverage.metrics.map(({ name, covered, total, pct, threshold }) =>
    `  ${name} ${pct}% (${covered}/${total}, threshold ${threshold === undefined ? '-' : `${threshold}%`})`)
}

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string }} RunResult
 * @typedef {(command: string, args: string[], options?: { inherit?: boolean }) => RunResult} Runner
 */

/**
 * @param {{ argv: string[], run: Runner, log: (line: string) => void, now: () => number,
 *   loadThresholds: () => Promise<Record<string, number>> }} io
 * @returns {Promise<number>} exit code
 */
export async function verifyCi({ argv, run, log, now, loadThresholds }) {
  const { base } = parseArgs(argv)
  const output = outputOf(run)
  const state = headState(run, output)
  const refused = refusal(state)
  if (refused) {
    log(`verify:ci refused: ${refused}`)
    return 2
  }

  const { branch, head } = state
  const started = now()
  const dispatched = output('gh', ['workflow', 'run', WORKFLOW, '--ref', branch, '-f', `ref=${head}`, '-f', `base=${base}`])
  const runId = /\/actions\/runs\/(\d+)/.exec(dispatched)?.[1]
  if (!runId) throw new Error(`gh workflow run printed no run URL (gh 2.87 or later prints it): ${dispatched}`)
  log(`verify:ci dispatched CI Checks for ${branch} at ${head} (Fireguard base ${base}): ${dispatched}`)
  run('gh', ['run', 'watch', runId, '--exit-status', '--interval', '30'], { inherit: true })

  const view = JSON.parse(output('gh', ['run', 'view', runId, '--json', 'url,headSha,jobs']))
  const seconds = Math.round((now() - started) / 1000)
  const coverage = await mergedCoverage(run, runId, loadThresholds)
  return report(log, { view, head, seconds, coverage }) ? 0 : 1
}

/**
 * Prints the run's checks and merged coverage; true when every check passed on `head` and coverage meets thresholds.
 * @param {(line: string) => void} log
 * @param {{ view: { url: string, headSha: string, jobs: Parameters<typeof checkResults>[0]['jobs'] }, head: string,
 *   seconds: number, coverage: ReturnType<typeof evaluateCoverage> | undefined }} result
 */
function report(log, { view, head, seconds, coverage }) {
  const results = checkResults(view)
  log('')
  log(`run: ${view.url}`)
  log(`head SHA: ${view.headSha}${view.headSha === head ? '' : ` (expected ${head})`}`)
  log(`wall time: ${seconds} s`)
  for (const { name, status, conclusion } of results) log(`${name}: ${status}${status === 'passed' ? '' : ` (${conclusion})`}`)
  log('merged coverage:')
  for (const line of coverage ? formatCoverage(coverage) : ['  unavailable (no coverage-summary artifact)']) log(line)
  return view.headSha === head && results.every((result) => result.status === 'passed') && coverage?.pass === true
}

/** The trimmed stdout of a command that must succeed. @param {Runner} run */
function outputOf(run) {
  /** @param {string} command @param {string[]} args */
  return (command, args) => {
    const result = run(command, args)
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.trim()}`)
    return result.stdout.trim()
  }
}

/** @param {Runner} run @param {ReturnType<typeof outputOf>} output */
function headState(run, output) {
  const head = output('git', ['rev-parse', 'HEAD'])
  const status = output('git', ['status', '--porcelain'])
  const branch = run('git', ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim()
  const defaultBranch = output('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])
  const remoteHead = branch ? output('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]).split(/\s/)[0] : ''
  return { status, branch, head, remoteHead, defaultBranch }
}

/** @param {Runner} run @param {string} runId @param {() => Promise<Record<string, number>>} loadThresholds */
async function mergedCoverage(run, runId, loadThresholds) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-ci-'))
  try {
    if (run('gh', ['run', 'download', runId, '-n', 'coverage-summary', '-D', dir]).status !== 0) return undefined
    return evaluateCoverage(JSON.parse(readFileSync(join(dir, 'coverage-summary.json'), 'utf8')), await loadThresholds())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** @type {Runner} */
function spawnRunner(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: options.inherit ? 'inherit' : 'pipe' })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const loadThresholds = async () => (await import('./changedCoverage.mjs')).loadVitestConfig().then((config) => config.thresholds)
  verifyCi({ argv: process.argv.slice(2), run: spawnRunner, log: console.log, now: Date.now, loadThresholds }).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`verify:ci error: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(2)
    })
}
