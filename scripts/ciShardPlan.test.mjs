import { describe, expect, it } from 'vitest'
import { eligibleRun, planShards, timingSample } from './ciShardPlan.mjs'

const start = Date.parse('2026-01-01T00:00:00Z')
const iso = (seconds) => new Date(start + seconds * 1000).toISOString()
const unitStep = 'Run disjoint Vitest shard'
const gradeStep = 'Grade disjoint flake runs and production modules'
const activeStep = 'Record active Fireguard timing sample'

function job(name, seconds, stepName = unitStep, active = true) {
  return {
    name,
    conclusion: 'success',
    started_at: iso(0),
    completed_at: iso(4000),
    steps: [
      { name: 'npm ci', conclusion: 'success', started_at: iso(2), completed_at: iso(2000) },
      { name: stepName, conclusion: 'success', started_at: iso(2001), completed_at: iso(2001 + seconds) },
      { name: activeStep, conclusion: active ? 'success' : 'skipped' }
    ]
  }
}

function sample(suite, jobs, runId = 15) {
  return timingSample(suite, runId, jobs)
}

function unitJobs(suite, times) {
  return times.map((seconds, i) => job(`test-shards (${suite}, ${i + 1}/${times.length})`, seconds))
}

function counts(plan) {
  return Object.fromEntries(Object.entries(plan.suites).map(([suite, detail]) => [suite, detail.count]))
}

describe('execution-time CI shard planning', () => {
  it('scales each suite independently using only its execution step, including legacy unit jobs', () => {
    const app = sample('app', [job('test-shards (vitest.config.ts, 2)', 599), job('test-shards (vitest.config.ts, 1)', 509)])
    const fireguardUnit = sample('fireguard-unit', unitJobs('fireguard-unit', [7, 19]))
    const fireguard = sample('fireguard', [job('fireguard-shards (1/2)', 225, gradeStep), job('fireguard-shards (2/2)', 136, gradeStep)])
    const plan = planShards({ app, 'fireguard-unit': fireguardUnit, fireguard })
    expect(counts(plan)).toEqual({ app: 10, 'fireguard-unit': 1, fireguard: 4 })
    expect(plan.suites.app).toMatchObject({ source: 'history', runId: 15, seconds: [509, 599], totalSeconds: 1108 })
    expect(plan.unit.include.filter((entry) => entry.suite === 'app'))
      .toEqual(Array.from({ length: 10 }, (_, i) => ({ suite: 'app', config: 'vitest.config.ts', index: i + 1, count: 10 })))
    expect(plan.unit.include.at(-1)).toEqual({ suite: 'fireguard-unit', config: 'fireguard/vitest.config.ts', index: 1, count: 1 })
    expect(plan.grading.include).toEqual([1, 2, 3, 4].map((index) => ({ index, count: 4 })))
  })

  it('caps workload and keeps at least one shard after a complete short sample', () => {
    const fireguard = sample('fireguard', [job('fireguard-shards (1/1)', 120, gradeStep)])
    const plan = planShards({ app: sample('app', unitJobs('app', [2000, 2000])), fireguard })
    expect(counts(plan)).toEqual({ app: 16, 'fireguard-unit': 2, fireguard: 1 })
    expect(plan.suites.app).toMatchObject({ limit: 16, estimatedSecondsPerShard: 250 })
    expect(plan.targetSeconds).toBe(120)
    expect(plan.unit.include).toHaveLength(18)
  })

  it('cold-starts independently when history is absent, partial, invalid or a skipped grade', () => {
    const complete = unitJobs('app', [200, 200])
    const invalidDate = structuredClone(complete)
    invalidDate[1].steps[1].started_at = 'yesterday'
    const failed = structuredClone(complete)
    failed[1].conclusion = 'failure'
    const failedStep = structuredClone(complete)
    failedStep[1].steps[1].conclusion = 'failure'
    for (const jobs of [[], [complete[0]], [complete[0], complete[0]], invalidDate, failed, failedStep,
      [complete[0], job('test-shards (app, 2/3)', 200)], [complete[0], job('test-shards (app, 2/2)', 0)],
      [job('test-shards (app, 17/17)', 200)], [job('test-shards (app, 2/1)', 200)]]) {
      expect(sample('app', jobs)).toBeUndefined()
    }
    expect(sample('fireguard', [job('fireguard-shards (1/1)', 1, gradeStep, false)])).toBeUndefined()
    expect(sample('fireguard', [job('fireguard-shards (1)', 180, gradeStep)])).toBeUndefined()
    expect(counts(planShards())).toEqual({ app: 2, 'fireguard-unit': 2, fireguard: 16 })
    expect(planShards().suites.fireguard).toEqual({ source: 'bootstrap', count: 16, limit: 16 })
  })
})

describe('CI history provenance', () => {
  it('only admits first-attempt successful runs of the expected workflow and repository', () => {
    const repo = { id: 51, full_name: 'owner/repo' }
    const run = {
      id: 15, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'push',
      path: '.github/workflows/pr-checks.yml', head_branch: 'main', repository: repo, head_repository: repo
    }
    expect(eligibleRun(run, 'push', repo.full_name, 'main')).toBe(true)
    const pr = { ...run, event: 'pull_request', head_branch: 'topic', pull_requests: [{ base: { ref: 'main', repo } }] }
    expect(eligibleRun(pr, 'pull_request', repo.full_name, 'main')).toBe(true)
    expect(eligibleRun({ ...pr, pull_requests: [] }, 'pull_request', repo.full_name, 'main')).toBe(true)
    for (const ineligible of [
      { ...pr, run_attempt: 2 }, { ...pr, conclusion: 'failure' }, { ...pr, status: 'in_progress' },
      { ...pr, path: '.github/workflows/another.yml' }, { ...pr, head_repository: { ...repo, id: 52 } },
      { ...pr, pull_requests: [{ base: { ref: 'topic', repo } }] }
    ]) {
      expect(eligibleRun(ineligible, 'pull_request', repo.full_name, 'main')).toBe(false)
    }
  })
})
