import { describe, expect, it } from 'vitest'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import { checkpointView, draftPlan, epicDetail, runView } from './__mocks__/fixtures'
import { loadWorkspace } from './workspaceLoad'

describe('loadWorkspace (1)', () => {
  it('loads epic, saved plan, draft, run, checkpoint, ticket lists and draft validation', async () => {
    const backend = new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftPlan() }))
    const data = await loadWorkspace(backend.runner, 'ep_1')
    expect(backend.names()).toEqual([
      'getEpic',
      'getPlan',
      'getPlan',
      'getRun',
      'getCheckpoint',
      'listTickets',
      'listTickets',
      'validatePlan'
    ])
    expect(backend.inputs('getPlan')).toEqual([
      { epicId: 'ep_1', view: 'saved' },
      { epicId: 'ep_1', view: 'draft' }
    ])
    expect(backend.inputs('getCheckpoint')).toEqual([{ runId: 'rn_2' }])
    expect(backend.inputs('validatePlan')).toEqual([{ epicId: 'ep_1', view: 'draft' }])
    expect(data.saved?.revisionNumber).toBe(4)
    expect(data.draft?.draftRevision).toBe(7)
    expect(data.run?.id).toBe('rn_2')
    expect(data.checkpoint?.sprintOrdinal).toBe(2)
    expect([data.savedTickets.length, data.draftTickets.length]).toEqual([10, 11])
    expect(data.validation?.warnings.length).toBe(1)
  })

  it('skips what does not exist: no saved revision, no run, no draft validation', async () => {
    const epic = epicDetail({ currentRevisionId: null, currentRevisionNumber: null, hasDraft: true })
    const backend = new FakeBackend(scenario({ epic, saved: null, draft: draftPlan(), run: null }))
    const data = await loadWorkspace(backend.runner, 'ep_1')
    expect(backend.names()).toEqual(['getEpic', 'getPlan', 'getRun', 'listTickets', 'validatePlan'])
    expect([data.saved, data.run, data.checkpoint, data.savedTickets]).toEqual([null, null, null, []])
    const plain = new FakeBackend(scenario({ run: runView({ state: 'completed' }) }))
    const saved = await loadWorkspace(plain.runner, 'ep_1')
    expect(plain.names()).toEqual(['getEpic', 'getPlan', 'getRun', 'listTickets'])
    expect([saved.draft, saved.checkpoint, saved.validation, saved.draftTickets]).toEqual([null, null, null, []])
  })
})

describe('loadWorkspace (2)', () => {
  it('loads the checkpoint of an awaiting run and tolerates a checkpoint read failure', async () => {
    const waiting = new FakeBackend(scenario({ run: runView({ state: 'awaiting_checkpoint' }) }))
    expect((await loadWorkspace(waiting.runner, 'ep_1')).checkpoint?.runId).toBe('rn_2')
    const embedded = checkpointView({ sprintOrdinal: 1 })
    const failing = new FakeBackend(scenario({ run: runView({ checkpoint: embedded }) }))
    failing.fail('getCheckpoint', 'run_not_active', 'Run is not active')
    expect((await loadWorkspace(failing.runner, 'ep_1')).checkpoint).toBe(embedded)
    const paused = new FakeBackend(scenario({ run: runView({ state: 'paused' }) }))
    await loadWorkspace(paused.runner, 'ep_1')
    expect(paused.names().includes('getCheckpoint')).toBe(false)
  })

  it('propagates a failure to load the epic', async () => {
    const backend = new FakeBackend()
    backend.fail('getEpic', 'not_found', 'Epic ep_1 not found.')
    await expect(loadWorkspace(backend.runner, 'ep_1')).rejects.toThrow('Epic ep_1 not found.')
  })
})
