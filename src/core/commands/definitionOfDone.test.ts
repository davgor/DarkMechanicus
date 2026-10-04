/** The project's Definition of Done through the command layer: read with getProject, set with setDefinitionOfDone. */
import { readFileSync } from 'node:fs'
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
