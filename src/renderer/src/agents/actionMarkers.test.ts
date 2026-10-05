import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import { actionMarker, failureDetail, markerText } from './actionMarkers'

type ToolCall = Extract<ChatItem, { kind: 'tool_call' }>

const RUN = 'rn_01k8zq3v7c2m5n9p4r6t8w0xyb'
const ATTEMPT = 'at_01k8zq4a1b2c3d4e5f6g7h8j9k'
const TICKET = 'tk_01k8zq2m3n4p5q6r7s8t9v0w1x'
const OTHER_TICKET = 'tk_01k8zq2y3z4a5b6c7d8e9f0g1h'
const EPIC = 'ep_01k8zq2a3b4c5d6e7f8g9h0j1k'

function call(name: string, input: ToolCall['input'], patch: Partial<ToolCall> = {}): ToolCall {
  return { id: 'c1', at: '2026-03-01T10:00:00.000Z', kind: 'tool_call', name, input, status: 'completed', resultSummary: null, ...patch }
}

const NONE = { epicId: null, runId: null, ticketId: null, attemptId: null, ticketKey: null }

describe('actionMarker: which calls are markers', () => {
  it('knows the Dark Mechanicus calls of Claude and of Codex, and nothing else', () => {
    expect(actionMarker(call('mcp__darkmechanicus__claim_ticket', {}))?.tool).toBe('claim_ticket')
    expect(actionMarker(call('darkmechanicus.accept_attempt', {}))?.tool).toBe('accept_attempt')
    expect(actionMarker(call('Bash', { command: 'ls' }))).toBeNull()
    expect(actionMarker(call('mcp__othermechanicus__claim_ticket', {}))).toBeNull()
    expect(actionMarker(call('claim_ticket', {}))).toBeNull()
    expect(actionMarker(call('mcp__darkmechanicus__', {}))).toBeNull()
  })
})

describe('actionMarker: what a call carries', () => {
  it('reads the ids a call names in its input, only when they are whole ids', () => {
    const claim = actionMarker(call('mcp__darkmechanicus__claim_ticket', { runId: RUN, ticketId: TICKET, worker: { label: 'W' } }))
    expect(claim?.target).toEqual({ ...NONE, runId: RUN, ticketId: TICKET })
    const accept = actionMarker(call('mcp__darkmechanicus__accept_attempt', { attemptId: ATTEMPT }))
    expect(accept?.target).toEqual({ ...NONE, attemptId: ATTEMPT })
    const bad = actionMarker(call('mcp__darkmechanicus__accept_attempt', { attemptId: `${ATTEMPT}x`, runId: 'rn_short', ticketId: 42 }))
    expect(bad?.target).toEqual(NONE)
  })

  it('never takes the secret of a claim token for an id: only the attempt id part is read, and never shown', () => {
    const marker = actionMarker(call('mcp__darkmechanicus__submit_attempt', { attemptId: ATTEMPT, claimToken: `${ATTEMPT}.Qx7vT2mN9pL4kR8sW1yZ3bC6dF0gH5jA` }))
    expect(marker?.target).toEqual({ ...NONE, attemptId: ATTEMPT })
    expect(JSON.stringify(marker)).not.toContain('Qx7vT2mN')
  })

  it('fills what the input lacks from the ids and the key in the result, when the result names one of each', () => {
    const result = `{"ok":true,"data":{"attempt":{"id":"${ATTEMPT}","runId":"${RUN}","ticketId":"${TICKET}","key":"DM-12"}}}`
    const marker = actionMarker(call('mcp__darkmechanicus__accept_attempt', { attemptId: ATTEMPT }, { resultSummary: result }))
    expect(marker?.target).toEqual({ epicId: null, runId: RUN, ticketId: TICKET, attemptId: ATTEMPT, ticketKey: 'DM-12' })
  })

  it('takes the epic of a started run from its result', () => {
    const marker = actionMarker(call('mcp__darkmechanicus__start_run', { epicId: EPIC }, { resultSummary: `{"ok":true,"data":{"id":"${RUN}","epicId":"${EPIC}","number":1}}` }))
    expect(marker?.target).toEqual({ ...NONE, epicId: EPIC, runId: RUN })
  })

  it('does not guess when a result names several tickets, attempts or keys, and prefers the input over the result', () => {
    const several = `${TICKET} ${OTHER_TICKET} "key":"DM-1" "key":"DM-2"`
    expect(actionMarker(call('mcp__darkmechanicus__get_ready_tickets', {}, { resultSummary: several }))?.target).toEqual(NONE)
    expect(actionMarker(call('mcp__darkmechanicus__claim_ticket', { ticketId: TICKET }, { resultSummary: OTHER_TICKET }))?.target.ticketId).toBe(TICKET)
  })

  it('reads a result that was cut off, which is not valid JSON', () => {
    const cut = `{"ok":true,"data":{"attempt":{"id":"${ATTEMPT}","runId":"${RUN}","ticketId":"${TICKET}","number":1,"kind":"work","state":"runn…`
    expect(actionMarker(call('mcp__darkmechanicus__claim_ticket', {}, { resultSummary: cut }))?.target).toEqual({ ...NONE, runId: RUN, ticketId: TICKET, attemptId: ATTEMPT })
  })

  it('reads no ids from a call that is still running or failed: its result is not what happened', () => {
    const marker = actionMarker(call('mcp__darkmechanicus__claim_ticket', {}, { status: 'failed', resultSummary: `{"ok":false,"error":{"details":{"ticketId":"${TICKET}"}}}` }))
    expect(marker?.target).toEqual(NONE)
  })
})

