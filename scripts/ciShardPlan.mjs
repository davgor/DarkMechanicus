import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Vitest shard sizing only. Fireguard grading sizes itself from the diff (`fireguard --plan`).
const TARGET_SECONDS = 120
const BOOTSTRAP_COUNT = 2
const MAX_SHARDS = 16
const MAX_STEP_SECONDS = 6 * 60 * 60
const MAX_JSON_BYTES = 2 * 1024 * 1024
const HISTORY_RUNS = 8
const JOB_PAGE_SIZE = 100 // More than all possible jobs in a run with these matrices.
const WORKFLOW = 'pr-checks.yml'
const UNIT_STEP = 'Run disjoint Vitest shard'
const UNIT_CONFIGS = { app: 'vitest.config.ts', 'fireguard-unit': 'fireguard/vitest.config.ts' }
const SUITES = Object.keys(UNIT_CONFIGS)

const validId = (id) => Number.isSafeInteger(id) && id > 0
const validSeconds = (seconds) => Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_STEP_SECONDS
const shardCount = (seconds) => Math.min(MAX_SHARDS, Math.max(1, Math.ceil(seconds / TARGET_SECONDS)))

function isSuccessfulFirstPush(run) {
  return validId(run?.id) && run.run_attempt === 1 && run.path === `.github/workflows/${WORKFLOW}` &&
    run.status === 'completed' && run.conclusion === 'success' && run.event === 'push'
}

function isSameRepository(run, repository) {
  return run.repository?.full_name === repository && validId(run.repository.id) &&
    run.head_repository?.id === run.repository.id && run.head_repository.full_name === repository
}

/** Only consider successful first attempts of this workflow's default-branch pushes in the same repository. */
export function eligibleRun(run, repository, defaultBranch) {
  return isSuccessfulFirstPush(run) && isSameRepository(run, repository) && run.head_branch === defaultBranch
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
  if (name.startsWith(legacyPrefix)) {
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

function collectTimings(suite, jobs) {
  const currentPrefix = `test-shards (${suite}, `
  const legacyPrefix = `test-shards (${UNIT_CONFIGS[suite]}, `
  const seconds = []
  let count
  for (const job of jobs) {
    const position = shardPosition(job?.name, currentPrefix, legacyPrefix)
    if (position === undefined) continue
    if (position === null) return undefined
    count ??= position[1]
    if (!recordTiming(seconds, count, position, stepSeconds(successfulStep(job, UNIT_STEP)))) {
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

function sized(detail, count) {
  const result = { ...detail, count, limit: MAX_SHARDS }
  if (detail.totalSeconds !== undefined) result.estimatedSecondsPerShard = Math.round(detail.totalSeconds / count)
  return result
}

function planSuite(sample) {
  if (!sample) return sized({ source: 'bootstrap' }, BOOTSTRAP_COUNT)
  const totalSeconds = sample.seconds.reduce((sum, seconds) => sum + seconds, 0)
  return sized({ source: 'history', ...sample, totalSeconds }, shardCount(totalSeconds))
}

export function planShards(history = {}) {
  const suites = Object.fromEntries(SUITES.map((suite) => [suite, planSuite(history[suite])]))
  const positions = (count) => Array.from({ length: count }, (_, i) => ({ index: i + 1, count }))
  return {
    targetSeconds: TARGET_SECONDS,
    suites,
    unit: { include: Object.entries(UNIT_CONFIGS).flatMap(([suite, config]) =>
      positions(suites[suite].count).map((position) => ({ suite, config, ...position }))) }
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

/** The latest successful default-branch push runs; the caller rechecks each run. */
async function listRuns(env, branch) {
  const query = `event=push&status=success&per_page=${HISTORY_RUNS}&branch=${encodeURIComponent(branch)}`
  const index = await apiJson(env, `workflows/${WORKFLOW}/runs?${query}`)
  const runs = index?.workflow_runs
  return Array.isArray(runs) && runs.length <= HISTORY_RUNS ? runs : []
}

async function listJobs(env, id) {
  const response = await apiJson(env, `runs/${id}/attempts/1/jobs?per_page=${JOB_PAGE_SIZE}`)
  return Array.isArray(response?.jobs) && response.jobs.length === response.total_count ? response.jobs : []
}

/** Unit samples come from default-branch pushes. */
export async function readLiveHistory(env) {
  const keys = ['GH_TOKEN', 'GITHUB_API_URL', 'GITHUB_REPOSITORY', 'CI_HISTORY_DEFAULT_BRANCH']
  if (!keys.every((key) => env[key])) return {}
  const history = {}
  const { GITHUB_REPOSITORY: repository, CI_HISTORY_DEFAULT_BRANCH: branch } = env
  try {
    for (const run of await listRuns(env, branch)) {
      if (!eligibleRun(run, repository, branch)) continue
      const jobs = await listJobs(env, run.id)
      for (const suite of SUITES) history[suite] ??= timingSample(suite, run.id, jobs)
      if (SUITES.every((suite) => history[suite])) break
    }
  } catch (error) {
    console.warn(`CI shard history: ${error.message}; missing samples use bootstrap counts`)
  }
  return history
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
    const source = detail.source === 'history'
      ? `run ${detail.runId}: ${detail.seconds.join(' + ')}s`
      : 'bootstrap (no complete timing sample)'
    console.error(`  ${suite}: ${detail.count}/${detail.limit} shards (${source})`)
  }
  const { GITHUB_OUTPUT } = process.env
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `unit=${JSON.stringify(plan.unit)}\n`)
  console.log(JSON.stringify(plan, null, 2))
}
