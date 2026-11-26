import { describe, expect, it } from 'vitest'
import type { EventView } from '../../../shared/domain/views'
import { EPIC_A, eventView } from '../__mocks__/fixtures'
import { notificationRaises } from './runNotifications'

const RUN = 'rn_0000000000000000000000000a'
const SPRINT = 'sp_0000000000000000000000000a'

/** Shaped like the event `submitSprintReport` appends (src/core/services/reports.ts). */
function reportSubmitted(sprintId: unknown, reportRevision = 1): EventView {
  return eventView({ kind: 'report.submitted', epicId: EPIC_A, runId: RUN, payload: { sprintId, reportRevision } })
}

describe('notificationRaises', () => {
  it('maps a submitted sprint report to checkpoint_ready, keyed by run and sprint', () => {
    expect(notificationRaises([reportSubmitted(SPRINT)], '/a')).toEqual([{
      key: `checkpoint_ready:${RUN}:${SPRINT}`,
      request: { folder: '/a', kind: 'checkpoint_ready', epicId: EPIC_A, runId: RUN }
    }])
  })

  it('gives every revision of one sprint report the same key and a later sprint a new one', () => {
    const keys = notificationRaises([reportSubmitted(SPRINT, 1), reportSubmitted(SPRINT, 2), reportSubmitted('sp_0000000000000000000000000b')], '/a')
      .map(raise => raise.key)
    expect(keys).toEqual([`checkpoint_ready:${RUN}:${SPRINT}`, `checkpoint_ready:${RUN}:${SPRINT}`, `checkpoint_ready:${RUN}:sp_0000000000000000000000000b`])
  })

  it('maps a failed run to run_failed, keyed by run', () => {
    const failed = eventView({ kind: 'run.failed', epicId: EPIC_A, runId: RUN, payload: { reason: 'ticket failed', canceledAttempts: [] } })
    expect(notificationRaises([failed], '/b')).toEqual([{
      key: `run_failed:${RUN}`,
      request: { folder: '/b', kind: 'run_failed', epicId: EPIC_A, runId: RUN }
    }])
  })

  it('skips events missing their epic, run or sprint id', () => {
    expect(notificationRaises([
      eventView({ kind: 'run.failed', epicId: null, runId: RUN }),
      eventView({ kind: 'run.failed', epicId: EPIC_A, runId: null }),
      eventView({ kind: 'report.submitted', epicId: null, runId: RUN, payload: { sprintId: SPRINT } }),
      eventView({ kind: 'report.submitted', epicId: EPIC_A, runId: null, payload: { sprintId: SPRINT } }),
      reportSubmitted(undefined),
      reportSubmitted(''),
      reportSubmitted(7)
    ], '/a')).toEqual([])
  })

  it('skips every other kind, including the sprint.reported context id', () => {
    const kinds = ['sprint.reported', 'run.canceled', 'run.completed', 'attempt.failed', 'checkpoint.approved', 'epic.updated']
    expect(notificationRaises(kinds.map(kind => eventView({ kind, epicId: EPIC_A, runId: RUN, payload: { sprintId: SPRINT } })), '/a')).toEqual([])
  })
})
