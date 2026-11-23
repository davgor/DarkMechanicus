import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { DraftOp } from '../shared/domain/api'
import { baselineDeliveryPolicy } from '../shared/domain/standardsPrompts'
import { dropAcceptanceNodes } from '../test/acceptanceNodes'
import { issued } from '../test/execution'
import { copyGitRepo, createGitRepo } from '../test/gitRepo'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { bindForge } from './repo/forgeBinding'
import { FORGE_CONFIG } from './repo/forgeReference'
import { createGitAdapter } from './repo/git'
import { resolveLayout } from './repo/layout'
import type { Workspace } from './workspace'

const CODE_ORIGIN = 'https://github.com/forge-test/software.git'
const WORLD_ORIGIN = 'https://github.com/forge-test/world.git'
const BRANCH = 'codex/feature'
const CHECKS = [{ name: 'Fixture tests', status: 'passed' as const, detail: 'Passed on the integrated commit' }]
const REFERENCE = { version: 1 as const, worldRepository: WORLD_ORIGIN, projectFolder: 'Software' }

let h: Harness

beforeEach(() => { h = createHarness() })
afterEach(() => h.cleanup())

async function forgeFixture() {
  const code = createGitRepo({ root: join(h.root, 'code') })
  const world = createGitRepo({ root: join(h.root, 'world') })
  code.git('remote', 'add', 'origin', CODE_ORIGIN)
  world.git('remote', 'add', 'origin', WORLD_ORIGIN)
  const codeBase = code.commit('Independent code base')
  const worldCommit = world.commit('World-only history')
  code.branch(BRANCH)
  const workerCommit = code.commit('Worker delivery')
  const integrated = code.commit('Review and integration')
  code.switchTo('main')

  const member = join(world.root, REFERENCE.projectFolder)
  const manifest = join(world.root, 'forge-world.json')
  writeFileSync(manifest, JSON.stringify({
    version: 1, owner: 'forge-test', syncMinutes: 5, projects: [{ folder: REFERENCE.projectFolder, repository: CODE_ORIGIN }]
  }))
  mkdirSync(member)
  const git = createGitAdapter(member)
  const desktop = h.open('desktop', { root: member, git, mode: 'repo', transport: 'desktop' })
  await desktop.initializeRepository({ name: 'Forge verifier fixture' })
  await desktop.setDeliveryStandards({ expectedRevision: 0, policy: baselineDeliveryPolicy })
  const config = join(code.root, FORGE_CONFIG)
  writeFileSync(config, JSON.stringify(REFERENCE))
  bindForge(h.homeDir, code.root, member, '')
  const hint = join(resolveLayout(member).localDir, 'source-checkout.json')
  return { code, world, member, desktop, git, codeBase, workerCommit, integrated, worldCommit, config, hint, manifest }
}

async function submittedWork(f: Awaited<ReturnType<typeof forgeFixture>>, agent: Workspace, commits: string[], acceptanceNode = false) {
  const epic = await agent.createEpic({ title: 'Verify reviewed delivery' })
  const draft = await agent.getPlan({ epicId: epic.id, view: 'draft' })
  const nodeId = acceptanceNode ? draft.bundle.tickets.find((ticket) => ticket.kind === 'acceptance')?.id : undefined
  if (nodeId === undefined) await dropAcceptanceNodes(agent, epic.id)
  const ops: DraftOp[] = [
    { op: 'update_sprint', sprint: '1', patch: { goal: 'Deploy verified code-ancestry routing', deploymentVerification: 'Verify the deployed integration can accept a code-only commit.' } },
    { op: 'add_ticket', ref: 'fix', sprint: '1', ticket: { title: 'Fixture work ticket', testCases: [
      { startingCondition: 'Both local repositories exist', action: 'Verify the integration branch', expectedResult: 'Only code ancestry is accepted', verificationMethod: 'Real Git command' }
    ], acceptanceCriteria: ['Trust only the mapped code checkout'] } }
  ]
  if (nodeId !== undefined) {
    ops.push({ op: 'update_ticket', ticket: nodeId, patch: { acceptanceCriteria: [{ text: 'Mapped ancestry is verified end to end', covers: 'fix' }] } })
  }
  const plan = await agent.updatePlanDraft({ epicId: epic.id, ops })
  await agent.savePlan({ epicId: epic.id, expectedDraftRevision: plan.draftRevision })
  const run = await agent.startRun({ epicId: epic.id, branch: { name: BRANCH, repository: f.code.root, startCommit: f.codeBase } })
  const claim = issued(await agent.claimTicket({ runId: run.id, ticketId: plan.refMap.fix!, worker: { label: 'Worker' } }))
  await agent.submitAttempt({
    attemptId: claim.attempt.id, claimToken: claim.packet.claimToken,
    outputs: { summary: 'Worked on the code checkout', commits }, evidence: { checks: CHECKS }
  })
  return { attemptId: claim.attempt.id, runId: run.id, nodeId }
}

