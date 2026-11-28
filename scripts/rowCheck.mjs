/**
 * Row-check early signals: `npm run check:row -- --base <ref> [--json-out <path>]`.
 *
 * Runs, against the merge base of `<ref>` and HEAD, the checks that otherwise first fail at sprint acceptance or in CI:
 * Fireguard's AST gate (gate 1 only, on the diff's graded tests and changed modules; committed changes only),
 * `deadcode`, and `coverage:changed`. Each runs even when an earlier one fails; the exit code is 1 when any failed.
 * It finishes in minutes and never replaces the full gate (`npm test`, `npm run coverage`, full Fireguard) at
 * acceptance and in PR CI. `--json-out` writes `[{ name, status, exitCode, seconds }]` for `record_row_check`.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from './changedCoverage.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The row checks in run order, cheapest first: each `{ name, command, args, env }`.
 * @param {string} base
 */
export function rowChecks(base) {
  return [
    { name: 'fireguard:ast', command: process.execPath, args: ['fireguard/bin/fireguard.mjs', '--ast-only'], env: { FIREGUARD_BASE_REF: base } },
    { name: 'deadcode', command: process.execPath, args: ['scripts/deadcode-check.mjs'], env: {} },
    { name: 'coverage:changed', command: process.execPath, args: ['scripts/changedCoverage.mjs', '--base', base], env: {} }
  ]
}

/** @param {{ name: string, exitCode: number | null, seconds: number }[]} results */
export function summarizeRowChecks(results) {
  const checks = results.map(({ name, exitCode, seconds }) => ({ name, status: exitCode === 0 ? 'passed' : 'failed', exitCode, seconds }))
  const lines = ['Row check summary:', ...checks.map((check) => `  ${check.status.padEnd(6)} ${check.name} (exit ${check.exitCode}, ${check.seconds}s)`)]
  return { checks, pass: checks.every((check) => check.status === 'passed'), text: lines.join('\n') }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const results = rowChecks(options.base).map(({ name, command, args, env }) => {
    console.log(`\n=== ${name} ===`)
    const started = Date.now()
    const run = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } })
    if (run.error) console.error(`${name}: ${run.error.message}`)
    return { name, exitCode: run.status, seconds: Math.round((Date.now() - started) / 100) / 10 }
  })
  const summary = summarizeRowChecks(results)
  console.log(`\n${summary.text}`)
  if (options.jsonOut) writeFileSync(options.jsonOut, `${JSON.stringify(summary.checks, null, 2)}\n`)
  return summary.pass ? 0 : 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main())
}
