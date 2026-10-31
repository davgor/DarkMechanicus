/** The project's Definition of Done through the command layer: read with getProject, set with setDefinitionOfDone. */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { prettyJson } from '../canonical'

const LINT = { name: 'lint', command: 'npm run lint', description: 'oxlint over src and scripts' }
const BUILD = { name: 'build', command: 'npm run build', description: 'electron-vite production build' }

let harness: Harness

beforeEach(async () => {
  harness = createHarness()
  await harness.open('desktop').initializeRepository({ name: 'demo-repo' })
})

afterEach(() => {
  harness.cleanup()
})

function projectText(): string {
  return readFileSync(join(harness.root, '.darkmechanicus', 'project.json'), 'utf8')
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error: unknown) {
    return (error as { code?: string }).code ?? 'thrown'
  }
}

describe('getProject', () => {
  it('reports an empty Definition of Done for a project that has none', async () => {
    expect((await harness.open('orchestrator').getProject()).definitionOfDone).toEqual([])
  })

  it('reports the checks stored in project.json, in order, to every role', async () => {
    await harness.open('planner').setDefinitionOfDone({ checks: [LINT, BUILD] })
    for (const role of ['desktop', 'planner', 'orchestrator', 'worker', 'reviewer'] as const) {
      expect((await harness.open(role).getProject()).definitionOfDone, role).toEqual([LINT, BUILD])
    }
  })

  it('keeps the rest of the project view as it was', async () => {
    const before = await harness.open('orchestrator').getProject()
    await harness.open('planner').setDefinitionOfDone({ checks: [LINT] })
    const { definitionOfDone, ...rest } = await harness.open('orchestrator').getProject()
    const { definitionOfDone: none, ...original } = before
    expect([definitionOfDone, none]).toEqual([[LINT], []])
    expect(rest).toEqual(original)
  })

  it('picks up a change made behind an open session, with no reconcile', async () => {
    const orchestrator = harness.open('orchestrator')
    expect((await orchestrator.getProject()).definitionOfDone).toEqual([])
    await harness.open('desktop').setDefinitionOfDone({ checks: [BUILD] })
    expect((await orchestrator.getProject()).definitionOfDone).toEqual([BUILD])
  })
})

describe('setDefinitionOfDone by a planner or the desktop', () => {
  it.each(['planner', 'desktop'] as const)('lets the %s replace the checks and answers with the project view', async (role) => {
    const session = harness.open(role)
    const view = await session.setDefinitionOfDone({ checks: [LINT, BUILD] })
    expect(view).toEqual(await session.getProject())
    expect(view.definitionOfDone).toEqual([LINT, BUILD])
    const replaced = await session.setDefinitionOfDone({ checks: [BUILD] })
    expect(replaced.definitionOfDone).toEqual([BUILD])
  })

  it('writes the checks into project.json in the app\'s own format, changing nothing else', async () => {
    const before = JSON.parse(projectText()) as Record<string, unknown>
    await harness.open('planner').setDefinitionOfDone({ checks: [LINT, BUILD] })
    expect(projectText()).toBe(prettyJson({ ...before, definitionOfDone: [LINT, BUILD] }))
  })

  it('fills a missing description with empty text and trims the name and command', async () => {
    const view = await harness.open('planner').setDefinitionOfDone({ checks: [{ name: ' Typecheck ', command: ' npm run typecheck ' }] })
    expect(view.definitionOfDone).toEqual([{ name: 'Typecheck', command: 'npm run typecheck', description: '' }])
  })

  it('clears the Definition of Done with an empty list, restoring the earlier project.json', async () => {
    const original = projectText()
    const planner = harness.open('planner')
    await planner.setDefinitionOfDone({ checks: [LINT] })
    expect((await planner.setDefinitionOfDone({ checks: [] })).definitionOfDone).toEqual([])
    expect(projectText()).toBe(original)
  })

  it('records who changed it and which checks it now names', async () => {
    const planner = harness.open('planner')
    await planner.setDefinitionOfDone({ checks: [LINT, BUILD] })
    const { events } = await planner.listEvents({})
    const changed = events.filter((event) => event.kind === 'project.definition_of_done_set')
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({ sessionId: planner.sessionId(), payload: { names: ['lint', 'build'] } })
  })
})

