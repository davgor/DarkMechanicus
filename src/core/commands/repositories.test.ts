/** A folder of repositories through the command layer: set up, read with getProject, re-detected with rescanRepositories. */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { DomainError } from '../errors'

let harness: Harness

function addRepo(name: string): void {
  mkdirSync(join(harness.root, name, '.git'), { recursive: true })
}

function removeRepo(name: string): void {
  rmSync(join(harness.root, name), { recursive: true, force: true })
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error: unknown) {
    return error instanceof DomainError ? error.code : 'thrown'
  }
}

beforeEach(() => {
  harness = createHarness()
})

afterEach(() => {
  harness.cleanup()
})

/** Sets the harness folder up as a folder of the repositories `alpha` and `beta`. */
async function setUpFolder(): Promise<void> {
  addRepo('beta')
  addRepo('alpha')
  const result = await harness.open('desktop').initializeRepository({ layout: 'multi_repo' })
  expect(result.storage.mode).toBe('db')
}

describe('a folder of repositories', () => {
  beforeEach(setUpFolder)

  it('reports its repositories in getProject', async () => {
    expect((await harness.open('reader').getProject()).repositories).toEqual([
      { name: 'alpha', missing: false },
      { name: 'beta', missing: false }
    ])
  })

  it('appends a new child repository on rescan', async () => {
    addRepo('gamma')
    const listed = await harness.open('planner').rescanRepositories()
    expect(listed).toEqual([
      { name: 'alpha', missing: false },
      { name: 'beta', missing: false },
      { name: 'gamma', missing: false }
    ])
    expect((await harness.open('reader').getProject()).repositories).toEqual(listed)
  })

  it('marks a removed repository missing and keeps it, then clears missing when it returns', async () => {
    const orchestrator = harness.open('orchestrator')
    removeRepo('alpha')
    expect(await orchestrator.rescanRepositories()).toEqual([
      { name: 'alpha', missing: true },
      { name: 'beta', missing: false }
    ])
    removeRepo('beta')
    expect(await orchestrator.rescanRepositories()).toEqual([
      { name: 'alpha', missing: true },
      { name: 'beta', missing: true }
    ])
    addRepo('alpha')
    expect(await orchestrator.rescanRepositories()).toEqual([
      { name: 'alpha', missing: false },
      { name: 'beta', missing: true }
    ])
  })
})

describe('a folder of repositories rescanned', () => {
  beforeEach(setUpFolder)

  it('records the added and missing names in the event log', async () => {
    const planner = harness.open('planner')
    removeRepo('beta')
    addRepo('delta')
    await planner.rescanRepositories()
    const { events } = await planner.listEvents({})
    const rescans = events.filter((event) => event.kind === 'project.repositories_rescanned')
    expect(rescans).toHaveLength(1)
    expect(rescans[0]).toMatchObject({ sessionId: planner.sessionId(), payload: { added: ['delta'], missing: ['beta'] } })
  })

  it.each(['reader', 'worker', 'reviewer'] as const)('refuses a %s, changing nothing', async (role) => {
    addRepo('gamma')
    expect(await codeOf(harness.open(role).rescanRepositories())).toBe('unauthorized')
    expect((await harness.open('reader').getProject()).repositories?.map((entry) => entry.name)).toEqual(['alpha', 'beta'])
  })
})

describe('a single repository', () => {
  beforeEach(async () => {
    addRepo('alpha')
    await harness.open('desktop').initializeRepository({ name: 'demo' })
  })

  it('reports no repositories in getProject', async () => {
    expect((await harness.open('reader').getProject()).repositories).toBeNull()
  })

  it('refuses a rescan with invalid_input', async () => {
    expect(await codeOf(harness.open('planner').rescanRepositories())).toBe('invalid_input')
    expect((await harness.open('reader').getProject()).repositories).toBeNull()
  })
})

describe('initializeRepository with multi_repo through the command layer', () => {
  it('refuses repo mode', async () => {
    addRepo('alpha')
    expect(await codeOf(harness.open('desktop').initializeRepository({ layout: 'multi_repo', mode: 'repo' }))).toBe(
      'invalid_input'
    )
  })
})
