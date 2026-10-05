import { describe, expect, it } from 'vitest'
import { attempt, draftPlan, runView, savedPlan } from '../epic/__mocks__/fixtures'
import { buildGraphModel, type GraphInput, type TicketNodeModel } from './graphModel'

function input(patch: Partial<GraphInput> = {}): GraphInput {
  return { plan: savedPlan(), mode: 'saved', run: runView(), statuses: new Map(), outcome: null, rejected: null, draftNumber: 5, ...patch }
}

function workingOf(patch: Partial<GraphInput> = {}): [string, string | null][] {
  return buildGraphModel(input(patch))
    .nodes.filter((item): item is TicketNodeModel => item.kind === 'ticket')
    .map((item) => [item.ticketKey, item.working])
}

describe('tickets being worked on in the graph', () => {
  it('names the open attempt on the ticket node whose latest attempt is running', () => {
    const working = workingOf().filter(([, attemptId]) => attemptId !== null)
    expect(working).toEqual([['DM-202', 'at_202_2']])
  })

  it('names a claimed attempt too, and leaves a submitted one out', () => {
    const run = runView({ attempts: [attempt('DM-204', 1, 'claimed'), attempt('DM-201', 1, 'submitted')] })
    expect(workingOf({ run }).filter(([, attemptId]) => attemptId !== null)).toEqual([['DM-204', 'at_204_1']])
  })

  it('names nothing once the latest attempt has closed', () => {
    const run = runView({ attempts: [attempt('DM-202', 1, 'running'), attempt('DM-202', 2, 'failed')] })
    expect(workingOf({ run }).every(([, attemptId]) => attemptId === null)).toBe(true)
  })

  it('names nothing without a run, or in the Draft view', () => {
    expect(workingOf({ run: null }).every(([, attemptId]) => attemptId === null)).toBe(true)
    expect(workingOf({ mode: 'draft', plan: draftPlan() }).every(([, attemptId]) => attemptId === null)).toBe(true)
  })
})
