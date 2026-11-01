import { describe, expect, it } from 'vitest'
import { AGENT_KINDS } from '../desktop/agentKinds'
import { agentModels, isSafeModelId } from './models'

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

  it('lets Autonomous take a typed model, and leaves Codex, Cursor and a custom CLI to pick their own', () => {
    expect([agentModels('autonomous'), agentModels('codex'), agentModels('cursor'), agentModels('custom')]).toEqual([
      { kind: 'free' },
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
