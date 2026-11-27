/** The `register_host` input a Skitarii Magos gets, mapped from the Windows host's OMP catalog (omp 18.20.2, 29 models). */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { chatModelOption, chatModelOptions } from '../../shared/agents/models'
import { hostCatalog } from '../schemas'
import { ompHostCatalog } from './omp'

const HOST = JSON.parse(readFileSync(fileURLToPath(new URL('../../main/agentChat/__fixtures__/omp/models.json', import.meta.url)), 'utf8')) as { models: Record<string, unknown>[] }
const OPTIONS = chatModelOptions(HOST)
const ALL_LEVELS = ['routine', 'multi_step', 'deep']
const CHEAP_LEVELS = ['routine', 'multi_step']

describe('ompHostCatalog', () => {
  it('lists exactly the nine latest models of each line, as a register_host input hostCatalog accepts unchanged', () => {
    const catalog = ompHostCatalog(OPTIONS)
    expect(catalog.models.map((model) => model.id)).toEqual([
      'anthropic/claude-fable-5-2', 'anthropic/claude-haiku-5-5', 'anthropic/claude-mythos-5-2', 'anthropic/claude-opus-5-5',
      'anthropic/claude-sonnet-5-5', 'openai-codex/gpt-6-astra', 'openai-codex/gpt-6-luna', 'openai-codex/gpt-6.1-sol',
      'openai-codex/gpt-6.1-terra'
    ])
    expect(hostCatalog.parse(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog)
    expect(catalog).toMatchObject({ hostId: 'omp', hostType: 'omp', canSelectWorkerModel: true })
    expect(catalog.tools).toEqual(['repo_read', 'repo_write', 'shell', 'browser', 'test_execution', 'network'])
  })

  it('maps each model: provider/id, its name, DM efforts, image input, context window and no skills', () => {
    expect(ompHostCatalog(OPTIONS).models.find((model) => model.id === 'anthropic/claude-opus-5-5')).toEqual({
      id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', reasoningLevels: ALL_LEVELS, efforts: ['low', 'medium', 'high'],
      modalities: ['text', 'images'], contextWindowTokens: 1_000_000, skills: [], costTier: 'normal', latencyTier: null
    })
  })
})

describe('ompHostCatalog: tiers, reasoning levels and efforts per the documented rule', () => {
  it('prices tiers by input cost per million tokens (< 1.5 low, <= 5 normal, else high) and gives low-cost models no deep reasoning', () => {
    const tiers = Object.fromEntries(ompHostCatalog(OPTIONS).models.map((model) => [model.label, [model.costTier, model.reasoningLevels]]))
    expect(tiers).toEqual({
      'Claude Fable 5.2': ['high', ALL_LEVELS],
      'Claude Haiku 5.5': ['low', CHEAP_LEVELS],
      'Claude Mythos 5.2': ['high', ALL_LEVELS],
      'Claude Opus 5.5': ['normal', ALL_LEVELS],
      'Claude Sonnet 5.5': ['normal', ALL_LEVELS],
      'GPT-6 Astra': ['high', ALL_LEVELS],
      'GPT-6 Luna': ['low', CHEAP_LEVELS],
      'GPT-6.1 Sol': ['normal', ALL_LEVELS],
      'GPT-6.1 Terra': ['low', CHEAP_LEVELS]
    })
    const priced = (input: number) => ompHostCatalog([chatModelOption({ provider: 'p', id: 'm', name: 'M 1', reasoning: true, cost: { input } })!]).models[0].costTier
    expect([priced(1.49), priced(1.5), priced(5), priced(5.01)]).toEqual(['low', 'normal', 'normal', 'high'])
  })

  it('intersects efforts with low, medium and high, and declares none for a model without thinking levels', () => {
    const model = (extra: Record<string, unknown>) => ompHostCatalog([chatModelOption({ provider: 'p', id: 'm', name: 'M 1', ...extra })!]).models[0]
    expect(model({ thinking: ['minimal', 'low', 'medium', 'high', 'xhigh'], reasoning: true }).efforts).toEqual(['low', 'medium', 'high'])
    expect(model({ thinking: { efforts: ['high', 'max', 'low'] }, reasoning: true }).efforts).toEqual(['low', 'high'])
    expect(model({ thinking: ['max'], reasoning: true }).efforts).toEqual([])
    const plain = model({ input: ['text'] })
    expect(plain).not.toHaveProperty('efforts')
    expect(plain).toMatchObject({ modalities: ['text'], reasoningLevels: ['routine'], costTier: null, contextWindowTokens: null })
    // An unpriced reasoning model is not assumed cheap.
    expect(model({ thinking: ['low'], reasoning: true })).toMatchObject({ costTier: null, reasoningLevels: ALL_LEVELS })
  })
})

describe('ompHostCatalog: the Magos model and the catalog revision', () => {
  it('adds the model the Magos runs on when it is not featured, by provider/id or bare id, and nothing it does not know', () => {
    const ids = (current: string | null) => ompHostCatalog(OPTIONS, current).models.map((model) => model.id)
    expect(ids('anthropic/claude-opus-4-8')).toHaveLength(10)
    expect(ids('anthropic/claude-opus-4-8').at(-1)).toBe('anthropic/claude-opus-4-8')
    expect(ids('claude-sonnet-4-6').at(-1)).toBe('anthropic/claude-sonnet-4-6')
    expect(ids('anthropic/claude-opus-5-5')).toEqual(ids(null))
    expect(ids('anthropic/claude-unknown-9')).toEqual(ids(null))
  })

  it('keeps the catalog revision while the models stay the same, and changes it when they change', () => {
    const revision = ompHostCatalog(OPTIONS).catalogRevision
    expect(revision).toMatch(/^omp-[0-9a-f]{8}$/)
    expect(ompHostCatalog([...OPTIONS].reverse()).catalogRevision).toBe(revision)
    expect(ompHostCatalog(OPTIONS, 'anthropic/claude-opus-4-8').catalogRevision).not.toBe(revision)
  })
})