describe('setDefinitionOfDone refused', () => {
  it.each(['worker', 'reviewer', 'orchestrator'] as const)('is unauthorized for a %s, and project.json stays as it was', async (role) => {
    const original = projectText()
    expect(await codeOf(harness.open(role).setDefinitionOfDone({ checks: [LINT] }))).toBe('unauthorized')
    expect(projectText()).toBe(original)
  })

  it.each([
    ['two names that differ only in case', { checks: [LINT, { ...BUILD, name: 'LINT' }] }],
    ['a blank name', { checks: [{ ...LINT, name: '  ' }] }],
    ['a missing command', { checks: [{ name: 'lint' }] }],
    ['an unknown member of a check', { checks: [{ ...LINT, timeout: 30 }] }],
    ['an unknown member of the input', { checks: [LINT], extra: true }],
    ['no checks member', {}],
    ['more than 50 checks', { checks: Array.from({ length: 51 }, (_unused, index) => ({ ...LINT, name: `check ${index}` })) }]
  ])('rejects %s as invalid input, and project.json stays as it was', async (_label, input) => {
    const original = projectText()
    const planner = harness.open('planner') as unknown as { setDefinitionOfDone(input: unknown): Promise<unknown> }
    expect(await codeOf(planner.setDefinitionOfDone(input))).toBe('invalid_input')
    expect(projectText()).toBe(original)
  })
})

describe('setDefinitionOfDone in a single repository', () => {
  it('refuses a repo, and project.json stays as it was', async () => {
    const original = projectText()
    expect(await codeOf(harness.open('planner').setDefinitionOfDone({ checks: [LINT], repo: 'alpha' }))).toBe('invalid_input')
    expect(projectText()).toBe(original)
  })
})

function addRepo(name: string): void {
  mkdirSync(join(harness.root, name, '.git'), { recursive: true })
}

/** Replaces the single repository the outer beforeEach set up with a folder of alpha and beta. */
async function setUpFolder(): Promise<void> {
  harness.cleanup()
  harness = createHarness()
  addRepo('alpha')
  addRepo('beta')
  await harness.open('desktop').initializeRepository({ layout: 'multi_repo' })
}

describe('setDefinitionOfDone in a folder of repositories', () => {
  beforeEach(setUpFolder)

  it('sets the named repository\'s checks only, and the folder has no list of its own', async () => {
    const planner = harness.open('planner')
    await planner.setDefinitionOfDone({ checks: [LINT, BUILD], repo: 'beta' })
    const view = await planner.setDefinitionOfDone({ checks: [BUILD], repo: 'alpha' })
    expect(view.repositories).toEqual([
      { name: 'alpha', missing: false, definitionOfDone: [BUILD] },
      { name: 'beta', missing: false, definitionOfDone: [LINT, BUILD] }
    ])
    expect(view.definitionOfDone).toEqual([])
    expect(await harness.open('reader').getProject()).toEqual(view)
  })

  it('clears a repository\'s checks with an empty list', async () => {
    const planner = harness.open('planner')
    await planner.setDefinitionOfDone({ checks: [LINT], repo: 'alpha' })
    const view = await planner.setDefinitionOfDone({ checks: [], repo: 'alpha' })
    expect(view.repositories).toEqual([
      { name: 'alpha', missing: false },
      { name: 'beta', missing: false }
    ])
  })

  it('records which repository changed and the checks it now names', async () => {
    const planner = harness.open('planner')
    await planner.setDefinitionOfDone({ checks: [LINT, BUILD], repo: 'beta' })
    const { events } = await planner.listEvents({})
    const changed = events.filter((event) => event.kind === 'project.definition_of_done_set')
    expect(changed.map((event) => event.payload)).toEqual([{ repository: 'beta', names: ['lint', 'build'] }])
  })

  it('keeps each repository\'s checks through a rescan', async () => {
    await harness.open('planner').setDefinitionOfDone({ checks: [LINT], repo: 'beta' })
    addRepo('gamma')
    expect(await harness.open('orchestrator').rescanRepositories()).toEqual([
      { name: 'alpha', missing: false },
      { name: 'beta', missing: false, definitionOfDone: [LINT] },
      { name: 'gamma', missing: false }
    ])
  })
})

describe('setDefinitionOfDone in a folder of repositories refused', () => {
  beforeEach(setUpFolder)

  it.each([
    ['without repo', { checks: [LINT] }],
    ['for a repository the folder does not hold', { checks: [LINT], repo: 'gamma' }],
    ['for a repo that is not one folder name', { checks: [LINT], repo: '../alpha' }]
  ])('is refused %s, and nothing changes', async (_label, input) => {
    const planner = harness.open('planner')
    const before = await planner.getProject()
    expect(await codeOf(planner.setDefinitionOfDone(input))).toBe('invalid_input')
    expect(await planner.getProject()).toEqual(before)
  })

  it('is unauthorized for a worker', async () => {
    expect(await codeOf(harness.open('worker').setDefinitionOfDone({ checks: [LINT], repo: 'alpha' }))).toBe('unauthorized')
  })
})
