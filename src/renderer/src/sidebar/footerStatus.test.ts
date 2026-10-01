import { describe, expect, it } from 'vitest'
import { storageStatus } from '../__mocks__/fixtures'
import type { StorageStatusView } from '../../../shared/domain/views'
import {
  agentSessionCount,
  branchWarning,
  mcpFooterLine,
  storageFooterLine
} from './footerStatus'

const withRoles = (byRole: Record<string, number>): StorageStatusView =>
  storageStatus({ sessions: { active: 0, byRole } })

describe('agentSessionCount', () => {
  it('is zero without a status', () => {
    expect(agentSessionCount(null)).toBe(0)
  })

  it('ignores the desktop session', () => {
    expect(agentSessionCount(withRoles({ desktop: 1 }))).toBe(0)
  })

  it('sums every non-desktop role', () => {
    expect(agentSessionCount(withRoles({ desktop: 1, planner: 1, worker: 2 }))).toBe(3)
  })
})

describe('mcpFooterLine', () => {
  it('waits for an agent when none is connected', () => {
    expect(mcpFooterLine(null)).toEqual({ text: 'Waiting for an agent', tone: 'muted' })
    expect(mcpFooterLine(withRoles({ desktop: 1 })).text).toBe('Waiting for an agent')
  })

  it('counts connected agent sessions', () => {
    expect(mcpFooterLine(withRoles({ orchestrator: 2 }))).toEqual({
      text: '2 agent sessions · stdio',
      tone: 'ok'
    })
  })

  it('uses the singular for one session', () => {
    expect(mcpFooterLine(withRoles({ worker: 1 })).text).toBe('1 agent session · stdio')
  })
})

describe('storageFooterLine', () => {
  it('reports an uninitialized repository', () => {
    expect(storageFooterLine(null)).toEqual({ text: 'Not initialized', tone: 'muted' })
    expect(storageFooterLine(storageStatus({ initialized: false })).text).toBe('Not initialized')
  })

  it('reports failed exports with the last error', () => {
    const status = storageStatus({ outbox: { pending: 0, failed: 2, lastError: 'disk full' } })
    expect(storageFooterLine(status)).toEqual({ text: 'Export failed', tone: 'error', title: 'disk full' })
  })

  it('prefers a failed export over a pending one', () => {
    const status = storageStatus({ outbox: { pending: 3, failed: 1, lastError: null } })
    expect(storageFooterLine(status).text).toBe('Export failed')
  })

  it('reports a pending save', () => {
    const status = storageStatus({ outbox: { pending: 1, failed: 0, lastError: null } })
    expect(storageFooterLine(status)).toEqual({ text: 'Save pending', tone: 'warn' })
  })
})

describe('storageFooterLine for exported repositories', () => {
  it('counts uncommitted record files', () => {
    const line = storageFooterLine(storageStatus({ uncommittedRecordFiles: 3 }))
    expect(line).toEqual({ text: 'Exported · 3 files uncommitted', tone: 'muted' })
  })

  it('uses the singular for one file', () => {
    const line = storageFooterLine(storageStatus({ uncommittedRecordFiles: 1 }))
    expect(line.text).toBe('Exported · 1 file uncommitted')
  })

  it('says everything is committed when no files are pending', () => {
    const line = storageFooterLine(storageStatus({ uncommittedRecordFiles: 0 }))
    expect(line).toEqual({ text: 'Exported · all committed', tone: 'ok' })
  })

  it('omits the commit state when Git status is unknown', () => {
    const line = storageFooterLine(storageStatus({ uncommittedRecordFiles: null }))
    expect(line).toEqual({ text: 'Exported', tone: 'muted' })
  })
})

describe('branchWarning', () => {
  const changed = (recorded: string | null, current: string | null): StorageStatusView =>
    storageStatus({ branch: { recorded, current, changed: true, repository: true } })

  it('is null when the branch is unchanged or unknown', () => {
    expect(branchWarning(storageStatus())).toBeNull()
    expect(branchWarning(null)).toBeNull()
  })

  it('names the recorded and current branches', () => {
    expect(branchWarning(changed('main', 'feature/x'))).toBe('Branch changed: main → feature/x')
  })

  it('describes missing branch names', () => {
    expect(branchWarning(changed(null, 'feature/x'))).toBe('Branch changed: unknown → feature/x')
    expect(branchWarning(changed('main', null))).toBe('Branch changed: main → detached HEAD')
  })
})
