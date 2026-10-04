import { describe, expect, it } from 'vitest'
import type { CommandName } from '../../shared/domain/api'
import { areaServer, callTool, type McpRig, sampleId, withRig } from '../../test/mcpHarness'
import { createCannedApi, type StubApi } from '../../test/stubApi'
import { registerCheckpointTools } from './checkpoints'

const EPIC = sampleId('epic')
const RUN = sampleId('run')
const SPRINT = sampleId('sprint')
const MARKER = { marker: 'canned' }

function inRig<T>(api: StubApi, body: (rig: McpRig) => Promise<T>): Promise<T> {
  return withRig(areaServer(registerCheckpointTools), api, body)
}

const REPORT = {
  summary: 'Sprint 1 done',
  accepted: ['DM-1', 'DM-2'],
  failed: [],
  blocked: ['DM-3: waiting for credentials'],
  changes: { files: ['src/a.ts'], commits: ['abc1234'] },
  checks: [{ name: 'unit', status: 'passed', detail: '12 tests' }],
  risks: ['flaky network test'],
  followUps: [{ title: 'Add retries', body: 'Network calls need retries.' }],
  exitCriteria: [{ criterionId: 'x1', met: true, note: 'demo works' }],
  epicOutcome: { summary: 'Shipped', successCriteria: [{ criterionId: 's1', met: true, note: 'verified' }] }
}

interface Case {
  tool: string
  args: Record<string, unknown>
  method: CommandName
  input: unknown
}

const CASES: Case[] = [
  {
    tool: 'submit_sprint_report',
    args: { runId: RUN, sprintId: SPRINT, report: REPORT, idempotencyKey: 'rep-1' },
    method: 'submitSprintReport',
    input: { runId: RUN, sprintId: SPRINT, report: REPORT, idempotencyKey: 'rep-1' }
  },
  {
    tool: 'get_sprint_report',
    args: { runId: RUN },
    method: 'getSprintReport',
    input: { runId: RUN }
  },
  {
    tool: 'get_sprint_report',
    args: { runId: RUN, sprintId: SPRINT },
    method: 'getSprintReport',
    input: { runId: RUN, sprintId: SPRINT }
  },
  { tool: 'get_checkpoint', args: { runId: RUN }, method: 'getCheckpoint', input: { runId: RUN } },
  {
    tool: 'advance_sprint',
    args: { runId: RUN, idempotencyKey: 'adv-1' },
    method: 'advanceSprint',
    input: { runId: RUN, idempotencyKey: 'adv-1' }
  },
  {
    tool: 'redraft_next_sprint',
    args: { runId: RUN },
    method: 'redraftNextSprint',
    input: { runId: RUN }
  },
  { tool: 'get_run_events', args: {}, method: 'listEvents', input: {} },
  {
    tool: 'get_run_events',
    args: { runId: RUN, epicId: EPIC, sinceSeq: 41, limit: 100 },
    method: 'listEvents',
    input: { runId: RUN, epicId: EPIC, sinceSeq: 41, limit: 100 }
  }
]

describe('checkpoint tools map to the command layer', () => {
  it.each(CASES)('$tool calls $method', async ({ tool, args, method, input }) => {
    const api = createCannedApi({ [method]: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, tool, args)
      expect(outcome.isError).toBe(false)
      expect(outcome.payload).toEqual({ ok: true, data: MARKER })
      expect(api.calls).toEqual([{ name: method, input }])
    })
  })
})

describe('submit_sprint_report defaults', () => {
  it('accepts a bare summary and null epic outcome', async () => {
    const api = createCannedApi({ submitSprintReport: MARKER })
    await inRig(api, async (rig) => {
      const args = { runId: RUN, sprintId: SPRINT, report: { summary: 'ok', epicOutcome: null } }
      const outcome = await callTool(rig, 'submit_sprint_report', args)
      expect(outcome.isError).toBe(false)
      expect(api.calls).toEqual([{ name: 'submitSprintReport', input: args }])
    })
  })

  it('fills follow-up bodies and criterion notes with empty text', async () => {
    const api = createCannedApi({ submitSprintReport: MARKER })
    await inRig(api, async (rig) => {
      const report = {
        summary: 'ok',
        followUps: [{ title: 'Later' }],
        exitCriteria: [{ criterionId: 'x1', met: false }]
      }
      await callTool(rig, 'submit_sprint_report', { runId: RUN, sprintId: SPRINT, report })
      const sent = api.calls[0]?.input as { report: unknown }
      expect(sent.report).toEqual({
        summary: 'ok',
        followUps: [{ title: 'Later', body: '' }],
        exitCriteria: [{ criterionId: 'x1', met: false, note: '' }]
      })
    })
  })
})