it.each(['member', 'code'] as const)('accepts valid submitted code ancestry from a granted %s session while the ticket store stays on main', async entry => {
  const f = await forgeFixture()
  const { token } = await f.desktop.issueGrant({ role: 'orchestrator', label: 'Forge ancestry verifier', allowSave: true })
  const agent = h.open('reader', { root: entry === 'member' ? f.member : f.code.root, git: f.git, transport: 'cli', grantToken: token })
  const { attemptId } = await submittedWork(f, agent, [f.workerCommit])
  const accept = (branch: string, commit: string) => agent.acceptAttempt({
    attemptId, integration: { branch, commit, verification: 'Reviewed real code history' }
  })
  await expect(accept('main', f.integrated)).rejects.toThrow('integration branch')
  await expect(accept(BRANCH, f.worldCommit)).rejects.toThrow('integration branch')
  await expect(accept(BRANCH, f.codeBase)).rejects.toThrow('integration branch')
  expect(await accept(BRANCH, f.integrated)).toMatchObject({ state: 'accepted' })
  expect(agent.repoRoot).toBe(f.member)
  expect(agent.ctx().checkout()).toEqual({ branch: f.git.head()?.branch ?? null, commit: f.git.head()?.commit ?? null })
  expect(f.world.git('branch', '--show-current')).toBe('main')
  expect(f.code.rev('HEAD')).toBe(f.codeBase)
  expect(f.world.rev('HEAD')).toBe(f.worldCommit)
})

it('refuses valid code integration when one submitted worker commit is absent from that ancestry', async () => {
  const f = await forgeFixture()
  const agent = h.open('orchestrator', { root: f.member, git: f.git })
  const { attemptId } = await submittedWork(f, agent, [f.workerCommit, f.worldCommit])
  await expect(agent.acceptAttempt({
    attemptId, integration: { branch: BRANCH, commit: f.integrated, verification: 'One commit is from the unrelated ticket world' }
  })).rejects.toThrow('integration branch')
  expect(agent.ctx().db.get('SELECT state FROM attempts WHERE id = ?', attemptId)).toEqual({ state: 'submitted' })
})

it.each(['ancestry check', 'write transaction'] as const)(
  'refuses a same-path code checkout replacement at the %s boundary', async boundary => {
    const f = await forgeFixture()
    const agent = h.open('orchestrator', { root: f.member, git: f.git })
    const { attemptId } = await submittedWork(f, agent, [f.workerCommit])
    const successor = copyGitRepo(f.code, { root: join(h.root, 'replacement') })
    const ctx = agent.ctx()
    let moved = false
    function moveCheckout(): void {
      if (moved) return
      moved = true
      renameSync(f.code.root, join(h.root, 'previous-checkout'))
      renameSync(successor.root, f.code.root)
    }
    if (boundary === 'ancestry check') {
      const adapterFor = ctx.gitFor
      ctx.gitFor = (repo) => {
        const adapter = adapterFor(repo)
        return {
          ...adapter,
          isAncestor: async (ancestor, descendant) => {
            const result = await adapter.isAncestor(ancestor, descendant)
            expect(result).toBe(true)
            moveCheckout()
            return result
          }
        }
      }
    } else {
      const tx = ctx.db.tx.bind(ctx.db)
      ctx.db.tx = (apply) => tx(() => {
        expect(ctx.db.inTransaction()).toBe(true)
        moveCheckout()
        return apply()
      })
    }
    await expect(agent.acceptAttempt({
      attemptId, integration: { branch: BRANCH, commit: f.integrated, verification: 'Code history verified before checkout replacement' }
    })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('changed during verification') })
    expect(moved).toBe(true)
    expect(ctx.db.get('SELECT state FROM attempts WHERE id = ?', attemptId)).toEqual({ state: 'submitted' })
  }
)

