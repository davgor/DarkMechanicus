import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHECKS, checkResults, parseArgs, refusal, verifyCi } from './verifyCi.mjs'

const SCRIPT = fileURLToPath(new URL('./verifyCi.mjs', import.meta.url))

const HEAD = '1ad937d674cfd4407077a357297005d0f4049b0b'
const RUN_URL = 'https://github.com/davgor/DarkMechanicus/actions/runs/46184627904'
const THRESHOLDS = { lines: 97, branches: 95, functions: 96, statements: 97 }
const step = (name, conclusion = 'success') => ({ name, conclusion, status: 'completed', number: 1 })
const job = (name, conclusion = 'success', steps = []) => ({ name, conclusion, status: 'completed', steps: [step('Set up job'), ...steps] })

/** A `gh run view --json url,headSha,jobs` result of a dispatched CI Checks run, trimmed to a few matrix jobs. */
const RUN_VIEW = {
  url: RUN_URL,
  headSha: HEAD,
  jobs: [
    job('shard-plan'),
    job('test-shards (app, 1/15)'),
    job('fireguard-scope'),
    job('fireguard-shards (1/3)'),
    job('lint'),
    job('build', 'success', [step('typecheck'), step('build'), step('Exercise delivery standards in the built desktop', 'skipped')]),
    job('deadcode'),
    job('test'),
    job('coverage'),
    job('fireguard')
  ]
}
const metric = (covered, total) => ({ covered, total, skipped: 0, pct: Math.floor((covered / total) * 10_000) / 100 })
const SUMMARY = { total: { lines: metric(51904, 52699), statements: metric(60433, 61837), functions: metric(18747, 19272), branches: metric(40816, 42793) } }

/**
 * A runner answering each command from `answers` (keyed by the command line's start), recording every call.
 * `gh run download` writes `summary` into its `-D` directory, as gh does with the artifact.
 */
function fakeRunner(answers, summary = SUMMARY) {
  const calls = []
  const run = (command, args, options) => {
    const line = [command, ...args].join(' ')
    calls.push({ line, options })
    if (line.startsWith('gh run download')) {
      if (!summary) return { status: 1, stdout: '', stderr: 'no artifact matches' }
      writeFileSync(join(args[args.indexOf('-D') + 1], 'coverage-summary.json'), JSON.stringify(summary))
      return { status: 0, stdout: '', stderr: '' }
    }
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix))
    if (key === undefined) return { status: 0, stdout: '', stderr: '' }
    const answer = answers[key]
    return typeof answer === 'string' ? { status: 0, stdout: `${answer}\n`, stderr: '' } : answer
  }
  return { run, calls }
}

const cleanHead = (view = RUN_VIEW) => ({
  'git rev-parse HEAD': HEAD,
  'git status --porcelain': '',
  'git symbolic-ref --short -q HEAD': 'work/dm-987',
  'gh repo view': 'main',
  'git ls-remote --heads origin refs/heads/work/dm-987': `${HEAD}\trefs/heads/work/dm-987`,
  'gh workflow run': RUN_URL,
  'gh run view': JSON.stringify(view)
})

async function verify(answers, { argv = [], summary } = {}) {
  const { run, calls } = fakeRunner(answers, summary)
  const lines = []
  let clock = 1_000
  const code = await verifyCi({ argv, run, log: (line) => lines.push(line), now: () => (clock += 60_000), loadThresholds: async () => THRESHOLDS })
  return { code, calls: calls.map((call) => call.line), watch: calls.find((call) => call.line.startsWith('gh run watch')), output: lines.join('\n') }
}