describe('submit_sprint_report retro', () => {
  const RETRO = {
    delivered: [{ ticket: 'DM-1', demo: 'Open the board', evidence: 'commit 3f9a0d1' }],
    wentWell: ['Pairing'],
    wentPoorly: ['A flaky pipeline'],
    actions: ['Pin the runner'],
    discoveries: [{ title: 'Cache it', body: 'Reloaded on every claim', ticket: 'DM-2' }],
    leftovers: [{ ticket: 'DM-2', reason: 'Blocked' }],
    tierFit: [{ ticket: 'DM-1', verdict: 'oversized', note: 'A small model would do' }]
  }

  it('passes a retro with every section on to the command as given', async () => {
    const api = createCannedApi({ submitSprintReport: MARKER })
    await inRig(api, async (rig) => {
      const args = { runId: RUN, sprintId: SPRINT, report: { summary: 'ok', retro: RETRO } }
      const outcome = await callTool(rig, 'submit_sprint_report', args)
      expect(outcome.isError).toBe(false)
      expect(api.calls).toEqual([{ name: 'submitSprintReport', input: args }])
    })
  })

  it('fills a discovery body and a tier-fit note with empty text', async () => {
    const api = createCannedApi({ submitSprintReport: MARKER })
    await inRig(api, async (rig) => {
      const retro = { discoveries: [{ title: 'Later' }], tierFit: [{ ticket: 'DM-1', verdict: 'right_sized' }] }
      await callTool(rig, 'submit_sprint_report', { runId: RUN, sprintId: SPRINT, report: { summary: 'ok', retro } })
      const sent = api.calls[0]?.input as { report: { retro: unknown } }
      expect(sent.report.retro).toEqual({
        discoveries: [{ title: 'Later', body: '' }],
        tierFit: [{ ticket: 'DM-1', verdict: 'right_sized', note: '' }]
      })
    })
  })
})

describe('checkpoint input validation', () => {
  it.each([
    ['a report without a summary', 'submit_sprint_report', { runId: RUN, sprintId: SPRINT, report: {} }],
    ['a report with an unknown field', 'submit_sprint_report', { runId: RUN, sprintId: SPRINT, report: { summary: 's', mood: 'good' } }],
    ['a report with an invalid check status', 'submit_sprint_report', { runId: RUN, sprintId: SPRINT, report: { summary: 's', checks: [{ name: 'x', status: 'meh' }] } }],
    ['a retro with an unknown verdict', 'submit_sprint_report', { runId: RUN, sprintId: SPRINT, report: { summary: 's', retro: { tierFit: [{ ticket: 'DM-1', verdict: 'huge' }] } } }],
    ['a retro with an unknown field', 'submit_sprint_report', { runId: RUN, sprintId: SPRINT, report: { summary: 's', retro: { mood: 'good' } } }],
    ['a report for a malformed sprint id', 'submit_sprint_report', { runId: RUN, sprintId: 's1', report: { summary: 's' } }],
    ['a report without a run id', 'submit_sprint_report', { sprintId: SPRINT, report: { summary: 's' } }],
    ['advance_sprint without a run id', 'advance_sprint', {}],
    ['get_checkpoint with a malformed run id', 'get_checkpoint', { runId: 'run-1' }],
    ['get_run_events with a negative cursor', 'get_run_events', { sinceSeq: -1 }],
    ['get_run_events with a limit of zero', 'get_run_events', { limit: 0 }],
    ['get_run_events with a limit above 500', 'get_run_events', { limit: 501 }],
    ['get_run_events with a fractional cursor', 'get_run_events', { sinceSeq: 1.5 }]
  ])('rejects %s without calling the command', async (_label, tool, args) => {
    const api = createCannedApi({ submitSprintReport: MARKER, advanceSprint: MARKER, listEvents: MARKER })
    await inRig(api, async (rig) => {
      const outcome = await callTool(rig, tool, args)
      expect(outcome.isError).toBe(true)
      expect(api.calls).toEqual([])
    })
  })

  it('accepts the boundaries of the event cursor and page size', async () => {
    const api = createCannedApi({ listEvents: MARKER })
    await inRig(api, async (rig) => {
      await callTool(rig, 'get_run_events', { sinceSeq: 0, limit: 1 })
      await callTool(rig, 'get_run_events', { limit: 500 })
      expect(api.calls.map((call) => call.input)).toEqual([{ sinceSeq: 0, limit: 1 }, { limit: 500 }])
    })
  })
})

describe('checkpoint tool descriptions', () => {
  it('tells the reporter about the retro and what it holds', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const { tools } = await rig.client.listTools()
      const description = tools.find((tool) => tool.name === 'submit_sprint_report')?.description ?? ''
      expect(description).toContain('retro')
      for (const part of ['delivered', 'wentWell', 'wentPoorly', 'actions', 'discoveries', 'leftovers', 'tierFit']) {
        expect(description).toContain(part)
      }
      expect(description).toMatch(/display key/)
    })
  })

  it('lists the retro gate in the get_checkpoint conditions and says which sprints have it', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const { tools } = await rig.client.listTools()
      const description = tools.find((tool) => tool.name === 'get_checkpoint')?.description ?? ''
      expect(description).toContain('increment_merged, retro, exit_criteria')
      expect(description).toMatch(/retro needs the sprint report to include a retro/)
    })
  })

  it('says get_sprint_report adds tier facts computed from the attempts', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const { tools } = await rig.client.listTools()
      const description = tools.find((tool) => tool.name === 'get_sprint_report')?.description ?? ''
      expect(description).toContain('tierFacts')
      expect(description).toMatch(/escalated/)
    })
  })

  it('lists the increment gate right after the acceptance gate and says what it needs', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const { tools } = await rig.client.listTools()
      const description = tools.find((tool) => tool.name === 'get_checkpoint')?.description ?? ''
      expect(description).toContain('acceptance_accepted, increment_merged')
      expect(description).toMatch(/increment_merged.*squashed/)
      expect(description).toMatch(/submit_attempt/)
    })
  })

  it('lists the acceptance gate among the get_checkpoint conditions', async () => {
    await inRig(createCannedApi({}), async (rig) => {
      const { tools } = await rig.client.listTools()
      const description = tools.find((tool) => tool.name === 'get_checkpoint')?.description ?? ''
      expect(description).toContain('acceptance_accepted')
      expect(description).toContain('required_accepted, acceptance_accepted')
      expect(description).toMatch(/acceptance node/)
      expect(description).toMatch(/older plans|no acceptance node/)
    })
  })
})
