import { afterEach, describe, expect, it, vi } from 'vitest'
import { eligibleRun, planShards, readLiveHistory, timingSample } from './ciShardPlan.mjs'

const start = Date.parse('2026-01-01T00:00:00Z')
const iso = (seconds) => new Date(start + seconds * 1000).toISOString()
const unitStep = 'Run disjoint Vitest shard'
const coverageStep = 'Run disjoint Vitest shard with coverage'
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
    expect(counts(plan)).toEqual({ app: 11, 'fireguard-unit': 1, fireguard: 4 })
    // A legacy app shard ran without coverage: its time carries the coverage overhead (x1.1, rounded).
    expect(plan.suites.app).toMatchObject({ source: 'history', runId: 15, seconds: [560, 659], totalSeconds: 1219 })
    expect(plan.unit.include.filter((entry) => entry.suite === 'app'))
      .toEqual(Array.from({ length: 11 }, (_, i) => ({ suite: 'app', config: 'vitest.config.ts', index: i + 1, count: 11 })))
    expect(plan.unit.include.at(-1)).toEqual({ suite: 'fireguard-unit', config: 'fireguard/vitest.config.ts', index: 1, count: 1 })
    expect(plan.grading.include).toEqual([1, 2, 3, 4].map((index) => ({ index, count: 4 })))
  })

  it('caps workload and keeps at least one shard after a complete short sample', () => {
    const fireguard = sample('fireguard', [job('fireguard-shards (1/1)', 120, gradeStep)])
    const plan = planShards({ app: sample('app', unitJobs('app', [2000, 2000])), fireguard })
    expect(counts(plan)).toEqual({ app: 16, 'fireguard-unit': 2, fireguard: 1 })
    expect(plan.suites.app).toMatchObject({ limit: 16, estimatedSecondsPerShard: 275 })
    expect(plan.targetSeconds).toBe(120)
    expect(plan.unit.include).toHaveLength(18)
  })

  it('times app shards from their coverage step as is, and only legacy app samples carry the overhead', () => {
    const covered = (times) => times.map((seconds, i) => job(`test-shards (app, ${i + 1}/${times.length})`, seconds, coverageStep))
    expect(sample('app', covered([300, 241]))).toEqual({ runId: 15, seconds: [300, 241] })
    expect(sample('app', unitJobs('app', [300, 241]))).toEqual({ runId: 15, seconds: [330, 265] })
    expect(sample('fireguard-unit', unitJobs('fireguard-unit', [300, 241]))).toEqual({ runId: 15, seconds: [300, 241] })
    // The fireguard unit suite collects no coverage, so a coverage step never times it.
    expect(sample('fireguard-unit', [job('test-shards (fireguard-unit, 1/1)', 300, coverageStep)])).toBeUndefined()
    expect(counts(planShards({ app: sample('app', covered([300, 241])) })).app).toBe(5)
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

describe('grading floor from the graded diff', () => {
  it('raises a grading sample to one shard per changed graded file, capped, and grades an empty diff once', () => {
    const fireguard = sample('fireguard', [job('fireguard-shards (1/1)', 45, gradeStep)])
    expect(planShards({ fireguard }, 254).suites.fireguard)
      .toMatchObject({ source: 'history', runId: 15, diffFiles: 254, count: 16, estimatedSecondsPerShard: 3 })
    expect(planShards({ fireguard }, 3).grading.include).toEqual([1, 2, 3].map((index) => ({ index, count: 3 })))
    const long = sample('fireguard', [job('fireguard-shards (1/2)', 600, gradeStep),
      job('fireguard-shards (2/2)', 600, gradeStep)])
    expect(counts(planShards({ fireguard: long }, 2)).fireguard).toBe(10)
    expect(counts(planShards({}, 5)).fireguard).toBe(16)
    expect(planShards({}, 0).suites.fireguard).toEqual({ source: 'bootstrap', diffFiles: 0, count: 1, limit: 16 })
    expect(planShards({ fireguard: long }, 0).grading.include).toEqual([{ index: 1, count: 1 }])
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

describe('live grading history', () => {
  const repo = { id: 51, full_name: 'owner/repo' }
  const env = {
    GH_TOKEN: 'token', GITHUB_API_URL: 'https://api.test', GITHUB_REPOSITORY: repo.full_name,
    CI_HISTORY_DEFAULT_BRANCH: 'main'
  }
  const prRun = (id, branch) => ({
    id, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'pull_request',
    path: '.github/workflows/pr-checks.yml', head_branch: branch, repository: repo, head_repository: repo,
    pull_requests: [{ base: { ref: 'main', repo } }]
  })
  // A small grade of another branch comes first, as the latest successful PR run of the repository.
  const jobsByRun = {
    7: [job('fireguard-shards (1/1)', 45, gradeStep)],
    8: [job('fireguard-shards (1/1)', 9000, gradeStep)]
  }

  function stubActions(requests) {
    vi.stubGlobal('fetch', async (url) => {
      requests.push(url)
      const run = /runs\/(\d+)\/attempts\/1\/jobs/.exec(url)?.[1]
      const body = run
        ? { jobs: jobsByRun[run], total_count: jobsByRun[run].length }
        : { workflow_runs: url.includes('event=pull_request') ? [prRun(7, 'other'), prRun(8, 'topic')] : [] }
      return new Response(JSON.stringify(body))
    })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sizes grading only from earlier grades of the same pull request branch', async () => {
    const requests = []
    stubActions(requests)
    const history = await readLiveHistory({ ...env, CI_HISTORY_PR_BRANCH: 'topic' })
    expect(history.fireguard).toEqual({ runId: 8, seconds: [9000] })
    expect(counts(planShards(history)).fireguard).toBe(16)
    expect(requests.find((url) => url.includes('event=pull_request'))).toContain('&branch=topic')
    expect(requests.find((url) => url.includes('event=push'))).toContain('&branch=main')
    expect(requests.some((url) => url.includes('runs/7/'))).toBe(false)
  })

  it('bootstraps grading when the run has no pull request branch of this repository', async () => {
    const requests = []
    stubActions(requests)
    expect(await readLiveHistory(env)).toEqual({})
    expect(requests.some((url) => url.includes('event=pull_request'))).toBe(false)
  })
})