it.each(['missing checkout', 'wrong origin', 'wrong world origin', 'wrong reference', 'index hint', 'committed hint', 'rebound checkout', 'removed manifest'] as const)(
  'refuses a formerly valid Forge code mapping after %s', async change => {
    const f = await forgeFixture()
    const ctx = f.desktop.ctx()
    expect(ctx.gitFor(null).branchCommit(BRANCH)).toBe(f.integrated)
    switch (change) {
      case 'missing checkout':
        renameSync(f.code.root, join(h.root, 'code-moved'))
        break
      case 'wrong origin':
        f.code.git('remote', 'set-url', 'origin', 'https://github.com/forge-test/elsewhere.git')
        break
      case 'wrong world origin':
        f.world.git('remote', 'set-url', 'origin', 'https://github.com/forge-test/elsewhere.git')
        break
      case 'wrong reference':
        writeFileSync(f.config, JSON.stringify({ ...REFERENCE, worldRepository: 'https://github.com/forge-test/elsewhere.git' }))
        break
      case 'index hint':
        f.world.git('add', '--force', 'Software/.darkmechanicus/local/source-checkout.json')
        break
      case 'committed hint':
        f.world.git('add', '--force', 'Software/.darkmechanicus/local/source-checkout.json')
        f.world.git('commit', '-m', 'Improperly portable checkout hint')
        f.world.git('rm', '--cached', 'Software/.darkmechanicus/local/source-checkout.json')
        break
      case 'rebound checkout': {
        const other = join(f.world.root, 'Other')
        mkdirSync(other)
        bindForge(h.homeDir, f.code.root, other, '')
        break
      }
      case 'removed manifest':
        renameSync(f.manifest, f.manifest + '.saved')
        break
    }
    expect(() => ctx.gitFor(null)).toThrow(/Forge World|Reconnect/)
  }
)

it('records a verified acceptance increment from the code repository', async () => {
  const f = await forgeFixture()
  const agent = h.open('orchestrator', { root: f.member, git: f.git })
  const { attemptId, runId, nodeId } = await submittedWork(f, agent, [f.workerCommit], true)
  await agent.acceptAttempt({ attemptId, integration: { branch: BRANCH, commit: f.integrated, verification: 'Code commit integrated' } })
  const node = issued(await agent.claimTicket({ runId, ticketId: nodeId!, worker: { label: 'Increment verifier' } }))
  const result = await agent.submitAttempt({
    attemptId: node.attempt.id,
    claimToken: node.packet.claimToken,
    outputs: { summary: 'Verified integrated code' },
    increment: { branch: BRANCH, commit: f.integrated }
  })
  expect(result.increment).toMatchObject({ passed: true, commit: f.integrated, branch: BRANCH })
})

it('verifies a Kanban delivery against origin/main in the code checkout', async () => {
  const f = await forgeFixture()
  f.code.git('update-ref', 'refs/remotes/origin/main', f.integrated)
  f.world.git('update-ref', 'refs/remotes/origin/main', f.worldCommit)
  const card = await f.desktop.createKanbanCard({ title: 'Verify code merge' })
  await f.desktop.playKanbanCard({ cardId: card.id })
  const agent = h.open('orchestrator', { root: f.member, git: f.git })
  const claim = await agent.claimKanbanCard({ cardId: card.id })
  const submit = (commit: string) => agent.submitKanbanCard({
    attemptId: claim.attemptId, claimToken: claim.claimToken!, outputs: { summary: 'Updated the code repository' },
    evidence: { checks: CHECKS, merge: { branch: 'main', commit, pullRequest: 'https://github.com/forge-test/software/pull/1',
      checksUrl: 'https://github.com/forge-test/software/actions/runs/1' } }
  })
  await expect(submit(f.worldCommit)).rejects.toThrow('origin/main')
  expect(await submit(f.integrated)).toMatchObject({ state: 'submitted' })
})
