import { describe, expect, it } from 'vitest'
import { chatRecord } from '../__mocks__/fixtures'
import { MINUTE, NOW, epicDetail, iso, runView } from './__mocks__/fixtures'
import { SIGNED_OUT_PAUSE_REASON } from '../../../shared/domain/status'
import {
  adoptNotice,
  orchestratorNote,
  resumeBlocked,
  runActions,
  runBarCounts,
  runCounts,
  runLabel,
  runPill,
  runSummary,
  signedOutNote
} from './runBarView'

describe('run bar summary', () => {
  it('describes a running run with its pinned revision, sprint, age and host', () => {
    expect(runSummary(runView(), NOW, null)).toBe(
      'Run #2 · pinned to rev 4 · Sprint 2 of 3 · started 2h 14m ago · host Claude Code'
    )
  })

  it('falls back to the creation time and omits a missing host', () => {
    const run = runView({ startedAt: null, host: null, number: 3 })
    expect(runSummary(run, NOW, null)).toBe('Run #3 · pinned to rev 4 · Sprint 2 of 3 · started 2h 20m ago')
    expect(runLabel(runView())).toBe('Run #2')
  })

  it('explains an awaiting checkpoint with the report time', () => {
    const run = runView({ state: 'awaiting_checkpoint', host: null })
    expect(runSummary(run, NOW, iso(-12 * MINUTE))).toBe(
      'Run #2 · pinned to rev 4 · Sprint 2 of 3 finished 12m ago · no work is dispatched until you decide'
    )
    expect(runSummary(run, NOW, null)).toBe(
      'Run #2 · pinned to rev 4 · Sprint 2 of 3 finished 1m ago · no work is dispatched until you decide'
    )
  })

  it('covers queued, paused and terminal runs', () => {
    const queued = runView({ state: 'queued', activeSprintOrdinal: null, startedAt: null, host: null })
    expect(runSummary(queued, NOW, null)).toBe('Run #2 · pinned to rev 4 · 3 sprints · queued 2h 20m ago')
    const paused = runView({ state: 'paused', pauseReason: 'branch changed', host: null })
    expect(runSummary(paused, NOW, null)).toBe('Run #2 · pinned to rev 4 · Sprint 2 of 3 · paused: branch changed')
    const pausedPlain = runView({ state: 'paused', host: null })
    expect(runSummary(pausedPlain, NOW, null)).toBe('Run #2 · pinned to rev 4 · Sprint 2 of 3 · paused')
    const signedOut = runView({ state: 'paused', pauseReason: SIGNED_OUT_PAUSE_REASON, host: null })
    expect(runSummary(signedOut, NOW, null)).toBe('Run #2 · pinned to rev 4 · Sprint 2 of 3 · paused')
    const done = runView({ state: 'completed', endedAt: iso(-3 * MINUTE), host: null })
    expect(runSummary(done, NOW, null)).toBe('Run #2 · pinned to rev 4 · completed 3m ago')
    const canceled = runView({ state: 'canceled', endedAt: null, host: null })
    expect(runSummary(canceled, NOW, null)).toBe('Run #2 · pinned to rev 4 · canceled 1m ago')
  })
})

describe('run bar pill and counts', () => {
  it('pairs the run state label with a tone', () => {
    expect(runPill(runView())).toEqual({ label: 'RUNNING', tone: 'running' })
    expect(runPill(runView({ state: 'awaiting_checkpoint' }))).toEqual({ label: 'AWAITING CHECKPOINT', tone: 'attention' })
  })

  it('lists non-zero counts in a fixed order', () => {
    expect(runCounts(runView().counts)).toEqual([
      { key: 'accepted', label: '4 accepted', tone: 'accepted' },
      { key: 'submitted', label: '1 in review', tone: 'review' },
      { key: 'running', label: '1 running', tone: 'running' },
      { key: 'ready', label: '1 ready', tone: 'ready' },
      { key: 'waiting', label: '3 waiting', tone: 'waiting' }
    ])
    const counts = { ...runView().counts, accepted: 0, blocked: 2, needsReconciliation: 1, failed: 1 }
    expect(runCounts(counts).map((item) => item.label)).toEqual([
      '1 in review',
      '1 running',
      '1 ready',
      '3 waiting',
      '2 blocked',
      '1 needs reconciliation',
      '1 failed'
    ])
  })
})

