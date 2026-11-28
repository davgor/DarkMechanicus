import { afterEach, describe, expect, it, vi } from 'vitest'
import { eligibleRun, planShards, readLiveHistory, timingSample } from './ciShardPlan.mjs'

const start = Date.parse('2026-01-01T00:00:00Z')
const iso = (seconds) => new Date(start + seconds * 1000).toISOString()
const unitStep = 'Run disjoint Vitest shard'

function job(name, seconds, stepName = unitStep) {
  return {
    name,
    conclusion: 'success',
    started_at: iso(0),
    completed_at: iso(4000),
    steps: [
      { name: 'npm ci', conclusion: 'success', started_at: iso(2), completed_at: iso(2000) },
      { name: stepName, conclusion: 'success', started_at: iso(2001), completed_at: iso(2001 + seconds) }
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
  it('scales each unit suite independently using only its execution step, including legacy unit jobs', () => {
    const app = sample('app', [job('test-shards (vitest.config.ts, 2)', 599), job('test-shards (vitest.config.ts, 1)', 509)])
    const fireguardUnit = sample('fireguard-unit', unitJobs('fireguard-unit', [7, 19]))
    const plan = planShards({ app, 'fireguard-unit': fireguardUnit })
    expect(counts(plan)).toEqual({ app: 10, 'fireguard-unit': 1 })
    expect(plan.suites.app).toMatchObject({ source: 'history', runId: 15, seconds: [509, 599], totalSeconds: 1108 })
    expect(plan.unit.include.filter((entry) => entry.suite === 'app'))
      .toEqual(Array.from({ length: 10 }, (_, i) => ({ suite: 'app', config: 'vitest.config.ts', index: i + 1, count: 10 })))
    expect(plan.unit.include.at(-1)).toEqual({ suite: 'fireguard-unit', config: 'fireguard/vitest.config.ts', index: 1, count: 1 })
    // Fireguard grading is sized by `fireguard --plan` from the diff, not by this history planner.
    expect(plan).not.toHaveProperty('grading')
  })

  it('caps workload and keeps at least one shard after a complete short sample', () => {
    const plan = planShards({ app: sample('app', unitJobs('app', [2000, 2000])) })
    expect(counts(plan)).toEqual({ app: 16, 'fireguard-unit': 2 })
    expect(plan.suites.app).toMatchObject({ limit: 16, estimatedSecondsPerShard: 250 })
    expect(plan.targetSeconds).toBe(120)
    expect(plan.unit.include).toHaveLength(18)
  })

  it('cold-starts independently when history is absent, partial or invalid', () => {
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
    expect(counts(planShards())).toEqual({ app: 2, 'fireguard-unit': 2 })
    expect(planShards().suites.app).toEqual({ source: 'bootstrap', count: 2, limit: 16 })
  })
})

describe('CI history provenance', () => {
  it('only admits first-attempt successful default-branch pushes of the expected workflow and repository', () => {
    const repo = { id: 51, full_name: 'owner/repo' }
    const run = {
      id: 15, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'push',
      path: '.github/workflows/pr-checks.yml', head_branch: 'main', repository: repo, head_repository: repo
    }
    expect(eligibleRun(run, repo.full_name, 'main')).toBe(true)
    for (const ineligible of [
      { ...run, run_attempt: 2 }, { ...run, conclusion: 'failure' }, { ...run, status: 'in_progress' },
      { ...run, path: '.github/workflows/another.yml' }, { ...run, head_repository: { ...repo, id: 52 } },
      { ...run, event: 'pull_request' }, { ...run, head_branch: 'topic' }
    ]) {
      expect(eligibleRun(ineligible, repo.full_name, 'main')).toBe(false)
    }
  })
})

describe('live unit history', () => {
  const repo = { id: 51, full_name: 'owner/repo' }
  const env = {
    GH_TOKEN: 'token', GITHUB_API_URL: 'https://api.test', GITHUB_REPOSITORY: repo.full_name,
    CI_HISTORY_DEFAULT_BRANCH: 'main'
  }
  const pushRun = (id) => ({
    id, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'push',
    path: '.github/workflows/pr-checks.yml', head_branch: 'main', repository: repo, head_repository: repo
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads unit samples from default-branch pushes only', async () => {
    const requests = []
    vi.stubGlobal('fetch', async (url) => {
      requests.push(url)
      const jobs = [...unitJobs('app', [600, 600]), ...unitJobs('fireguard-unit', [30])]
      const body = /runs\/9\/attempts\/1\/jobs/.test(url)
        ? { jobs, total_count: jobs.length }
        : { workflow_runs: [pushRun(9)] }
      return new Response(JSON.stringify(body))
    })
    const history = await readLiveHistory(env)
    expect(history).toEqual({ app: { runId: 9, seconds: [600, 600] }, 'fireguard-unit': { runId: 9, seconds: [30] } })
    expect(counts(planShards(history))).toEqual({ app: 10, 'fireguard-unit': 1 })
    expect(requests[0]).toContain('event=push')
    expect(requests[0]).toContain('&branch=main')
    expect(requests.some((url) => url.includes('event=pull_request'))).toBe(false)
  })

  it('bootstraps without the Actions API environment', async () => {
    expect(await readLiveHistory({ ...env, GH_TOKEN: '' })).toEqual({})
  })
})
