import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const TARGET_SECONDS = 120
const BOOTSTRAP_COUNT = 2
const MAX_SHARDS = 16
// Last known active legacy grade: run 45328911368 (959s + 939s, before timing markers).
const GRADING_BOOTSTRAP_SECONDS = 1898
const MAX_STEP_SECONDS = 6 * 60 * 60
const MAX_JSON_BYTES = 2 * 1024 * 1024
const HISTORY_RUNS = 8
const JOB_PAGE_SIZE = 100 // More than all possible jobs in a run with these matrices.
const WORKFLOW = 'pr-checks.yml'
const UNIT_STEP = 'Run disjoint Vitest shard'
const GRADING_STEP = 'Grade disjoint flake runs and production modules'
const ACTIVE_STEP = 'Record active Fireguard timing sample'
const UNIT_CONFIGS = { app: 'vitest.config.ts', 'fireguard-unit': 'fireguard/vitest.config.ts' }
const SUITES = [...Object.keys(UNIT_CONFIGS), 'fireguard']

const validId = (id) => Number.isSafeInteger(id) && id > 0
const validSeconds = (seconds) => Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_STEP_SECONDS
const shardCount = (seconds) => Math.min(MAX_SHARDS, Math.max(1, Math.ceil(seconds / TARGET_SECONDS)))

function isSuccessfulFirstAttempt(run, event) {
  return validId(run?.id) && run.run_attempt === 1 && run.path === `.github/workflows/${WORKFLOW}` &&
    run.status === 'completed' && run.conclusion === 'success' && run.event === event
}

function isSameRepository(run, repository) {
  return run.repository?.full_name === repository && validId(run.repository.id) &&
    run.head_repository?.id === run.repository.id && run.head_repository.full_name === repository
}

/** Only consider successful first attempts of this workflow in the same repository. */
export function eligibleRun(run, event, repository, defaultBranch) {
  if (!isSuccessfulFirstAttempt(run, event) || !isSameRepository(run, repository)) return false
  if (event === 'push') return run.head_branch === defaultBranch
  // GitHub can omit PR associations after merge. The active marker is itself gated on the PR base.
  return event === 'pull_request' && Array.isArray(run.pull_requests) && run.pull_requests.every((pr) =>
    pr?.base?.ref === defaultBranch && pr.base.repo?.id === run.repository.id)
}

function successfulStep(job, name) {
  if (job.conclusion !== 'success' || !Array.isArray(job.steps)) return undefined
  const steps = job.steps.filter((step) => step?.name === name)
  return steps.length === 1 && steps[0].conclusion === 'success' ? steps[0] : undefined
}

function stepSeconds(step) {
  const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/
  if (typeof step?.started_at !== 'string' || typeof step.completed_at !== 'string' ||
      !timestamp.test(step.started_at) || !timestamp.test(step.completed_at)) return NaN
  return (Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000
}

function shardPosition(name, currentPrefix, legacyPrefix) {
  if (typeof name !== 'string') return undefined
  if (name.startsWith(currentPrefix)) {
    const match = /^(\d+)\/(\d+)\)$/.exec(name.slice(currentPrefix.length))
    return match ? [Number(match[1]), Number(match[2])] : null
  }
  if (legacyPrefix && name.startsWith(legacyPrefix)) {
    const match = /^([12])\)$/.exec(name.slice(legacyPrefix.length))
    return match ? [Number(match[1]), 2] : null
  }
  return undefined
}

function recordTiming(seconds, count, [index, total], elapsed) {
  if (index < 1 || index > total || total > MAX_SHARDS || count !== total ||
      seconds[index - 1] !== undefined || !validSeconds(elapsed)) return false
  seconds[index - 1] = elapsed
  return true
}

function executionSeconds(job, grading) {
  if (grading && !successfulStep(job, ACTIVE_STEP)) return NaN
  return stepSeconds(successfulStep(job, grading ? GRADING_STEP : UNIT_STEP))
}

function collectTimings(suite, jobs) {
  const grading = suite === 'fireguard'
  const [currentPrefix, legacyPrefix] = grading
    ? ['fireguard-shards (']
    : [`test-shards (${suite}, `, `test-shards (${UNIT_CONFIGS[suite]}, `]
  const seconds = []
  let count
  for (const job of jobs) {
    const position = shardPosition(job?.name, currentPrefix, legacyPrefix)
    if (position === undefined) continue
    if (position === null) return undefined
    count ??= position[1]
    if (!recordTiming(seconds, count, position, executionSeconds(job, grading))) {
      return undefined
    }
  }
  return seconds.filter(validSeconds).length === count ? seconds : undefined
}

/** A sample must contain every matching shard of one suite from the same run. */
export function timingSample(suite, runId, jobs) {
  if (!validId(runId) || !Array.isArray(jobs) || jobs.length > JOB_PAGE_SIZE) return undefined
  const seconds = collectTimings(suite, jobs)
  return seconds ? { runId, seconds } : undefined
}