describe('run bar actions', () => {
  const checkpoint = { checkpoint: true, overview: false }
  const none = { checkpoint: false, overview: false }

  it('offers pause and cancel while running, resume while paused', () => {
    expect(runActions(runView(), checkpoint)).toEqual({ pause: true, resume: false, cancel: true, takeover: false, report: 'Sprint report' })
    expect(runActions(runView({ state: 'queued' }), none)).toEqual({
      pause: true,
      resume: false,
      cancel: true,
      takeover: false,
      report: null
    })
    expect(runActions(runView({ state: 'paused' }), none)).toMatchObject({ pause: false, resume: true, cancel: true })
    expect(runActions(runView({ state: 'awaiting_checkpoint' }), checkpoint)).toMatchObject({ pause: false, cancel: true })
  })

  it('offers only take over for an imported run and nothing for a finished one', () => {
    expect(runActions(runView({ ownedByThisMachine: false }), checkpoint)).toEqual({
      pause: false,
      resume: false,
      cancel: false,
      takeover: true,
      report: 'Sprint report'
    })
    expect(runActions(runView({ state: 'paused', ownedByThisMachine: false }), none)).toMatchObject({ resume: false })
    expect(runActions(runView({ state: 'completed' }), none)).toEqual({
      pause: false,
      resume: false,
      cancel: false,
      takeover: false,
      report: null
    })
    expect(runActions(runView({ state: 'failed', ownedByThisMachine: false }), none)).toMatchObject({ takeover: false })
  })

  it('offers the epic report, and nothing else, for a completed run with an overview', () => {
    expect(runActions(runView({ state: 'completed' }), { checkpoint: false, overview: true })).toEqual({
      pause: false,
      resume: false,
      cancel: false,
      takeover: false,
      report: 'Epic report'
    })
    expect(runActions(runView({ state: 'completed', ownedByThisMachine: false }), { checkpoint: false, overview: true }).report).toBe(
      'Epic report'
    )
    expect(runActions(runView({ state: 'awaiting_checkpoint' }), { checkpoint: true, overview: true }).report).toBe('Sprint report')
  })
})

describe('adopt notice', () => {
  const newer = epicDetail({ currentRevisionId: 'rv_5', currentRevisionNumber: 5 })

  it('announces a newer saved revision and enables adoption only at a checkpoint or pause', () => {
    expect(adoptNotice(runView(), newer)).toEqual({
      note: 'Rev 5 saved — adopt at the next checkpoint',
      enabled: false,
      revisionId: 'rv_5'
    })
    expect(adoptNotice(runView({ state: 'awaiting_checkpoint' }), newer)?.enabled).toBe(true)
    expect(adoptNotice(runView({ state: 'paused' }), newer)?.enabled).toBe(true)
    expect(adoptNotice(runView({ state: 'paused', ownedByThisMachine: false }), newer)?.enabled).toBe(false)
  })

  it('stays quiet when the run already uses the current revision or has ended', () => {
    expect(adoptNotice(runView(), epicDetail())).toBe(null)
    expect(adoptNotice(runView({ state: 'completed' }), newer)).toBe(null)
    expect(adoptNotice(runView(), epicDetail({ currentRevisionId: null, currentRevisionNumber: null }))).toBe(null)
  })
})

describe('run bar counts', () => {
  it('hides counts while the run waits at a checkpoint', () => {
    expect(runBarCounts(runView({ state: 'awaiting_checkpoint' }))).toEqual([])
    expect(runBarCounts(runView()).length).toBe(5)
  })
})

