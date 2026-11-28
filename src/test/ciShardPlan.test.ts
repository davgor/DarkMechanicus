import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('emits the GitHub unit matrix from separate execution samples', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dm-ci-plan-'))
  try {
    const path = join(directory, 'history.json')
    const outputPath = join(directory, 'outputs')
    const job = (name: string, completed_at: string) => ({
      name,
      conclusion: 'success',
      steps: [{ name: 'Run disjoint Vitest shard', conclusion: 'success', started_at: '2026-01-01T00:00:00Z', completed_at }]
    })
    writeFileSync(path, JSON.stringify({
      app: { runId: 1, jobs: [job('test-shards (app, 1/1)', '2026-01-01T00:05:00Z')] },
      'fireguard-unit': { runId: 1, jobs: [job('test-shards (fireguard-unit, 1/1)', '2026-01-01T00:00:40Z')] }
    }))
    const script = fileURLToPath(new URL('../../scripts/ciShardPlan.mjs', import.meta.url))
    const stdout = execFileSync(process.execPath, [script, '--history', path], {
      encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outputPath }, stdio: ['ignore', 'pipe', 'pipe']
    })
    const lines = readFileSync(outputPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0].slice('unit='.length))).toEqual({ include: [
      { suite: 'app', config: 'vitest.config.ts', index: 1, count: 3 },
      { suite: 'app', config: 'vitest.config.ts', index: 2, count: 3 },
      { suite: 'app', config: 'vitest.config.ts', index: 3, count: 3 },
      { suite: 'fireguard-unit', config: 'fireguard/vitest.config.ts', index: 1, count: 1 }
    ] })
    expect(JSON.parse(stdout)).toMatchObject({
      targetSeconds: 120,
      suites: { app: { count: 3, runId: 1 }, 'fireguard-unit': { count: 1, runId: 1 } }
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