describe('verifyCi refusals', () => {
  it('refuses a dirty working tree before dispatching anything', async () => {
    const result = await verify({ ...cleanHead(), 'git status --porcelain': ' M src/a.ts' })
    expect(result.code).toBe(2)
    expect(result.output).toContain('verify:ci refused: the working tree has uncommitted changes; commit them and push first:\nM src/a.ts')
    expect(result.calls.some((line) => line.startsWith('gh workflow run'))).toBe(false)
  })

  it('refuses a HEAD that is not the origin branch head, and a branch missing on origin', async () => {
    const ahead = await verify({ ...cleanHead(), 'git ls-remote --heads origin refs/heads/work/dm-987': `${'f'.repeat(40)}\trefs/heads/work/dm-987` })
    expect(ahead.code).toBe(2)
    expect(ahead.output).toContain(`HEAD ${HEAD} is not the origin/work/dm-987 head ${'f'.repeat(40)}; push or pull first`)
    const unpushed = await verify({ ...cleanHead(), 'git ls-remote --heads origin refs/heads/work/dm-987': '' })
    expect(unpushed.output).toContain('work/dm-987 is not on origin; push it first (git push -u origin work/dm-987)')
    expect([...ahead.calls, ...unpushed.calls].some((line) => line.startsWith('gh workflow run'))).toBe(false)
  })

  it('refuses a detached HEAD and the default branch', () => {
    const state = { status: '', branch: 'work/x', head: HEAD, remoteHead: HEAD, defaultBranch: 'main' }
    expect(refusal(state)).toBeUndefined()
    expect(refusal({ ...state, branch: '' })).toBe('HEAD is detached; check out the branch to verify')
    expect(refusal({ ...state, branch: 'main' })).toBe('main is the default branch; CI Checks already runs on every push to it')
  })

  it('reads the branch head on origin only for a checked-out branch', async () => {
    const result = await verify({ ...cleanHead(), 'git symbolic-ref --short -q HEAD': { status: 1, stdout: '', stderr: '' } })
    expect(result.code).toBe(2)
    expect(result.calls.some((line) => line.startsWith('git ls-remote'))).toBe(false)
  })

  it('stops on a failing git or gh command with its error', async () => {
    await expect(verify({ ...cleanHead(), 'gh repo view': { status: 4, stdout: '', stderr: 'gh auth login required\n' } }))
      .rejects.toThrow('gh repo view --json defaultBranchRef --jq .defaultBranchRef.name failed: gh auth login required')
  })
})

describe('verifyCi dispatch and report', () => {
  it('dispatches the exact head against the base, watches it and reports every check, the run URL, head SHA and merged coverage', async () => {
    const result = await verify(cleanHead(), { argv: ['--base', 'sprint/retro-run-fixes-s1'] })
    expect(result.code).toBe(0)
    expect(result.calls).toContain(`gh workflow run pr-checks.yml --ref work/dm-987 -f ref=${HEAD} -f base=sprint/retro-run-fixes-s1`)
    expect(result.watch).toEqual({ line: 'gh run watch 46184627904 --exit-status --interval 30', options: { inherit: true } })
    expect(result.calls).toContain('gh run view 46184627904 --json url,headSha,jobs')
    expect(result.output).toContain(`dispatched CI Checks for work/dm-987 at ${HEAD} (Fireguard base sprint/retro-run-fixes-s1): ${RUN_URL}`)
    expect(result.output).toContain([
      `run: ${RUN_URL}`,
      `head SHA: ${HEAD}`,
      'wall time: 60 s',
      'lint: passed', 'typecheck: passed', 'test: passed', 'coverage: passed', 'deadcode: passed', 'build: passed', 'fireguard: passed',
      'merged coverage:',
      '  statements 97.72% (60433/61837, threshold 97%)',
      '  branches 95.38% (40816/42793, threshold 95%)',
      '  functions 97.27% (18747/19272, threshold 96%)',
      '  lines 98.49% (51904/52699, threshold 97%)'
    ].join('\n'))
  })

  it('defaults the Fireguard base to main', async () => {
    const result = await verify(cleanHead())
    expect(result.calls).toContain(`gh workflow run pr-checks.yml --ref work/dm-987 -f ref=${HEAD} -f base=main`)
  })

  it('exits 1 when any check failed, naming its conclusion', async () => {
    const failed = { ...RUN_VIEW, jobs: RUN_VIEW.jobs.map((entry) => entry.name === 'fireguard' ? job('fireguard', 'failure') : entry) }
    const result = await verify(cleanHead(failed))
    expect(result.code).toBe(1)
    expect(result.output).toContain('fireguard: failed (failure)')
  })

  it('exits 1 when the run checked another head or the merged coverage is missing or below a threshold', async () => {
    expect((await verify(cleanHead({ ...RUN_VIEW, headSha: 'a'.repeat(40) }))).output).toContain(`head SHA: ${'a'.repeat(40)} (expected ${HEAD})`)
    expect((await verify(cleanHead({ ...RUN_VIEW, headSha: 'a'.repeat(40) }))).code).toBe(1)
    const missing = await verify(cleanHead(), { summary: null })
    expect(missing.code).toBe(1)
    expect(missing.output).toContain('merged coverage:\n  unavailable (no coverage-summary artifact)')
    const below = await verify(cleanHead(), { summary: { total: { ...SUMMARY.total, lines: metric(9, 10) } } })
    expect(below.code).toBe(1)
  })

  it('refuses a dispatch that names no run', async () => {
    await expect(verify({ ...cleanHead(), 'gh workflow run': '' })).rejects.toThrow('gh workflow run printed no run URL (gh 2.87 or later prints it): ')
  })
})

