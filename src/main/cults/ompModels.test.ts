import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AgentProbeDeps, ProbeLaunch, ProcessOutcome } from '../desktop/agentProbe'
import { cheapest, createOmpModelCatalog, parseOmpModels, tierOf, type CultModelOption } from './ompModels'

/** The investigation's recordings (docs/design/cults.md, section 4): omp 19.2.1, signed in to anthropic only. */
const MODELS_JSON = readFileSync(fileURLToPath(new URL('./__fixtures__/omp-models.json', import.meta.url)), 'utf8')
const USAGE_JSON = readFileSync(fileURLToPath(new URL('./__fixtures__/omp-usage.json', import.meta.url)), 'utf8')
const SIGNED_OUT_USAGE = '{"reports":[],"accountsWithoutUsage":[],"disabledCredentials":[],"capacity":{}}\n'
const OMP_PATH = '/home/me/.local/bin/omp'

interface RecordedModel {
  provider: string
  selector: string
  [key: string]: unknown
}
/** Our own checked-in recording, so its shape is known; the module under test validates it at runtime. */
const RECORDED_DOCUMENT = JSON.parse(MODELS_JSON) as { models: RecordedModel[] }
const RECORDED = RECORDED_DOCUMENT.models

/** The recording plus a signed-out provider's model and unsafe ids for the signed-in provider. */
const MIXED_JSON = JSON.stringify({
  models: [
    ...RECORDED,
    { ...RECORDED[5], provider: 'openai-codex', id: 'gpt-5-mini', selector: 'openai-codex/gpt-5-mini', name: 'GPT-5 mini' },
    { ...RECORDED[5], id: 'bad', selector: 'anthropic/haiku & calc.exe', name: 'Unsafe ampersand' },
    { ...RECORDED[5], id: 'flag', selector: '--dangerous', name: 'Unsafe flag' },
    { ...RECORDED[5], id: 'quote', selector: 'anthropic/"haiku"', name: 'Unsafe quote' }
  ]
})

type Outcomes = Partial<Record<'usage' | 'models', ProcessOutcome>>

function exited(output: string, exitCode = 0): ProcessOutcome {
  return { kind: 'exited', exitCode, output }
}

function world(outcomes: Outcomes, inspect: 'ok' | 'not_a_file' = 'ok'): { launches: ProbeLaunch[]; deps: AgentProbeDeps } {
  const launches: ProbeLaunch[] = []
  const deps: AgentProbeDeps = {
    platform: 'linux',
    inspect: () => inspect,
    run: (launch) => {
      launches.push(launch)
      const outcome = outcomes[launch.args[0] as 'usage' | 'models']
      return Promise.resolve(outcome ?? { kind: 'spawn_failed', code: 'ENOENT', message: 'unexpected command' })
    }
  }
  return { launches, deps }
}

async function listWith(outcomes: Outcomes, inspect?: 'ok' | 'not_a_file') {
  const { launches, deps } = world(outcomes, inspect)
  const list = await createOmpModelCatalog({ ompPath: () => OMP_PATH, deps }).list()
  return { list, launches }
}

const tiersOf = (options: readonly CultModelOption[]): string[] => options.map((option) => option.tier)

describe('the recorded fixtures list signed-in models, cheapest tier first', () => {
  it('lists the anthropic models, low then normal then high, by label within a tier', async () => {
    const { list, launches } = await listWith({ usage: exited(USAGE_JSON), models: exited(MODELS_JSON) })

    expect(list.reason).toBeNull()
    expect(launches.map((launch) => [launch.file, ...launch.args])).toEqual([
      [OMP_PATH, 'usage', '--json'],
      [OMP_PATH, 'models', '--json']
    ])
    expect(list.options.every((option) => option.provider === 'anthropic')).toBe(true)
    expect(list.options).toHaveLength(21)
    expect(list.options.map((option) => option.id).slice(0, 3)).toEqual([
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-haiku-4-5-20251001',
      'anthropic/claude-haiku-5-5'
    ])
    expect(tiersOf(list.options)).toEqual([...Array(3).fill('low'), ...Array(6).fill('normal'), ...Array(12).fill('high')])
    const labels = list.options.filter((option) => option.tier === 'normal').map((option) => option.label)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)))
    expect(cheapest(list.options)).toEqual({
      id: 'anthropic/claude-haiku-4-5',
      provider: 'anthropic',
      label: 'Claude Haiku 4.5',
      tier: 'low'
    })
  })

  it('excludes a provider that is not signed in (apple and openai-codex here)', () => {
    const options = parseOmpModels(MIXED_JSON, ['anthropic']) ?? []

    expect(options.some((option) => option.provider !== 'anthropic')).toBe(false)
    expect(options.map((option) => option.id)).not.toContain('apple/on-device')
    expect(options.map((option) => option.id)).not.toContain('openai-codex/gpt-5-mini')
  })

  it('never returns an id that fails isSafeModelId', () => {
    const ids = (parseOmpModels(MIXED_JSON, ['anthropic', 'openai-codex']) ?? []).map((option) => option.id)

    expect(ids).toHaveLength(22)
    expect(ids).toContain('openai-codex/gpt-5-mini')
    expect(ids).not.toContain('anthropic/haiku & calc.exe')
    expect(ids).not.toContain('--dangerous')
    expect(ids).not.toContain('anthropic/"haiku"')
  })
})

