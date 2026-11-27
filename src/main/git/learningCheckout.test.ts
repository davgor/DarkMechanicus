/** DM-952: the clean-checkout preflight of apply and recovery, and its one owned untracked record, on real repositories. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplyLearningIntegrationRequest, CleanCheckoutRequirement, LearningIntegrationPlan } from '../../shared/git/learningIntegration'
import { copyGitRepo, createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { put } from '../../test/gitScratch'
import { useTemplate } from '../../test/gitTemplate'
import { applyLearningIntegration, recoverLearningIntegration } from './learningApply'
import { mintOwnedRecordAllowance } from './learningCheckout'
import { createLearningIntegrationLocks, LearningIntegrationError, type LearningIntegrationDeps } from './learningIntegration'
import { createOperationLocks } from './operationLock'
import { createGitRunner, type GitRunner } from './runner'

const runner = createGitRunner()
const cleanups: Array<() => void> = []
const CARD = 'kc_01card'
const ATTEMPT = 'ka_01attempt'
const RECORD = '.darkmechanicus/learnings/integrations/li_01record.json'
const RECORD_TEXT = '{\n  "state": "prepared"\n}\n'

beforeEach(() => isolateGitConfig(cleanups))

afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) cleanups.pop()?.()
})

function deps(platform?: NodeJS.Platform, run: GitRunner = runner): LearningIntegrationDeps {
  return { runner: run, operations: createOperationLocks(run), cards: createLearningIntegrationLocks(), ...(platform && { platform }) }
}

interface Fixture {
  repo: GitRepo
  base: string
  source: string
}

/** The guardrail trees the tests prepare on top of `base`: the default one, and each one a refusal or sibling test names. */
const GUARDRAILS: ReadonlyArray<Record<string, string>> = [
  { 'GUARDRAILS.md': 'never guess\n' },
  ...[RECORD, '.darkmechanicus/learnings', '.darkmechanicus'].map((path) => ({ [path]: 'theirs\n' })),
  ...['.DarkMechanicus/learnings', '.darkmechanicus/LEARNINGS/Integrations', '.DARKMECHANICUS/Learnings/Integrations/LI_01RECORD.JSON'].map((path) => ({ [path]: 'theirs\n' })),
  { '.darkmechanicus/learnings/integrations/li_02other.json': '{}\n', '.darkmechanicus/project.json': '{}\n' }
]

