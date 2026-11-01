import { describe, expect, it } from 'vitest'
import type { ReconcileResultView } from '../../../shared/domain/views'
import { boardImport, boardOpenEpic, EPIC_A, EPIC_B } from '../__mocks__/fixtures'
import { describeBoardImport, describeClaudeConnect, describeEpicConflictChoice, describeFlush, describeReconcile } from './shellMessages'

describe('describeFlush', () => {
  it('reports an export failure as an error with the first reason', () => {
    expect(describeFlush({ flushed: 2, failed: 1, errors: ['disk full', 'other'] })).toEqual({
      tone: 'error',
      message: 'Export failed for 1 item: disk full'
    })
  })

  it('pluralizes failed items and tolerates a missing reason', () => {
    expect(describeFlush({ flushed: 0, failed: 3, errors: [] })).toEqual({
      tone: 'error',
      message: 'Export failed for 3 items'
    })
  })

  it('says when nothing was pending', () => {
    expect(describeFlush({ flushed: 0, failed: 0, errors: [] })).toEqual({
      tone: 'info',
      message: 'Nothing pending to export.'
    })
  })

  it('reports how many changes were exported', () => {
    expect(describeFlush({ flushed: 1, failed: 0, errors: [] })).toEqual({
      tone: 'success',
      message: 'Exported 1 pending change.'
    })
    expect(describeFlush({ flushed: 4, failed: 0, errors: [] }).message).toBe('Exported 4 pending changes.')
  })
})

const reconcile = (patch: Partial<ReconcileResultView> = {}): ReconcileResultView => ({
  imported: [],
  unchanged: [],
  conflicts: [],
  profileConflicts: [],
  kanbanConflicts: [],
  rejected: [],
  branchChanged: false,
  pausedRuns: [],
  ...patch
})

describe('describeReconcile', () => {
  it('reports an up-to-date repository', () => {
    expect(describeReconcile(reconcile())).toEqual({
      tone: 'info',
      message: 'Reconciled. Already up to date.'
    })
  })

  it('counts imported records', () => {
    expect(describeReconcile(reconcile({ imported: ['a', 'b'] }))).toEqual({
      tone: 'info',
      message: 'Reconciled. 2 records imported.'
    })
  })

  it('lists conflicts and paused runs', () => {
    const result = reconcile({
      imported: ['a'],
      conflicts: [{ epicId: 'ep_1', message: 'both changed' }],
      pausedRuns: ['rn_1', 'rn_2']
    })
    expect(describeReconcile(result).message).toBe(
      'Reconciled. 1 record imported. 1 conflict to resolve. 2 runs paused.'
    )
  })

  it('counts profile conflicts with epic conflicts', () => {
    const profile = { name: 'ui', message: 'changed on two machines' }
    expect(describeReconcile(reconcile({ profileConflicts: [profile] }))).toEqual({
      tone: 'info',
      message: 'Reconciled. 1 conflict to resolve.'
    })
    const both = reconcile({ conflicts: [{ epicId: 'ep_1', message: 'both changed' }], profileConflicts: [profile] })
    expect(describeReconcile(both).message).toBe('Reconciled. 2 conflicts to resolve.')
  })

  it('treats rejected files as an error', () => {
    const result = reconcile({ rejected: [{ path: 'epics/x.json', message: 'bad' }] })
    expect(describeReconcile(result)).toEqual({
      tone: 'error',
      message: 'Reconciled. 1 file rejected.'
    })
  })
})

describe('describeEpicConflictChoice', () => {
  it('names the side that survived, how many unwritten saves keeping the tracked records dropped, and why local waits', () => {
    const view = { epicId: 'ep_1', abandonedRevisionIds: [], error: null }
    expect(describeEpicConflictChoice({ ...view, kept: 'local' })).toEqual({
      tone: 'success',
      message: "Wrote this machine's records of the epic over the tracked ones."
    })
    expect(describeEpicConflictChoice({ ...view, kept: 'local', error: 'disk full' })).toEqual({
      tone: 'error',
      message: "Kept this machine's records of the epic; writing them failed and is retried on every flush: disk full"
    })
    expect(describeEpicConflictChoice({ ...view, kept: 'tracked' }).message).toBe('Imported the tracked records of the epic and dropped its local changes.')
    expect(describeEpicConflictChoice({ ...view, kept: 'tracked', abandonedRevisionIds: ['rv_1', 'rv_2'] }).message).toBe(
      'Imported the tracked records of the epic and dropped its local changes. 2 unwritten saves dropped; the draft stays.'
    )
  })
})

describe('describeClaudeConnect', () => {
  it('confirms each kind of write', () => {
    expect(describeClaudeConnect({ outcome: 'created' })).toEqual({
      tone: 'success',
      message: 'Created .mcp.json for Claude Code.'
    })
    expect(describeClaudeConnect({ outcome: 'added' })).toEqual({
      tone: 'success',
      message: 'Added the darkmechanicus server to .mcp.json.'
    })
    expect(describeClaudeConnect({ outcome: 'replaced' })).toEqual({
      tone: 'success',
      message: 'Replaced the darkmechanicus entry in .mcp.json.'
    })
  })

  it('says when nothing needed writing', () => {
    expect(describeClaudeConnect({ outcome: 'unchanged' })).toEqual({
      tone: 'info',
      message: '.mcp.json already connects Claude Code with these settings.'
    })
  })

  it('says a different entry was kept and where to replace it', () => {
    expect(describeClaudeConnect({ outcome: 'conflict', existing: '{}' })).toEqual({
      tone: 'info',
      message:
        '.mcp.json already has a different darkmechanicus entry, so it was left as it is. Replace it from the MCP card on the folder home.'
    })
  })

  it('passes on why the file could not be read, as an error', () => {
    expect(describeClaudeConnect({ outcome: 'invalid', message: '.mcp.json is not valid JSON.' })).toEqual({
      tone: 'error',
      message: '.mcp.json is not valid JSON.'
    })
  })
})

describe('describeBoardImport', () => {
  const created = boardOpenEpic({ state: 'created', epicId: EPIC_A })
  const earlier = boardOpenEpic({ boardId: '021', state: 'imported', epicId: EPIC_B })

  it('says how many epics were created as drafts and that they wait for Save', () => {
    expect(describeBoardImport(boardImport({ open: [created] }))).toEqual({
      tone: 'success',
      message: 'Imported 1 epic from board/ as a draft. Review it and press Save.'
    })
    expect(describeBoardImport(boardImport({ open: [created, { ...created, boardId: '022' }] }))).toEqual({
      tone: 'success',
      message: 'Imported 2 epics from board/ as drafts. Review them and press Save.'
    })
  })

  it('mentions the epics an earlier import already brought in', () => {
    expect(describeBoardImport(boardImport({ open: [created, earlier] }))).toEqual({
      tone: 'success',
      message: 'Imported 1 epic from board/ as a draft. Review it and press Save. Skipped 1 epic imported before.'
    })
  })

  it('says when nothing new was imported', () => {
    expect(describeBoardImport(boardImport({ open: [earlier] }))).toEqual({
      tone: 'info',
      message: 'Nothing new to import from board/: every open epic was imported before.'
    })
    expect(describeBoardImport(boardImport({ open: [] }))).toEqual({
      tone: 'info',
      message: 'Nothing to import from board/: every epic on the board is done.'
    })
  })
})
