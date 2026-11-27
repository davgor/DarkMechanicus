import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AGENT_KINDS } from '../desktop/agentKinds'
import { agentModels, chatModelOption, chatModelOptions, featuredModels, isSafeModelId, providerLabel, type ChatModelOption } from './models'

describe('agentModels', () => {
  it('offers Claude Code the curated list: its own default first, then its aliases', () => {
    expect(agentModels('claude')).toEqual({
      kind: 'list',
      models: [
        { id: 'default', label: 'Default (recommended)' },
        { id: 'opus', label: 'Opus' },
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'haiku', label: 'Haiku' }
      ]
    })
  })

  it('lets Autonomous take a typed model, OMP list its own catalog, and leaves Codex, Cursor and a custom CLI to pick their own', () => {
    expect([agentModels('autonomous'), agentModels('omp'), agentModels('codex'), agentModels('cursor'), agentModels('custom')]).toEqual([
      { kind: 'free' },
      { kind: 'catalog' },
      { kind: 'cli' },
      { kind: 'cli' },
      { kind: 'cli' }
    ])
  })

  it('lists only ids that may go on a command line', () => {
    for (const kind of AGENT_KINDS) {
      const models = agentModels(kind)
      if (models.kind === 'list') {
        expect(models.models.every((model) => isSafeModelId(model.id))).toBe(true)
      }
    }
  })
})

describe('isSafeModelId', () => {
  it('accepts plain and parameterised model ids and nothing that cmd.exe or an option parser would act on', () => {
    expect(isSafeModelId('gpt-5.4[reasoning=medium,fast=false]')).toBe(true)
    expect(isSafeModelId('claude-4.5-sonnet')).toBe(true)
    expect(isSafeModelId('anthropic/claude-haiku-5-5')).toBe(true)
    expect(isSafeModelId('a & b')).toBe(false)
    expect(isSafeModelId('--force')).toBe(false)
    expect(isSafeModelId('')).toBe(false)
    expect(isSafeModelId('x'.repeat(200))).toBe(true)
    expect(isSafeModelId('x'.repeat(201))).toBe(false)
  })
})

type RawModel = { provider: string; id: string; name: string; identity: { revision: string }; thinking: { efforts: string[] } } & Record<string, unknown>
/** The Windows host's `get_available_models` reply (omp 18.20.2, 29 models), redacted: what a live session answers. */
const HOST = JSON.parse(readFileSync(fileURLToPath(new URL('../../main/agentChat/__fixtures__/omp/models.json', import.meta.url)), 'utf8')) as { models: RawModel[] }
/** The same catalog as `omp models --json` prints it without a session: no `identity`, `thinking` a plain list. */
function sessionless(models: readonly RawModel[]): { models: Record<string, unknown>[] } {
  return { models: models.map(({ identity: _identity, thinking, ...model }) => ({ ...model, selector: `${model.provider}/${model.id}`, thinking: thinking.efforts })) }
}
const names = (options: readonly ChatModelOption[]): string[] => options.map((option) => option.name)
const LATEST = ['Claude Fable 5.2', 'Claude Haiku 5.5', 'Claude Mythos 5.2', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-6 Astra', 'GPT-6 Luna', 'GPT-6.1 Sol', 'GPT-6.1 Terra']

describe('chatModelOptions', () => {
  it('normalizes a catalog entry with its line, revision, efforts, image input and context window', () => {
    const options = chatModelOptions(HOST)
    expect(options).toHaveLength(29)
    expect(options.find((option) => option.id === 'claude-opus-5-5')).toEqual({
      provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5', line: 'opus', revision: '5.5',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'], images: true, contextWindow: 1_000_000
    })
    expect(options.find((option) => option.id === 'gpt-6-astra')).toMatchObject({ line: 'gpt astra', revision: '6' })
    expect(options.find((option) => option.id === 'gpt-6.1-terra')).toMatchObject({ line: 'gpt terra', revision: '6.1' })
  })

  it('gives the same options from a live session and from `omp models --json` for the same catalog', () => {
    expect(chatModelOptions(sessionless(HOST.models))).toEqual(chatModelOptions(HOST))
  })

  it('drops entries whose provider and id may not go on a command line together, and anything that is not a catalog', () => {
    const base = HOST.models[0]
    for (const unsafe of [{ id: 'a & b' }, { id: '--force' }, { id: '' }, { provider: 'evil/provider' }, { provider: 'bad provider' }, { id: 'x'.repeat(300) }]) {
      expect(chatModelOption({ ...base, ...unsafe }), JSON.stringify(unsafe)).toBeNull()
    }
    expect(chatModelOptions({ models: [{ ...base, id: 'claude"&calc' }, base] }).map((option) => option.id)).toEqual([base.id])
    expect([chatModelOptions(null), chatModelOptions({ models: 'none' }), chatModelOptions([base])]).toEqual([[], [], []])
  })

  it('keeps only well-formed efforts and a positive whole context window', () => {
    const option = chatModelOption({ provider: 'p', id: 'm', name: 'M 1', thinking: ['low', 'HIGH; rm', 3], contextWindow: -1 })
    expect(option).toMatchObject({ efforts: ['low'], contextWindow: null, images: false, line: 'm', revision: '1' })
  })
})

