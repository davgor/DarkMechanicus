import { describe, expect, it } from 'vitest'
import type { ReconcileResultView } from '../../../shared/domain/views'
import { describeFlush, describeReconcile } from './shellMessages'

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

  it('treats rejected files as an error', () => {
    const result = reconcile({ rejected: [{ path: 'epics/x.json', message: 'bad' }] })
    expect(describeReconcile(result)).toEqual({
      tone: 'error',
      message: 'Reconciled. 1 file rejected.'
    })
  })
})