describe('the tier comes only from declared pricing', () => {
  it.each([
    [0.5, 'fixed', 'low'],
    [5, 'fixed', 'low'],
    [5.01, 'fixed', 'normal'],
    [24.99, 'fixed', 'normal'],
    [25, 'fixed', 'high'],
    [0, 'unknown', 'unpriced']
  ] as const)('output %d with pricing %s is %s', (output, pricingStatus, tier) => {
    expect(tierOf({ cost: { output }, pricingStatus })).toBe(tier)
  })

  it('lists an unpriced model last and never picks it as the cheapest', () => {
    const options = parseOmpModels(MODELS_JSON, ['apple']) ?? []

    expect(tiersOf(options)).toEqual(['unpriced'])
    expect(cheapest(options)).toBeNull()
    expect(tiersOf(parseOmpModels(MODELS_JSON, ['apple', 'anthropic']) ?? []).at(-1)).toBe('unpriced')
  })
})

describe('OMP missing or signed out lists nothing, with a reason and no fallback', () => {
  it.each<[string, Outcomes, 'ok' | 'not_a_file']>([
    ['OMP is not installed (spawn ENOENT)', { usage: { kind: 'spawn_failed', code: 'ENOENT', message: 'missing' } }, 'ok'],
    ['the OMP path is not a file', {}, 'not_a_file'],
    ['OMP is signed out', { usage: exited(SIGNED_OUT_USAGE), models: exited(MODELS_JSON) }, 'ok'],
    ['OMP sign-in times out', { usage: { kind: 'timed_out' }, models: exited(MODELS_JSON) }, 'ok'],
    ['models command fails', { usage: exited(USAGE_JSON), models: exited('boom', 1) }, 'ok'],
    ['models output unrecognised', { usage: exited(USAGE_JSON), models: exited('not json') }, 'ok']
  ])('%s', async (_name, outcomes, inspect) => {
    const { list, launches } = await listWith(outcomes, inspect)

    expect(list.options).toEqual([])
    expect(list.reason).toMatch(/\S/)
    expect(cheapest(list.options)).toBeNull()
    if (outcomes.usage?.kind !== 'exited' || outcomes.usage.output === SIGNED_OUT_USAGE) {
      expect(launches.some((launch) => launch.args[0] === 'models')).toBe(false)
    }
  })

  it('OMP not connected runs nothing', async () => {
    const { launches, deps } = world({ usage: exited(USAGE_JSON), models: exited(MODELS_JSON) })
    const list = await createOmpModelCatalog({ ompPath: () => null, deps }).list()

    expect(list).toEqual({ options: [], reason: 'OMP is not connected, so no model can be offered.' })
    expect(launches).toEqual([])
  })

  it.each<[string, ProcessOutcome, string]>([
    ['times out', { kind: 'timed_out' }, 'OMP did not list its models in time.'],
    ['fails to start with a code', { kind: 'spawn_failed', code: 'EACCES', message: 'denied' }, 'OMP did not start (EACCES).'],
    ['fails to start without a code', { kind: 'spawn_failed', code: null, message: 'gone' }, 'OMP did not start.'],
    ['lists only providers it is not signed in for', exited(JSON.stringify({ models: RECORDED.filter((model) => model.provider !== 'anthropic') })), 'OMP lists no usable model for the providers it is signed in for.']
  ])('the models command %s: nothing, with its own reason', async (_name, models, reason) => {
    const { list } = await listWith({ usage: exited(USAGE_JSON), models })

    expect(list).toEqual({ options: [], reason })
  })

  it('refuses the models command when the OMP path stopped being a file after sign-in was checked', async () => {
    const { launches, deps } = world({ usage: exited(USAGE_JSON), models: exited(MODELS_JSON) })
    let inspections = 0
    const list = await createOmpModelCatalog({ ompPath: () => OMP_PATH, deps: { ...deps, inspect: () => (++inspections === 1 ? 'ok' : 'not_a_file') } }).list()

    expect(list.options).toEqual([])
    expect(list.reason).toMatch(/\S/)
    expect(launches.map((launch) => launch.args[0])).toEqual(['usage'])
  })

  it('leaves out an entry that is not a model and keeps the rest', () => {
    const options = parseOmpModels(JSON.stringify({ models: [{ provider: 'anthropic', selector: 'anthropic/broken' }, 'text', ...RECORDED] }), ['anthropic']) ?? []

    expect(options).toHaveLength(21)
    expect(options.map((option) => option.id)).not.toContain('anthropic/broken')
  })
})

describe('the catalog caches the list', () => {
  it('asks once, again on refresh, and again when the sign-in state changes', async () => {
    const outcomes: Outcomes = { usage: exited(USAGE_JSON), models: exited(MODELS_JSON) }
    const { launches, deps } = world(outcomes)
    const catalog = createOmpModelCatalog({ ompPath: () => OMP_PATH, deps })

    expect((await catalog.list()).options).toHaveLength(21)
    await catalog.list()
    catalog.signInChanged('signed_in')
    await catalog.list()
    expect(launches).toHaveLength(2)

    await catalog.refresh()
    expect(launches).toHaveLength(4)

    outcomes.usage = exited(SIGNED_OUT_USAGE)
    catalog.signInChanged('signed_out')
    expect((await catalog.list()).options).toEqual([])
    expect(launches).toHaveLength(5)
  })

  it('keeps the newest listing when an older one settles after it, and still drops it on a sign-in change', async () => {
    const { launches, deps } = world({ usage: exited(USAGE_JSON), models: exited(MODELS_JSON) })
    const catalog = createOmpModelCatalog({ ompPath: () => OMP_PATH, deps })

    const [first, second] = await Promise.all([catalog.list(), catalog.refresh()])
    expect(first.options).toHaveLength(21)
    expect(second.options).toHaveLength(21)
    expect(launches).toHaveLength(4)

    catalog.signInChanged('signed_in')
    await catalog.list()
    expect(launches).toHaveLength(4)
    catalog.signInChanged('signed_out')
    await catalog.list()
    expect(launches).toHaveLength(6)
  })
})