describe('featuredModels', () => {
  it('features exactly the latest of each line on the host catalog, Claude first, and puts the other 20 under More by provider', () => {
    const { featured, more } = featuredModels(chatModelOptions(HOST))
    expect(names(featured)).toEqual(LATEST)
    expect(more.map((group) => [group.provider, group.label, group.models.length])).toEqual([['anthropic', 'Claude', 16], ['openai-codex', 'Codex', 4]])
    expect(more.flatMap((group) => group.models)).toHaveLength(20)
  })

  it('groups the sessionless catalog, which has no identity, the same way', () => {
    expect(featuredModels(chatModelOptions(sessionless(HOST.models)))).toEqual(featuredModels(chatModelOptions(HOST)))
  })

  it('lets a newer release replace its line with no code change', () => {
    const opus6 = { ...HOST.models.find((model) => model.id === 'claude-opus-5-5')!, id: 'claude-opus-6', name: 'Claude Opus 6', identity: { class: 'anthropic', family: 'opus', revision: '6.0.0' } }
    const { featured, more } = featuredModels(chatModelOptions({ models: [...HOST.models, opus6] }))
    expect(names(featured)).toEqual(LATEST.map((name) => (name === 'Claude Opus 5.5' ? 'Claude Opus 6' : name)))
    expect(more[0].models.map((option) => option.id)).toContain('claude-opus-5-5')
    // Sessionless, the revision comes from the name.
    expect(names(featuredModels(chatModelOptions(sessionless([...HOST.models, opus6]))).featured)).toContain('Claude Opus 6')
  })

  it('never features a dated snapshot, even as the only or the newest model of its line', () => {
    const dated = { ...HOST.models.find((model) => model.id === 'claude-haiku-5-5')!, id: 'claude-haiku-9-9-20990101', name: 'Claude Haiku 9.9', identity: { class: 'anthropic', family: 'haiku', revision: '9.9.0' } }
    const { featured, more } = featuredModels(chatModelOptions({ models: [...HOST.models, dated] }))
    expect(featured.some((option) => /-\d{8}$/.test(option.id))).toBe(false)
    expect(names(featured)).toEqual(LATEST)
    expect(more[0].models.map((option) => option.id)).toEqual(expect.arrayContaining(['claude-haiku-9-9-20990101', 'claude-haiku-4-5-20251001', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929']))
  })

  it('orders Anthropic first, then the other providers alphabetically, each by line, whatever the catalog order', () => {
    const extra = [
      { provider: 'zeta', id: 'z-2', name: 'Zed 2' },
      { provider: 'alpha', id: 'a-1', name: 'Alpha 1' }
    ]
    const options = chatModelOptions({ models: [...extra, ...[...HOST.models].reverse()] })
    const { featured, more } = featuredModels(options)
    expect(featured.map((option) => option.provider)).toEqual(['anthropic', 'anthropic', 'anthropic', 'anthropic', 'anthropic', 'alpha', 'openai-codex', 'openai-codex', 'openai-codex', 'openai-codex', 'zeta'])
    expect(names(featured).filter((name) => LATEST.includes(name))).toEqual(LATEST)
    expect(more.map((group) => group.label)).toEqual(['Claude', 'Codex'])
  })

  it('labels Claude and Codex, and any other provider by its own name', () => {
    expect([providerLabel('anthropic'), providerLabel('openai-codex'), providerLabel('openrouter')]).toEqual(['Claude', 'Codex', 'openrouter'])
  })
})