export function planShards(history = {}) {
  const suites = Object.fromEntries(SUITES.map((suite) => {
    const sample = history[suite]
    if (!sample) {
      const count = suite === 'fireguard' ? shardCount(GRADING_BOOTSTRAP_SECONDS) : BOOTSTRAP_COUNT
      return [suite, { source: 'bootstrap', count, limit: MAX_SHARDS }]
    }
    const totalSeconds = sample.seconds.reduce((sum, seconds) => sum + seconds, 0)
    const count = shardCount(totalSeconds)
    return [suite, {
      source: 'history', ...sample, totalSeconds, count, limit: MAX_SHARDS,
      estimatedSecondsPerShard: Math.round(totalSeconds / count)
    }]
  }))
  const positions = (count) => Array.from({ length: count }, (_, i) => ({ index: i + 1, count }))
  return {
    targetSeconds: TARGET_SECONDS,
    suites,
    unit: { include: Object.entries(UNIT_CONFIGS).flatMap(([suite, config]) =>
      positions(suites[suite].count).map((position) => ({ suite, config, ...position }))) },
    grading: { include: positions(suites.fireguard.count) }
  }
}

async function apiJson(env, endpoint) {
  const response = await fetch(`${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/actions/${endpoint}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}` },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok || !response.body) throw new Error(`Actions API HTTP ${response.status}`)
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > MAX_JSON_BYTES) throw new Error('Actions API response exceeded size limit')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
}

async function listRuns(env, event, branch) {
  const branchQuery = event === 'push' ? `&branch=${encodeURIComponent(branch)}` : ''
  const index = await apiJson(env, `workflows/${WORKFLOW}/runs?event=${event}&status=success&per_page=${HISTORY_RUNS}${branchQuery}`)
  const runs = index?.workflow_runs
  return Array.isArray(runs) && runs.length <= HISTORY_RUNS ? runs : []
}

async function listJobs(env, id) {
  const response = await apiJson(env, `runs/${id}/attempts/1/jobs?per_page=${JOB_PAGE_SIZE}`)
  return Array.isArray(response?.jobs) && response.jobs.length === response.total_count ? response.jobs : []
}

async function findHistory(env, event, suites) {
  const history = {}
  const branch = env.CI_HISTORY_DEFAULT_BRANCH
  try {
    for (const run of await listRuns(env, event, branch)) {
      if (!eligibleRun(run, event, env.GITHUB_REPOSITORY, branch)) continue
      const jobs = await listJobs(env, run.id)
      for (const suite of suites) history[suite] ??= timingSample(suite, run.id, jobs)
      if (suites.every((suite) => history[suite])) break
    }
  } catch (error) {
    console.warn(`CI shard history (${event}): ${error.message}; missing samples use bootstrap counts`)
  }
  return history
}

async function readLiveHistory(env) {
  const keys = ['GH_TOKEN', 'GITHUB_API_URL', 'GITHUB_REPOSITORY', 'CI_HISTORY_DEFAULT_BRANCH']
  if (!keys.every((key) => env[key])) return {}
  const [unit, grading] = await Promise.all([
    findHistory(env, 'push', Object.keys(UNIT_CONFIGS)),
    findHistory(env, 'pull_request', ['fireguard'])
  ])
  return { ...unit, ...grading }
}

function readFixture(path) {
  try {
    if (statSync(path).size > MAX_JSON_BYTES) throw new Error('fixture exceeded size limit')
    const fixture = JSON.parse(readFileSync(path, 'utf8'))
    return Object.fromEntries(SUITES.map((suite) => {
      const sample = fixture?.[suite]
      return [suite, timingSample(suite, sample?.runId, sample?.jobs)]
    }))
  } catch (error) {
    console.warn(`CI shard history fixture: ${error.message}; using bootstrap counts`)
    return {}
  }
}

function readHistory([flag, path, ...extra], env) {
  if (flag === undefined) return readLiveHistory(env)
  if (flag !== '--history' || !path || extra.length) throw new Error('Usage: node scripts/ciShardPlan.mjs [--history path]')
  return readFixture(path)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = planShards(await readHistory(process.argv.slice(2), process.env))
  console.error(`CI shard target: ${plan.targetSeconds}s execution, cap: ${MAX_SHARDS} per suite`)
  for (const [suite, detail] of Object.entries(plan.suites)) {
    const source = detail.source === 'history' ? `run ${detail.runId}: ${detail.seconds.join(' + ')}s` : 'bootstrap (no complete timing sample)'
    console.error(`  ${suite}: ${detail.count}/${detail.limit} shards (${source})`)
  }
  const { GITHUB_OUTPUT } = process.env
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, [
    `unit=${JSON.stringify(plan.unit)}`,
    `grading=${JSON.stringify(plan.grading)}`,
    `grading_count=${plan.suites.fireguard.count}\n`
  ].join('\n'))
  console.log(JSON.stringify(plan, null, 2))
}