describe('checkResults', () => {
  it('reads each Definition of Done check plus Fireguard from its job or build step', () => {
    expect(CHECKS.map((check) => check.name)).toEqual(['lint', 'typecheck', 'test', 'coverage', 'deadcode', 'build', 'fireguard'])
    const view = { jobs: [job('lint', 'cancelled'), job('build', 'failure', [step('typecheck', 'failure'), step('build', 'skipped')]),
      { name: 'test', conclusion: '', status: 'in_progress', steps: [] }] }
    expect(checkResults(view)).toEqual([
      { name: 'lint', status: 'failed', conclusion: 'cancelled' },
      { name: 'typecheck', status: 'failed', conclusion: 'failure' },
      { name: 'test', status: 'failed', conclusion: 'unfinished' },
      { name: 'coverage', status: 'failed', conclusion: 'missing' },
      { name: 'deadcode', status: 'failed', conclusion: 'missing' },
      { name: 'build', status: 'failed', conclusion: 'skipped' },
      { name: 'fireguard', status: 'failed', conclusion: 'missing' }
    ])
  })

  it('treats a build job without the named step as missing that check', () => {
    expect(checkResults({ jobs: [job('build')] }).find((result) => result.name === 'typecheck'))
      .toEqual({ name: 'typecheck', status: 'failed', conclusion: 'missing' })
  })
})

describe('parseArgs', () => {
  it('takes an optional --base and refuses anything else', () => {
    expect(parseArgs([])).toEqual({ base: 'main' })
    expect(parseArgs(['--base', 'epic/x'])).toEqual({ base: 'epic/x' })
    for (const argv of [['--base'], ['--base', '--x'], ['--head', 'x'], ['--base', 'a', 'b']]) {
      expect(() => parseArgs(argv)).toThrow('usage: npm run verify:ci [-- --base <branch>]')
    }
  })
})

describe('the verify:ci command', () => {
  it('exits 2 with the error for bad arguments and outside a git checkout, before any gh call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-ci-cli-'))
    try {
      const usage = spawnSync(process.execPath, [SCRIPT, '--head'], { encoding: 'utf8', cwd: dir })
      expect(usage.status).toBe(2)
      expect(usage.stderr).toBe('verify:ci error: usage: npm run verify:ci [-- --base <branch>]\n')
      const env = { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() }
      const outside = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: dir, env })
      expect(outside.status).toBe(2)
      expect(outside.stderr).toMatch(/^verify:ci error: git rev-parse HEAD failed: fatal: not a git repository/)
      expect(outside.stdout).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
