import { describe, expect, it } from 'vitest'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import {
  bundle,
  checkpointView,
  draftPlan,
  epicDetail,
  MCP_TEST,
  mcpTestEpic,
  mcpTestPlan,
  mcpTestReport,
  mcpTestRun,
  reportView,
  runView,
  savedPlan,
  sprint
} from './__mocks__/fixtures'
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
    expect(data.overview).toBe(null)
  })

  it('skips what does not exist: no saved revision, no run, no draft validation', async () => {
    const epic = epicDetail({ currentRevisionId: null, currentRevisionNumber: null, hasDraft: true })
    const backend = new FakeBackend(scenario({ epic, saved: null, draft: draftPlan(), run: null }))
    const data = await loadWorkspace(backend.runner, 'ep_1')
    expect(backend.names()).toEqual(['getEpic', 'getPlan', 'getRun', 'listTickets', 'validatePlan'])
    expect([data.saved, data.run, data.checkpoint, data.savedTickets]).toEqual([null, null, null, []])
    const plain = new FakeBackend(scenario({ run: runView({ state: 'completed' }) }))
    const saved = await loadWorkspace(plain.runner, 'ep_1')
    expect(plain.names()).toEqual(['getEpic', 'getPlan', 'getRun', 'listTickets', 'getSprintReport', 'getSprintReport', 'getSprintReport'])
    expect([saved.draft, saved.checkpoint, saved.validation, saved.draftTickets]).toEqual([null, null, null, []])
    expect(saved.overview?.reports).toEqual([])
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

describe('loadWorkspace (3)', () => {
  it('shows the revision an active run executes when a newer revision was saved', async () => {
    const epic = epicDetail({ currentRevisionId: 'rv_5', currentRevisionNumber: 5 })
    const saved = savedPlan({ revisionId: 'rv_5', revisionNumber: 5 })
    const backend = new FakeBackend(scenario({ epic, saved, run: runView({ revisionId: 'rv_4', revisionNumber: 4 }) }))
    const data = await loadWorkspace(backend.runner, 'ep_1')
    expect(backend.inputs('getPlan')).toEqual([
      { epicId: 'ep_1', view: 'saved' },
      { epicId: 'ep_1', view: 'saved', revisionId: 'rv_4' }
    ])
    expect([data.saved?.revisionId, data.saved?.revisionNumber]).toEqual(['rv_4', 4])
  })

  it('keeps the current revision once the run has finished', async () => {
    const epic = epicDetail({ currentRevisionId: 'rv_5', currentRevisionNumber: 5 })
    const saved = savedPlan({ revisionId: 'rv_5', revisionNumber: 5 })
    const run = runView({ revisionId: 'rv_4', revisionNumber: 4, state: 'canceled' })
    const backend = new FakeBackend(scenario({ epic, saved, run }))
    const data = await loadWorkspace(backend.runner, 'ep_1')
    expect(backend.inputs('getPlan')).toEqual([{ epicId: 'ep_1', view: 'saved' }])
    expect(data.saved?.revisionNumber).toBe(5)
  })
})

function notFound(): never {
  throw new Error('Plan revision rv_4 not found.')
}

describe('loadWorkspace (4)', () => {
  it('loads the overview of a completed run from the plan it ran and its sprint reports, not from a checkpoint', async () => {
    const report = mcpTestReport()
    const backend = new FakeBackend(
      scenario({ epic: mcpTestEpic(), saved: mcpTestPlan(), run: mcpTestRun(), checkpoint: null, reports: [report] })
    )
    const data = await loadWorkspace(backend.runner, MCP_TEST.epicId)
    expect(backend.names()).toEqual(['getEpic', 'getPlan', 'getRun', 'listTickets', 'getSprintReport'])
    expect(backend.inputs('getSprintReport')).toEqual([{ runId: MCP_TEST.runId, sprintId: MCP_TEST.sprintId }])
    expect(data.checkpoint).toBe(null)
    expect(data.overview).toEqual({ bundle: mcpTestPlan().bundle, reports: [report] })
  })

  it('lists sprint reports in sprint order and skips sprints without a readable report', async () => {
    const saved = savedPlan({ bundle: bundle({ sprints: [...bundle().sprints].reverse() }) })
    const run = runView({ state: 'completed', activeSprintId: null, activeSprintOrdinal: null })
    const reports = [reportView({ id: 'sr_3', sprintId: 'sp_3' }), reportView({ id: 'sr_2', sprintId: 'sp_2' }), reportView({ id: 'sr_1', sprintId: 'sp_1' })]
    const backend = new FakeBackend(scenario({ saved, run, reports }))
    backend.fail('getSprintReport', 'internal', 'Report unreadable')
    const data = await loadWorkspace(backend.runner, 'ep_1')
    expect(backend.inputs('getSprintReport')).toEqual(['sp_1', 'sp_2', 'sp_3'].map((sprintId) => ({ runId: 'rn_2', sprintId })))
    expect(data.overview?.reports.map((item) => item.id)).toEqual(['sr_2', 'sr_3'])
    const missing = new FakeBackend(scenario({ run, reports: [reportView({ sprintId: 'sp_2' })] }))
    expect((await loadWorkspace(missing.runner, 'ep_1')).overview?.reports.map((item) => item.sprintId)).toEqual(['sp_2'])
  })

})

describe('loadWorkspace (5)', () => {
  it('reads the revision a completed run executed when a newer one was saved, falling back to the current plan', async () => {
    const epic = epicDetail({ status: 'completed', currentRevisionId: 'rv_5', currentRevisionNumber: 5 })
    const saved = savedPlan({ revisionId: 'rv_5', revisionNumber: 5 })
    const ran = savedPlan({ bundle: bundle({ sprints: [sprint(1, 'Old goal', ['tk_101'])] }) })
    const run = runView({ state: 'completed', revisionId: 'rv_4', revisionNumber: 4 })
    const backend = new FakeBackend(scenario({ epic, saved, run }))
    backend.handlers.getPlan = (input: { revisionId?: string }) => (input.revisionId === 'rv_4' ? ran : saved)
    const data = await loadWorkspace(backend.runner, 'ep_1')
    expect(backend.inputs('getPlan')).toEqual([
      { epicId: 'ep_1', view: 'saved' },
      { epicId: 'ep_1', view: 'saved', revisionId: 'rv_4' }
    ])
    expect([data.saved?.revisionNumber, data.overview?.bundle?.sprints[0]?.goal]).toEqual([5, 'Old goal'])
    expect(backend.inputs('getSprintReport')).toEqual([{ runId: 'rn_2', sprintId: 'sp_1' }])
    const unreadable = new FakeBackend(scenario({ epic, saved, run }))
    unreadable.handlers.getPlan = (input: { revisionId?: string }) => (input.revisionId === 'rv_4' ? notFound() : saved)
    expect((await loadWorkspace(unreadable.runner, 'ep_1')).overview?.bundle).toBe(saved.bundle)
    expect(unreadable.inputs('getSprintReport').length).toBe(3)
  })

  it('loads no overview for runs that did not complete', async () => {
    for (const state of ['canceled', 'failed', 'paused', 'awaiting_checkpoint'] as const) {
      const backend = new FakeBackend(scenario({ run: runView({ state }) }))
      const data = await loadWorkspace(backend.runner, 'ep_1')
      expect([state, data.overview, backend.names().includes('getSprintReport')]).toEqual([state, null, false])
    }
    expect((await loadWorkspace(new FakeBackend(scenario({ run: null })).runner, 'ep_1')).overview).toBe(null)
  })
})
