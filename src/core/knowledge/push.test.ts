import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTempRepo, type TempRepo } from '../../test/tempRepo'
import { nodeFs } from '../repo/nodeFs'
import type { FsAdapter } from '../repo/types'
import { withKnowledgeContext } from './push'

let repo: TempRepo

beforeEach(() => {
  repo = createTempRepo()
  mkdirSync(repo.layout.knowledgeDir, { recursive: true })
  const fact = [
    '---',
    'id: repo.push-fact',
    'type: convention',
    'title: Push fact',
    'scope.roles: [orchestrator, worker]',
    'scope.events: [ticket.claimed]',
    '---',
    '',
    'Pushed body.'
  ]
  writeFileSync(join(repo.layout.knowledgeDir, 'repo.push-fact.md'), `${fact.join('\n')}\n`)
})

afterEach(() => {
  vi.restoreAllMocks()
  repo.cleanup()
})

function core(role: 'orchestrator' | 'worker', fs: FsAdapter = nodeFs) {
  return { role, layout: repo.layout, homeDir: join(repo.outside, 'home'), fs }
}

describe('withKnowledgeContext', () => {
  it('adds the event\'s facts, without layers, for an orchestrator', async () => {
    const result = await withKnowledgeContext(core('orchestrator'), { id: 'r1' }, 'ticket.claimed')
    expect(result.id).toBe('r1')
    expect(result.context?.facts.filter((fact) => fact.layer === 'repo')).toEqual([
      { id: 'repo.push-fact', type: 'convention', title: 'Push fact', layer: 'repo', body: 'Pushed body.' }
    ])
    expect(result.context).not.toHaveProperty('layers')
  })

  it('leaves the result alone for any other role', async () => {
    const result = { id: 'r1' }
    expect(await withKnowledgeContext(core('worker'), result, 'ticket.claimed')).toBe(result)
  })

  it.each([
    ['an Error', new Error('disk gone')],
    ['a non-Error value', 'disk gone']
  ])('logs a loader failure thrown as %s and returns the result without context', async (_kind, thrown) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken = new Proxy(nodeFs, {
      get: () => () => {
        throw thrown
      }
    })
    const result = await withKnowledgeContext(core('orchestrator', broken), { id: 'r1' }, 'ticket.claimed')
    expect(result).toEqual({ id: 'r1' })
    expect(warn).toHaveBeenCalledWith('Knowledge context for ticket.claimed was left out: disk gone')
  })
})
