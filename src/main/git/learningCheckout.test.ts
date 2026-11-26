/** DM-952: the clean-checkout preflight of apply and recovery, and its one owned untracked record, on real repositories. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplyLearningIntegrationRequest, CleanCheckoutRequirement, LearningIntegrationPlan } from '../../shared/git/learningIntegration'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { put } from '../../test/gitScratch'
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

/**
 * A clean checkout with `sprint` checked out at `base`, a guardrail branch adding `guardrails` on top of it (so apply
 * fast-forwards), and the untracked operation record the repo-mode flush would have written.
 */
function fixture(guardrails: Record<string, string> = { 'GUARDRAILS.md': 'never guess\n' }): Fixture {
  const repo = createGitRepo()
  cleanups.push(repo.cleanup)
  put(repo.root, 'shared.txt', 'one\n')
  repo.git('add', '--', 'shared.txt')
  repo.git('commit', '-q', '-m', 'base')
  const base = repo.rev('HEAD')
  repo.branch('learnings/DM-1/root')
  for (const [file, content] of Object.entries(guardrails)) put(repo.root, file, content)
  repo.git('add', '--', ...Object.keys(guardrails))
  repo.git('commit', '-q', '-m', 'guardrails')
  const source = repo.rev('HEAD')
  repo.git('branch', 'sprint', base)
  repo.switchTo('sprint')
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

  it('refuses every other untracked, staged or modified path, and a strict requirement refuses the record too', async () => {
    const cases: Array<[string, (f: Fixture) => void, CleanCheckoutRequirement | null]> = [
      ['untracked', (f) => put(f.repo.root, 'notes.txt', 'mine\n'), null],
      ['untracked beside the record', (f) => put(f.repo.root, '.darkmechanicus/learnings/integrations/li_02other.json', '{}\n'), null],
      ['staged', (f) => (put(f.repo.root, 'staged.txt', 'staged\n'), f.repo.git('add', '--', 'staged.txt')), null],
      ['modified', (f) => put(f.repo.root, 'shared.txt', 'theirs\n'), null],
      ['strict', () => undefined, { record: null }]
    ]
    for (const [name, make, strict] of cases) {
      const f = fixture()
      make(f)
      const before = untouched(f)
      const error = await refusal(applyLearningIntegration(deps(), request(f, strict ?? allowed(f))))
      expect([name, error.code]).toEqual([name, 'dirty_worktree'])
      expect(untouched(f)).toBe(before)
    }
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
  it('refuses a prepared tree holding the record path or a file at one of its folders, changing nothing', async () => {
    for (const path of [RECORD, '.darkmechanicus/learnings', '.darkmechanicus']) {
      const f = fixture({ [path === '.darkmechanicus' ? '.darkmechanicus' : path]: 'theirs\n' })
      const before = untouched(f)
      const error = await refusal(applyLearningIntegration(deps(), request(f, allowed(f))))
      expect([path, error.code]).toEqual([path, 'unsafe_path'])
      expect(error.message).toContain(`has ${path}, which would own or replace the current operation record ${RECORD}`)
      expect(untouched(f)).toBe(before)
    }
  })

  it('on Windows refuses case aliases of the reserved folder, a descendant folder and the record itself', async () => {
    const aliases: Array<[string, string]> = [
      ['.DarkMechanicus/learnings', '.DarkMechanicus/learnings'],
      ['.darkmechanicus/LEARNINGS/Integrations', '.darkmechanicus/LEARNINGS/Integrations'],
      ['.DARKMECHANICUS/Learnings/Integrations/LI_01RECORD.JSON', '.DARKMECHANICUS/Learnings/Integrations/LI_01RECORD.JSON']
    ]
    for (const [path, owner] of aliases) {
      const f = fixture({ [path]: 'theirs\n' })
      const before = untouched(f)
      const error = await refusal(applyLearningIntegration(deps('win32'), request(f, allowed(f))))
      expect([path, error.code]).toEqual([path, 'unsafe_path'])
      expect(error.message).toContain(`has ${owner}, which would own`)
      expect(untouched(f)).toBe(before)
    }
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