describe('markerText', () => {
  const text = (tool: string, status: ToolCall['status'], key: string | null = null): string => markerText({ tool, status }, key)

  it('says what was done to the ticket, once the call completed', () => {
    expect(text('claim_ticket', 'completed', 'DM-12')).toBe('claimed DM-12')
    expect(text('accept_attempt', 'completed', 'DM-12')).toBe('accepted DM-12')
    expect(text('reject_attempt', 'completed', 'DM-12')).toBe('rejected DM-12')
    expect(text('submit_attempt', 'completed', 'DM-12')).toBe('submitted DM-12')
    expect(text('fail_attempt', 'completed', 'DM-12')).toBe('marked DM-12 failed')
    expect(text('heartbeat_attempt', 'completed', 'DM-12')).toBe('heartbeat for DM-12')
  })

  it('says what a call that has no ticket did', () => {
    expect(text('submit_sprint_report', 'completed')).toBe('sprint report filed')
    expect(text('start_run', 'completed')).toBe('started the run')
    expect(text('advance_sprint', 'completed')).toBe('advanced the sprint')
    expect(text('get_checkpoint', 'completed')).toBe('read the checkpoint')
  })

  it('uses a neutral label while the ticket is unknown, and never an id', () => {
    expect(text('claim_ticket', 'completed')).toBe('claimed a ticket')
    expect(text('accept_attempt', 'completed')).toBe('accepted a ticket')
  })

  it('words a call that is running and one that was refused or denied', () => {
    expect(text('claim_ticket', 'running', 'DM-12')).toBe('claiming DM-12')
    expect(text('accept_attempt', 'failed', 'DM-12')).toBe('could not accept DM-12')
    expect(text('accept_attempt', 'denied', 'DM-12')).toBe('could not accept DM-12')
    expect(text('submit_sprint_report', 'failed')).toBe('sprint report refused')
  })

  it('words a tool it has no phrase for from its name, so every call still has a marker', () => {
    expect(text('list_epics', 'completed')).toBe('list epics')
    expect(text('list_epics', 'running')).toBe('list epics…')
    expect(text('list_epics', 'failed')).toBe('list epics failed')
  })
})

describe('failureDetail', () => {
  const refused = (resultSummary: string | null, status: ToolCall['status'] = 'failed'): ToolCall => call('mcp__darkmechanicus__claim_ticket', {}, { status, resultSummary })

  it('gives the message the server sent for a refused call, and nothing for a call that went through', () => {
    expect(failureDetail(refused('{"ok":false,"error":{"code":"stale_claim","message":"This claim was superseded."}}'))).toBe('This claim was superseded.')
    expect(failureDetail(refused('Declined', 'denied'))).toBe('Declined')
    expect(failureDetail(call('mcp__darkmechanicus__claim_ticket', {}, { resultSummary: 'ok' }))).toBeNull()
    expect(failureDetail(call('mcp__darkmechanicus__claim_ticket', {}, { status: 'running' }))).toBeNull()
    expect(failureDetail(refused(null))).toBeNull()
    expect(failureDetail(refused('   '))).toBeNull()
  })

  it('masks a claim token, joins lines and cuts a long text short', () => {
    expect(failureDetail(refused(`Bad token ${ATTEMPT}.Qx7vT2mN9pL4kR8sW1yZ3bC6dF0gH5jA
for the attempt`))).toBe('Bad token [claim token masked] for the attempt')
    const long = failureDetail(refused('x'.repeat(400)))
    expect(long).toHaveLength(140)
    expect(long?.endsWith('…')).toBe(true)
  })
})