describe('signed-out note', () => {
  const chat = chatRecord({ id: 'chat_9', agent: 'claude', title: 'Orchestrator · Agent chats', runId: 'rn_2' })
  const paused = runView({ state: 'paused', pauseReason: SIGNED_OUT_PAUSE_REASON })
  const SIGNED_OUT = { claude: { state: 'signed_out', reason: 'Not signed in.' } } as const
  const SIGNED_IN = { claude: { state: 'signed_in', reason: 'Signed in.' } } as const

  it('says the agent signed out, links the orchestrating chat, and keeps the agent’s state for the prompt', () => {
    expect(signedOutNote(paused, chat, SIGNED_OUT)).toEqual({
      text: 'Paused: Claude Code signed out',
      agent: 'claude',
      status: SIGNED_OUT.claude,
      chat: { id: 'chat_9', title: 'Orchestrator · Agent chats' },
      signedIn: false
    })
  })

  it('knows the agent is signed in again once its status says so', () => {
    expect(signedOutNote(paused, chat, SIGNED_IN)?.signedIn).toBe(true)
  })

  it('does not know yet while the agent’s status is still being asked, or cannot be told', () => {
    expect(signedOutNote(paused, chat, {})?.signedIn).toBe(false)
    expect(signedOutNote(paused, chat, { claude: { state: 'unknown', reason: '?' } })?.signedIn).toBe(false)
  })

  it('stays general when the chat orchestrating the run is not known', () => {
    expect(signedOutNote(paused, null, SIGNED_OUT)).toEqual({
      text: 'Paused: the orchestrator’s agent signed out',
      agent: null,
      status: undefined,
      chat: null,
      signedIn: false
    })
  })

  it('belongs to a run paused for a lost sign-in and to no other', () => {
    expect(signedOutNote(runView({ state: 'paused', pauseReason: 'branch changed' }), chat, SIGNED_OUT)).toBe(null)
    expect(signedOutNote(runView({ state: 'paused' }), chat, SIGNED_OUT)).toBe(null)
    expect(signedOutNote(runView({ state: 'running', pauseReason: SIGNED_OUT_PAUSE_REASON }), chat, SIGNED_OUT)).toBe(null)
  })

  it('holds Resume back until the agent is signed in, and never for a run it does not describe or an agent it cannot name', () => {
    expect(resumeBlocked(signedOutNote(paused, chat, SIGNED_OUT))).toBe(true)
    expect(resumeBlocked(signedOutNote(paused, chat, {}))).toBe(true)
    expect(resumeBlocked(signedOutNote(paused, chat, SIGNED_IN))).toBe(false)
    expect(resumeBlocked(signedOutNote(paused, null, SIGNED_OUT))).toBe(false)
    expect(resumeBlocked(null)).toBe(false)
  })
})

describe('orchestrator note', () => {
  const chat = chatRecord({ id: 'chat_9', agent: 'codex', title: 'Orchestrator · Agent chats', runId: 'rn_2' })

  it('links the chat orchestrating an active run, whatever state the run is in', () => {
    for (const state of ['queued', 'running', 'paused', 'awaiting_checkpoint'] as const) {
      expect(orchestratorNote(runView({ state }), chat)).toEqual({
        kind: 'chat',
        chatId: 'chat_9',
        text: 'Orchestrated by Codex in',
        link: 'Orchestrator · Agent chats'
      })
    }
  })

  it('says a queued run with no chat is waiting for an orchestrator', () => {
    expect(orchestratorNote(runView({ state: 'queued' }), null)).toEqual({
      kind: 'waiting',
      text: 'Waiting for an orchestrator. An agent picks this run up with start_run.'
    })
  })

  it('has nothing to say about a run an external agent is already running, or one that has ended', () => {
    expect(orchestratorNote(runView({ state: 'running' }), null)).toBe(null)
    expect(orchestratorNote(runView({ state: 'completed' }), chat)).toBe(null)
    expect(orchestratorNote(runView({ state: 'canceled' }), null)).toBe(null)
  })
})