/** One fast-import commit of `files` on top of `base`, marked `:<index + 1>` under a ref outside refs/heads. */
function guardrailCommit(index: number, base: string, files: Record<string, string>): string {
  const message = 'guardrails\n'
  return [
    `commit refs/fixtures/guardrails-${index}\nmark :${index + 1}\ncommitter Test <test@example.com> 1700000000 +0000\n`,
    `data ${Buffer.byteLength(message)}\n${message}from ${base}\n`,
    ...Object.entries(files).map(([path, content]) => `M 100644 inline ${path}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
  ].join('')
}

/**
 * Built once for the file: `main` and `sprint` at `base`, `sprint` checked out, and every guardrail commit written by one
 * `git fast-import`. Each git process costs tens of milliseconds to start (a few hundred on a loaded Windows runner), and
 * building this per case started about 16 of them, so each test copies it instead and starts none.
 */
const template = useTemplate((templateCleanups) => {
  const repo = createGitRepo()
  templateCleanups.push(repo.cleanup)
  put(repo.root, 'shared.txt', 'one\n')
  repo.git('add', '--', 'shared.txt')
  repo.git('commit', '-q', '-m', 'base')
  const base = repo.rev('HEAD')
  repo.branch('sprint')
  const marks = join(repo.root, '.git', 'dm-guardrail-marks')
  execFileSync('git', ['-C', repo.root, 'fast-import', '--quiet', `--export-marks=${marks}`], {
    input: GUARDRAILS.map((files, index) => guardrailCommit(index, base, files)).join(''),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const commits = new Map(readFileSync(marks, 'utf8').trim().split('\n').map((line) => line.split(' ') as [string, string]))
  return { repo, base, sources: GUARDRAILS.map((_, index) => commits.get(`:${index + 1}`) ?? '') }
})

/**
 * A clean checkout with `sprint` checked out at `base`, a guardrail branch adding `guardrails` on top of it (so apply
 * fast-forwards), and the untracked operation record the repo-mode flush would have written: a copy of the template
 * with `learnings/DM-1/root` pointed at the guardrail commit.
 */
function fixture(guardrails: Record<string, string> = GUARDRAILS[0]!): Fixture {
  const index = GUARDRAILS.findIndex((files) => JSON.stringify(files) === JSON.stringify(guardrails))
  if (index < 0) throw new Error('Add this guardrail tree to GUARDRAILS.')
  const { repo: built, base, sources } = template()
  const repo = copyGitRepo(built)
  cleanups.push(repo.cleanup)
  const source = sources[index]!
  const branch = join(repo.root, '.git', 'refs', 'heads', 'learnings', 'DM-1', 'root')
  mkdirSync(dirname(branch), { recursive: true })
  writeFileSync(branch, source + '\n')
  put(repo.root, RECORD, RECORD_TEXT)
  return { repo, base, source }
}

function request(f: Fixture, cleanCheckout: CleanCheckoutRequirement | undefined, saved: { plan: LearningIntegrationPlan | null } = { plan: null }): ApplyLearningIntegrationRequest {
  return {
    cardId: CARD,
    attemptId: ATTEMPT,
    manifests: [{ repo: null, base: f.base, branch: 'learnings/DM-1/root', commit: f.source, passed: true, checks: [] }],
    targets: [{ repository: null, checkout: f.repo.root, branch: 'sprint' }],
    persistPrepared: async (plan) => void (saved.plan = plan),
    onApplied: async () => undefined,
    ...(cleanCheckout && { cleanCheckout })
  }
}

const allowed = (f: Fixture): CleanCheckoutRequirement => ({ record: mintOwnedRecordAllowance(f.repo.root, RECORD) })

async function refusal(promise: Promise<unknown>): Promise<LearningIntegrationError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(LearningIntegrationError)
  return error as LearningIntegrationError
}

/** What a refusal must leave exactly as it was: the target, HEAD, the index entries, the status and the record bytes. */
function untouched(f: Fixture): string {
  return JSON.stringify({
    sprint: f.repo.rev('sprint'),
    head: f.repo.git('symbolic-ref', 'HEAD'),
    stage: f.repo.git('ls-files', '--stage'),
    status: f.repo.git('status', '--porcelain=v1', '--untracked-files=all'),
    record: readFileSync(join(f.repo.root, RECORD), 'utf8')
  })
}

describe('clean checkout with the owned operation record', () => {
  it('keeps only the untracked record while the target moves, and stage, tree and HEAD match the integration exactly', async () => {
    const f = fixture()
    const saved: { plan: LearningIntegrationPlan | null } = { plan: null }
    const result = await applyLearningIntegration(deps(), request(f, allowed(f), saved))
    expect(result.state).toBe('applied')
    expect(f.repo.rev('sprint')).toBe(f.source)
    expect(f.repo.git('symbolic-ref', 'HEAD')).toBe('refs/heads/sprint')
    expect(f.repo.git('status', '--porcelain=v1', '--untracked-files=all')).toBe(`?? ${RECORD}`)
    expect(f.repo.git('ls-files', '--stage')).toBe(f.repo.git('ls-tree', '-r', '--format=%(objectmode) %(objectname) 0\t%(path)', f.source))
    expect(readFileSync(join(f.repo.root, RECORD), 'utf8')).toBe(RECORD_TEXT)
    expect(JSON.stringify(saved.plan)).not.toContain('li_01record')
  })

  it.each<[string, (f: Fixture) => void, CleanCheckoutRequirement | null]>([
    ['untracked', (f) => put(f.repo.root, 'notes.txt', 'mine\n'), null],
    ['untracked beside the record', (f) => put(f.repo.root, '.darkmechanicus/learnings/integrations/li_02other.json', '{}\n'), null],
    ['staged', (f) => (put(f.repo.root, 'staged.txt', 'staged\n'), f.repo.git('add', '--', 'staged.txt')), null],
    ['modified', (f) => put(f.repo.root, 'shared.txt', 'theirs\n'), null],
    ['strict', () => undefined, { record: null }]
  ])('refuses every other untracked, staged or modified path, and a strict requirement refuses the record too: %s', async (name, make, strict) => {
    const f = fixture()
    make(f)
    const before = untouched(f)
    const error = await refusal(applyLearningIntegration(deps(), request(f, strict ?? allowed(f))))
    expect([name, error.code]).toEqual([name, 'dirty_worktree'])
    expect(untouched(f)).toBe(before)
  })

  it('refuses a tracked or staged record: only the untracked record is the allowed case', async () => {
    const f = fixture()
    f.repo.git('add', '--', RECORD)
    const before = untouched(f)
    const staged = await refusal(applyLearningIntegration(deps(), request(f, allowed(f))))
    expect([staged.code, staged.message]).toEqual(['dirty_worktree', `${RECORD} is tracked or staged in ${f.repo.root}; only an untracked current operation record is kept. Nothing was changed.`])
    expect(untouched(f)).toBe(before)
    f.repo.git('commit', '-q', '-m', 'track the record')
    const committed = untouched(f)
    const tracked = await refusal(applyLearningIntegration(deps(), request(f, allowed(f))))
    expect(tracked.code).toBe('dirty_worktree')
    expect(untouched(f)).toBe(committed)
  })
})

describe('prepared trees that would own the record', () => {
  it.each([RECORD, '.darkmechanicus/learnings', '.darkmechanicus'])('refuses a prepared tree holding the record path or a file at one of its folders, changing nothing: %s', async (path) => {
    const f = fixture({ [path]: 'theirs\n' })
    const before = untouched(f)
    const error = await refusal(applyLearningIntegration(deps(), request(f, allowed(f))))
    expect([path, error.code]).toEqual([path, 'unsafe_path'])
    expect(error.message).toContain(`has ${path}, which would own or replace the current operation record ${RECORD}`)
    expect(untouched(f)).toBe(before)
  })

  it.each([
    ['.DarkMechanicus/learnings', '.DarkMechanicus/learnings'],
    ['.darkmechanicus/LEARNINGS/Integrations', '.darkmechanicus/LEARNINGS/Integrations'],
    ['.DARKMECHANICUS/Learnings/Integrations/LI_01RECORD.JSON', '.DARKMECHANICUS/Learnings/Integrations/LI_01RECORD.JSON']
  ])('on Windows refuses case aliases of the reserved folder, a descendant folder and the record itself: %s', async (path, owner) => {
    const f = fixture({ [path]: 'theirs\n' })
    const before = untouched(f)
    const error = await refusal(applyLearningIntegration(deps('win32'), request(f, allowed(f))))
    expect([path, error.code]).toEqual([path, 'unsafe_path'])
    expect(error.message).toContain(`has ${owner}, which would own`)
    expect(untouched(f)).toBe(before)
  })

  it('keeps the record when the prepared tree only adds siblings in its folders', async () => {
    const f = fixture({ '.darkmechanicus/learnings/integrations/li_02other.json': '{}\n', '.darkmechanicus/project.json': '{}\n' })
    await applyLearningIntegration(deps('win32'), request(f, allowed(f)))
    expect(f.repo.rev('sprint')).toBe(f.source)
    expect(f.repo.git('status', '--porcelain=v1', '--untracked-files=all')).toBe(`?? ${RECORD}`)
    expect(readFileSync(join(f.repo.root, RECORD), 'utf8')).toBe(RECORD_TEXT)
  })
})

describe('who may grant the allowance', () => {
  it('refuses a forged or serialized allowance before any Git command, for apply and recovery', async () => {
    const f = fixture()
    const saved: { plan: LearningIntegrationPlan | null } = { plan: null }
    const crashing = { ...request(f, allowed(f), saved), persistPrepared: async (plan: LearningIntegrationPlan) => ((saved.plan = plan), Promise.reject(new Error('died'))) }
    await expect(applyLearningIntegration(deps(), crashing)).rejects.toThrow('died')
    const calls: string[] = []
    const counting: GitRunner = { run: (r) => (calls.push(r.args.join(' ')), runner.run(r)) }
    const minted = mintOwnedRecordAllowance(f.repo.root, RECORD)
    const copies = [{ checkout: f.repo.root, path: RECORD }, JSON.parse(JSON.stringify(minted)) as typeof minted, { ...minted }]
    for (const record of copies) {
      const applied = await refusal(applyLearningIntegration(deps(undefined, counting), request(f, { record })))
      const recovered = await refusal(recoverLearningIntegration(deps(undefined, counting), { attemptId: ATTEMPT, plan: saved.plan as LearningIntegrationPlan, onApplied: async () => undefined, cleanCheckout: { record } }))
      expect([applied.code, recovered.code]).toEqual(['invalid_request', 'invalid_request'])
    }
    expect(calls).toEqual([])
    expect(f.repo.rev('sprint')).toBe(f.base)
  })

  it('keeps another checkout strict: the allowance names only the registered root checkout', async () => {
    const root = fixture()
    const other = fixture()
    const before = untouched(other)
    const error = await refusal(applyLearningIntegration(deps(), request(other, allowed(root))))
    expect(error.code).toBe('dirty_worktree')
    expect(error.message).toContain(RECORD)
    expect(untouched(other)).toBe(before)
  })

  it('refuses record paths that could leave the checkout or name a folder', () => {
    for (const path of ['../outside.json', '/abs.json', 'a//b.json', 'a/./b.json', 'a\\b.json', 'C:/x.json', '']) {
      expect(() => mintOwnedRecordAllowance(join(__dirname), path)).toThrow(LearningIntegrationError)
    }
    expect(() => mintOwnedRecordAllowance('relative/root', RECORD)).toThrow(LearningIntegrationError)
  })
})

describe('recovery derives the allowance again', () => {
  it('resumes a persisted plan with a freshly issued allowance, never one stored with the plan', async () => {
    const f = fixture()
    const saved: { plan: LearningIntegrationPlan | null } = { plan: null }
    const crashing = { ...request(f, allowed(f), saved), persistPrepared: async (plan: LearningIntegrationPlan) => ((saved.plan = plan), Promise.reject(new Error('died'))) }
    await expect(applyLearningIntegration(deps(), crashing)).rejects.toThrow('died')
    const plan = JSON.parse(JSON.stringify(saved.plan)) as LearningIntegrationPlan
    expect(JSON.stringify(plan)).not.toContain('li_01record')
    put(f.repo.root, 'notes.txt', 'mine\n')
    const dirty = await refusal(recoverLearningIntegration(deps(), { attemptId: ATTEMPT, plan, onApplied: async () => undefined, cleanCheckout: allowed(f) }))
    expect(dirty.code).toBe('dirty_worktree')
    expect(f.repo.rev('sprint')).toBe(f.base)
    f.repo.git('clean', '-q', '-f', '--', 'notes.txt')
    await recoverLearningIntegration(deps(), { attemptId: ATTEMPT, plan, onApplied: async () => undefined, cleanCheckout: allowed(f) })
    expect(f.repo.rev('sprint')).toBe(f.source)
    expect(f.repo.git('status', '--porcelain=v1', '--untracked-files=all')).toBe(`?? ${RECORD}`)
  })
})
