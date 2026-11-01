/** The acceptance node's execution packet carries the project's Definition of Done, so its worker knows what to run. */
import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { ClaimResultView, DefinitionOfDoneCheck } from '../../shared/domain/views'
import { makeBundle, tid } from '../../test/bundles'
import { claim, startedRun, submitClaim } from '../../test/execution'
import { createStubGit } from '../../test/repoEnv'
import { createTestCtx } from '../../test/testContext'
import { acceptAttempt } from './attempts'

const DEFINITION: DefinitionOfDoneCheck[] = [
  { name: 'lint', command: 'npm run lint', description: 'oxlint over src and scripts' },
  { name: 'fireguard', command: 'npm run fireguard', description: 'Graded from the sprint Fireguard ticket' },
  { name: 'build', command: 'npm run build', description: '' }
]

/** Sprint = {DM-1, DM-2}; DM-2 is the acceptance node, which requires DM-1. */
function plan(): PlanBundle {
  const bundle = makeBundle([[1, 2]])
  bundle.tickets = bundle.tickets.map((ticket) => (ticket.id === tid(2) ? { ...ticket, kind: 'acceptance' as const } : ticket))
  return bundle
}

/** The packets of the work ticket and, once that is accepted, of the acceptance node. */
function packets(definition: DefinitionOfDoneCheck[]): { work: ClaimResultView['packet']; node: ClaimResultView['packet'] } {
  const ctx = createTestCtx({ definitionOfDone: definition })
  const { runId } = startedRun(ctx, { bundle: plan() })
  const work = claim(ctx, runId, 1)
  submitClaim(ctx, work)
  acceptAttempt(ctx, { attemptId: work.attempt.id })
  return { work: work.packet, node: claim(ctx, runId, 2).packet }
}

describe('the execution packet of a sprint acceptance node', () => {
  it('lists every Definition of Done check with its name, command and description, in order', () => {
    expect(packets(DEFINITION).node.definitionOfDone).toEqual(DEFINITION)
  })

  it('tells the worker to report each check by name, and what the checkpoint does with them', () => {
    const { instructions } = packets(DEFINITION).node.reporting
    expect(instructions).toContain('evidence.checks')
    expect(instructions).toContain('definition_of_done')
    expect(instructions).toContain('submit_attempt')
  })

  it('names no Definition of Done when the project has none, and says nothing more than for a work ticket', () => {
    const { work, node } = packets([])
    expect(Object.keys(node)).not.toContain('definitionOfDone')
    expect(node.reporting).toEqual(work.reporting)
  })
})

describe('the execution packet of a work ticket', () => {
  it('does not carry the Definition of Done: that belongs to the acceptance node', () => {
    const { work } = packets(DEFINITION)
    expect(Object.keys(work)).not.toContain('definitionOfDone')
    expect(work.reporting.instructions).not.toContain('definition_of_done')
  })
})

const LINT = DEFINITION[0]
const BUILD = DEFINITION[2]
const HEADS: Record<string, string> = { api: '2'.repeat(40), web: '3'.repeat(40), docs: '4'.repeat(40) }

/**
 * api, web and docs, where `lists` gives each repository's checks; a stray folder-level list is ignored. Sprint =
 * {DM-1 api, DM-2 web, DM-3 docs (optional, never claimed), DM-4 node}; DM-1 and DM-2 are accepted.
 */
function folderPackets(lists: Record<string, DefinitionOfDoneCheck[]>): { work: ClaimResultView['packet']; node: ClaimResultView['packet'] } {
  const ctx = createTestCtx({
    projectRoot: '/folder',
    repositories: Object.keys(HEADS),
    repositoryDefinitionOfDone: lists,
    definitionOfDone: [BUILD],
    gitFor: (repo) => {
      const head = repo === null ? undefined : HEADS[repo]
      if (head === undefined) {
        throw new Error(`No repository ${String(repo)}`)
      }
      return { ...createStubGit(), head: () => ({ branch: 'main', commit: head, detached: false }), branchCommit: () => null }
    }
  })
  const base = makeBundle([[1, 2, 3, 4]])
  const repos = ['api', 'web', 'docs']
  const bundle: PlanBundle = {
    ...base,
    tickets: base.tickets.map((ticket, index) => {
      const repo = repos[index]
      if (repo === undefined) {
        return { ...ticket, kind: 'acceptance' as const }
      }
      return { ...ticket, repo, title: `${repo} - ${ticket.title}`, optional: repo === 'docs' }
    })
  }
  const { runId } = startedRun(ctx, { bundle, branch: { repository: null, name: 'epic/multi', startCommit: null } })
  const [work, web] = [claim(ctx, runId, 1), claim(ctx, runId, 2)]
  for (const claimed of [work, web]) {
    submitClaim(ctx, claimed)
    acceptAttempt(ctx, { attemptId: claimed.attempt.id })
  }
  return { work: work.packet, node: claim(ctx, runId, 4).packet }
}

describe('the execution packet of a sprint acceptance node in a folder of repositories', () => {
  it('carries each touched repository\'s checks on its entry, and none for one without a list or an untouched one', () => {
    const { node } = folderPackets({ api: [LINT, BUILD], docs: [LINT] })
    expect(node.repositories?.map((repository) => [repository.name, repository.definitionOfDone])).toEqual([
      ['api', [LINT, BUILD]],
      ['web', undefined]
    ])
    expect(Object.keys(node.repositories?.[1] ?? {})).not.toContain('definitionOfDone')
  })

  it('has no folder-level Definition of Done, and tells the worker to report checks as "<repository name>: <check name>"', () => {
    const { node } = folderPackets({ web: [LINT] })
    expect(Object.keys(node)).not.toContain('definitionOfDone')
    expect(node.reporting.instructions).toContain('"<repository name>: <check name>"')
    expect(node.reporting.instructions).toContain('definition_of_done')
  })

  it('says nothing more than the plain reporting text when no touched repository has a list', () => {
    const { node } = folderPackets({ docs: [LINT] })
    expect(node.reporting.instructions).not.toContain('definition_of_done')
    expect(node.repositories?.every((repository) => repository.definitionOfDone === undefined)).toBe(true)
  })

  it('leaves a work ticket\'s repository without checks', () => {
    const { work } = folderPackets({ api: [LINT], web: [LINT] })
    expect(work.repository?.name).toBe('api')
    expect(Object.keys(work.repository ?? {})).not.toContain('definitionOfDone')
    expect(work.reporting.instructions).not.toContain('definition_of_done')
  })
})
