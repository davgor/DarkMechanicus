import { describe, expect, it } from 'vitest'
import { rowChecks, summarizeRowChecks } from './rowCheck.mjs'

describe('rowChecks', () => {
  it('runs the Fireguard AST gate, deadcode and changed-file coverage against the base, cheapest first', () => {
    const checks = rowChecks('origin/sprint/s1')
    expect(checks.map(({ name, args, env }) => ({ name, args, env }))).toEqual([
      { name: 'fireguard:ast', args: ['fireguard/bin/fireguard.mjs', '--ast-only'], env: { FIREGUARD_BASE_REF: 'origin/sprint/s1' } },
      { name: 'deadcode', args: ['scripts/deadcode-check.mjs'], env: {} },
      { name: 'coverage:changed', args: ['scripts/changedCoverage.mjs', '--base', 'origin/sprint/s1'], env: {} }
    ])
    expect(new Set(checks.map(({ command }) => command))).toEqual(new Set([process.execPath]))
  })
})

describe('summarizeRowChecks', () => {
  it('marks a nonzero or missing exit code failed and fails the row', () => {
    const summary = summarizeRowChecks([
      { name: 'fireguard:ast', exitCode: 0, seconds: 1.2 },
      { name: 'deadcode', exitCode: 1, seconds: 40 },
      { name: 'coverage:changed', exitCode: null, seconds: 3 }
    ])
    expect(summary.checks.map(({ name, status }) => [name, status])).toEqual([
      ['fireguard:ast', 'passed'], ['deadcode', 'failed'], ['coverage:changed', 'failed']
    ])
    expect(summary.pass).toBe(false)
    expect(summary.text).toContain('failed deadcode (exit 1, 40s)')
  })

  it('passes when every check exits 0', () => {
    expect(summarizeRowChecks([{ name: 'deadcode', exitCode: 0, seconds: 5 }]).pass).toBe(true)
  })
})
