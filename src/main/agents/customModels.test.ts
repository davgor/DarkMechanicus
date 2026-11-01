/**
 * Listing the models of a custom CLI starts nothing: the confirmation promised that it runs once in an
 * empty temp folder and then only in chats, with `{folder}` the chat's folder. A built-in still asks its CLI.
 */
import { describe, expect, it, vi } from 'vitest'
import { builtInSpec, customSpec } from './__mocks__/launchSpecs'
import { CHAT_ADAPTERS } from './adapterRegistry'
import { CURATED_CLAUDE_MODELS, createClaudeAdapterDefinition } from './adapters/claude'
import { codexAdapterDefinition } from './adapters/codex'
import { fakeProcesses, fakeSdk } from './adapters/__mocks__/fakeClaudeSdk'

describe('listing the models of a custom CLI', () => {
  it('gives a custom Claude Code SDK CLI the curated list without starting it', async () => {
    const sdk = fakeSdk([{ models: [{ value: 'opus', displayName: 'Opus', description: '' }] }])
    const definition = createClaudeAdapterDefinition({ query: sdk.query, createProcesses: () => fakeProcesses(sdk.log), platform: 'linux' })

    expect(await definition.listModels(customSpec('claude', '/opt/mine', ['{folder}']))).toEqual(CURATED_CLAUDE_MODELS)
    expect(sdk.launches).toEqual([])

    expect(await definition.listModels(builtInSpec('claude', '/bin/claude'))).toEqual([{ id: 'opus', label: 'Opus' }])
    expect(sdk.launches).toHaveLength(1)
  })

  it('gives a custom Codex CLI no models (its own default) without starting it', async () => {
    const connect = vi.fn(() => {
      throw new Error('nothing should start')
    })
    const definition = codexAdapterDefinition({ connect, newId: () => 'id', now: () => 'now' })

    expect(await definition.listModels(customSpec('codex', '/opt/mine', ['app-server', '{folder}']))).toEqual([])
    expect(connect).not.toHaveBeenCalled()
  })

  it('gives a custom ACP CLI no models', async () => {
    expect(await CHAT_ADAPTERS.acp.listModels(customSpec('acp', '/opt/does-not-exist', ['{folder}']))).toEqual([])
  })
})
