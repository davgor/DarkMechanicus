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
  sprint,
  transferView
} from './__mocks__/fixtures'
import { loadOverview, loadWorkspace } from './workspaceLoad'

describe('loadWorkspace (1)', () => {
  it('loads epic, saved plan, a changed draft, run, checkpoint, ticket lists and draft validation in two rounds', async () => {
    const backend = new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true, draftChanged: true }), draft: draftPlan() }))
    const data = await loadWorkspace(backend.runner, 'ep_1')
    // One round after the epic for everything whose input is known; the checkpoint needs the run.
    expect(backend.names()).toEqual([
      'getEpic',
      'getPlan',
      'getRun',
      'listTickets',
      'getPlan',
      'listTickets',
      'validatePlan',
      'getTransfer',
      'getCheckpoint'
    ])
    expect(backend.inputs('getPlan')).toEqual([
      { epicId: 'ep_1', view: 'saved' },
      { epicId: 'ep_1', view: 'draft' }
    ])
    expect(backend.inputs('getCheckpoint')).toEqual([{ runId: 'rn_2' }])
    expect(backend.inputs('validatePlan')).toEqual([{ epicId: 'ep_1', view: 'draft' }])
    expect(backend.inputs('getTransfer')).toEqual([{ epicId: 'ep_1' }])
    expect(data.transfer?.status).toBe('not_started')
    expect(data.saved?.revisionNumber).toBe(4)
    expect(data.draft?.draftRevision).toBe(7)
    expect(data.run?.id).toBe('rn_2')
    expect(data.checkpoint?.sprintOrdinal).toBe(2)
    expect([data.savedTickets.length, data.draftTickets.length]).toEqual([10, 11])
    expect(data.validation?.warnings.length).toBe(1)
  })

  it('skips what does not exist: no saved revision, no run, no draft validation', async () => {
    const epic = epicDetail({ currentRevisionId: null, currentRevisionNumber: null, hasDraft: true, draftChanged: true })
    const backend = new FakeBackend(scenario({ epic, saved: null, draft: draftPlan(), run: null }))
    const data = await loadWorkspace(backend.runner, 'ep_1')
    expect(backend.names()).toEqual(['getEpic', 'getRun', 'getPlan', 'listTickets', 'validatePlan'])
    expect([data.saved, data.run, data.checkpoint, data.savedTickets]).toEqual([null, null, null, []])
    const plain = new FakeBackend(scenario({ run: runView({ state: 'completed' }) }))
    const saved = await loadWorkspace(plain.runner, 'ep_1')
    expect(plain.names()).toEqual(['getEpic', 'getPlan', 'getRun', 'listTickets', 'getTransfer'])
    expect([saved.draft, saved.checkpoint, saved.validation, saved.draftTickets]).toEqual([null, null, null, []])
  })
})

describe('loadWorkspace with an unchanged draft', () => {
  it('reads no draft plan, draft tickets or draft validation for a draft equal to the saved plan', async () => {
    const scene = { epic: epicDetail({ hasDraft: true, draftRevision: 7, draftChanged: false }), draft: draftPlan() }
    const unchanged = new FakeBackend(scenario(scene))
    const data = await loadWorkspace(unchanged.runner, 'ep_1')
    expect(unchanged.names()).toEqual(['getEpic', 'getPlan', 'getRun', 'listTickets', 'getTransfer', 'getCheckpoint'])
    expect(unchanged.inputs('getPlan')).toEqual([{ epicId: 'ep_1', view: 'saved' }])
    expect(unchanged.inputs('listTickets')).toEqual([{ epicId: 'ep_1', view: 'saved' }])
    // The same WorkspaceData the components read when an epic has no draft loaded.
    const none = await loadWorkspace(new FakeBackend(scenario({ epic: epicDetail(), draft: null })).runner, 'ep_1')
    expect({ ...data, epic: none.epic }).toEqual(none)
    expect([data.draft, data.draftTickets, data.validation, data.epic.hasDraft]).toEqual([null, [], null, true])
    // Shown (View draft, or the remembered Draft view), the same unchanged draft is read.
    const shown = new FakeBackend(scenario(scene))
    const withDraft = await loadWorkspace(shown.runner, 'ep_1', () => true)
    expect(shown.inputs('getPlan')).toEqual([{ epicId: 'ep_1', view: 'saved' }, { epicId: 'ep_1', view: 'draft' }])
    expect(shown.inputs('validatePlan')).toEqual([{ epicId: 'ep_1', view: 'draft' }])
    expect([withDraft.draft?.draftRevision, withDraft.draftTickets.length, withDraft.validation?.warnings.length]).toEqual([7, 11, 1])
  })

  it('asks whether the draft is shown only after the epic arrives, and never for a changed draft or no draft', async () => {
    const asked: string[] = []
    const backend = new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftPlan() }))
    await loadWorkspace(backend.runner, 'ep_1', () => {
      asked.push(backend.names().join(','))
      return false
    })
    expect(asked).toEqual(['getEpic'])
    const ask = (): boolean => { throw new Error('not asked') }
    await loadWorkspace(new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true, draftChanged: true }), draft: draftPlan() })).runner, 'ep_1', ask)
    await loadWorkspace(new FakeBackend().runner, 'ep_1', ask)
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

  it('reads the transfer only when one can exist: a saved plan of an epic that is not completed', async () => {
    const open = new FakeBackend(scenario({ run: null, checkpoint: null, transfer: transferView('in_progress', 3) }))
    expect((await loadWorkspace(open.runner, 'ep_1')).transfer).toEqual(transferView('in_progress', 3))
    const completed = new FakeBackend(scenario({ epic: epicDetail({ status: 'completed' }), run: null }))
    expect((await loadWorkspace(completed.runner, 'ep_1')).transfer).toBe(null)
    expect(completed.names().includes('getTransfer')).toBe(false)
  })

  it('fails the load when the transfer cannot be read, so Start run is never offered over an open transfer', async () => {
    const backend = new FakeBackend(scenario({ run: null }))
    backend.fail('getTransfer', 'internal', 'Database is locked.')
    await expect(loadWorkspace(backend.runner, 'ep_1')).rejects.toThrow('Database is locked.')
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
    expect(backend.names()).toEqual(['getEpic', 'getPlan', 'getRun', 'listTickets'])
    const overview = await loadOverview(backend.runner, MCP_TEST.epicId, data.run, data.saved)
    expect(backend.inputs('getSprintReport')).toEqual([{ runId: MCP_TEST.runId, sprintId: MCP_TEST.sprintId }])
    expect(data.checkpoint).toBe(null)
    expect(overview).toEqual({ bundle: mcpTestPlan().bundle, reports: [report] })
  })

  it('lists sprint reports in sprint order and skips sprints without a readable report', async () => {
    const saved = savedPlan({ bundle: bundle({ sprints: [...bundle().sprints].reverse() }) })
    const run = runView({ state: 'completed', activeSprintId: null, activeSprintOrdinal: null })
    const reports = [reportView({ id: 'sr_3', sprintId: 'sp_3' }), reportView({ id: 'sr_2', sprintId: 'sp_2' }), reportView({ id: 'sr_1', sprintId: 'sp_1' })]
    const backend = new FakeBackend(scenario({ saved, run, reports }))
    backend.fail('getSprintReport', 'internal', 'Report unreadable')
    const data = await loadOverview(backend.runner, 'ep_1', run, saved)
    expect(backend.inputs('getSprintReport')).toEqual(['sp_1', 'sp_2', 'sp_3'].map((sprintId) => ({ runId: 'rn_2', sprintId })))
    expect(data?.reports.map((item) => item.id)).toEqual(['sr_2', 'sr_3'])
    const missing = new FakeBackend(scenario({ run, reports: [reportView({ sprintId: 'sp_2' })] }))
    expect((await loadOverview(missing.runner, 'ep_1', run, saved))?.reports.map((item) => item.sprintId)).toEqual(['sp_2'])
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
    const data = await loadOverview(backend.runner, 'ep_1', run, saved)
    expect(backend.inputs('getPlan')).toEqual([{ epicId: 'ep_1', view: 'saved', revisionId: 'rv_4' }])
    expect(data?.bundle?.sprints[0]?.goal).toBe('Old goal')
    expect(backend.inputs('getSprintReport')).toEqual([{ runId: 'rn_2', sprintId: 'sp_1' }])
    const unreadable = new FakeBackend(scenario({ epic, saved, run }))
    unreadable.handlers.getPlan = (input: { revisionId?: string }) => (input.revisionId === 'rv_4' ? notFound() : saved)
    expect((await loadOverview(unreadable.runner, 'ep_1', run, saved))?.bundle).toBe(saved.bundle)
    expect(unreadable.inputs('getSprintReport').length).toBe(3)
  })

  it('shows an empty overview, asking for no report, when neither the executed nor a current plan can be read', async () => {
    const run = runView({ state: 'completed', revisionId: 'rv_4', revisionNumber: 4 })
    const backend = new FakeBackend(scenario({ run }))
    backend.handlers.getPlan = () => notFound()
    expect(await loadOverview(backend.runner, 'ep_1', run, null)).toEqual({ bundle: null, reports: [] })
    expect([backend.inputs('getPlan').length, backend.inputs('getSprintReport')]).toEqual([1, []])
  })

  it('loads no overview for runs that did not complete', async () => {
    for (const state of ['canceled', 'failed', 'paused', 'awaiting_checkpoint'] as const) {
      const backend = new FakeBackend(scenario({ run: runView({ state }) }))
      const data = await loadOverview(backend.runner, 'ep_1', runView({ state }), savedPlan())
      expect(data).toBeNull()
      expect(backend.names()).toEqual([])
    }
    expect(await loadOverview(new FakeBackend().runner, 'ep_1', null, savedPlan())).toBe(null)
  })
})
