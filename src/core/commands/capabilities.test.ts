import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CommandName } from '../../shared/domain/api'
import { defaultCapabilityProfile } from '../../shared/domain/bundle'
import type { SessionRole } from '../../shared/domain/views'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { capabilitiesForRole, HUMAN_ONLY_CAPABILITIES } from '../authz'
import { DomainError } from '../errors'
import { encodeBase32, ID_PREFIXES, type IdKind } from '../ids'
import type { Workspace } from '../workspace'
import { COMMAND_CAPABILITIES } from './capabilities'

function probeId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${encodeBase32(7n, 26)}`
}

const EPIC = probeId('epic')
const RUN = probeId('run')
const TICKET = probeId('ticket')
const ATTEMPT = probeId('attempt')
const TOKEN = `${ATTEMPT}.secret`
const CARD = probeId('kanbanCard')
const CARD_ATTEMPT = probeId('kanbanAttempt')
const CARD_TOKEN = `${CARD_ATTEMPT}.secret`

/** One schema-valid usage report an agent may send. */
const PROBE_REPORT = {
  metric: 'tokens_input',
  unit: 'tokens',
  source: { kind: 'host', actor: 'probe-host' },
  measurement: { state: 'observed', value: 1 },
  accumulation: 'delta',
  eventId: 'probe-1',
  observedAt: '2026-03-01T10:00:00.000Z'
}

/**
 * One schema-valid input per command. Ids point at nothing, so a permitted call stops at a
 * `not_found` (or succeeds harmlessly) right after its authorization check.
 */
const PROBES: Record<CommandName, unknown> = {
  nameChat: { title: 'Semantic probe title' },
  recoverTooling: { action: 'status', incidentId: 'probe-incident' },
  getCapabilities: undefined,
  getProject: undefined,
  setDefinitionOfDone: { checks: [] },
  rescanRepositories: undefined,
  initializeRepository: {},
  getStorageStatus: undefined,
  switchStorageMode: { mode: 'db', confirmed: true },
  flushPortableState: undefined,
  reconcileRepository: undefined,
  resolveEpicConflict: { epicId: EPIC, keep: 'tracked' },
  searchHistory: { query: 'probe' },
  listBranchEpics: undefined,
  backupDatabase: {},
  listSessions: undefined,
  issueGrant: { role: 'reader', label: 'CLI' },
  listGrants: undefined,
  revokeGrant: { grantId: 'gr_00000000000000000000000001' },
  renewGrant: { grantId: 'gr_00000000000000000000000001', minutes: 60 },
  listEpics: undefined,
  createEpic: { title: 'Probe epic' },
  getEpic: { epicId: EPIC },
  setEpicStatus: { epicId: EPIC, status: 'in_progress' },
  setEpicBranch: { epicId: EPIC, branch: { repository: null, name: 'feature/probe', startCommit: null } },
  deleteEpic: { epicId: EPIC },
  previewBoardImport: undefined,
  importBoard: {},
  getPlan: { epicId: EPIC, view: 'draft' },
  openDraft: { epicId: EPIC },
  updatePlanDraft: { epicId: EPIC, ops: [{ op: 'set_rationale', rationale: 'probe' }] },
  validatePlan: { epicId: EPIC, view: 'draft' },
  savePlan: { epicId: EPIC, expectedDraftRevision: 0 },
  discardPlanDraft: { epicId: EPIC },
  listRevisions: { epicId: EPIC },
  listTickets: { epicId: EPIC, view: 'saved' },
  getTicket: { epicId: EPIC, ticketId: TICKET, view: 'saved' },
  setTicketStatus: { ticketId: TICKET, status: 'in_progress' },
  deleteTicket: { epicId: EPIC, ticketId: TICKET },
  deleteKanbanCard: { cardId: CARD },
  registerHost: {
    hostId: 'probe-host',
    hostType: 'probe',
    catalogRevision: '1',
    tools: [],
    canSelectWorkerModel: false,
    models: []
  },
  matchCapabilities: { ticketId: TICKET, runId: RUN },
  queueRun: { epicId: EPIC },
  startRun: { epicId: EPIC },
  getRun: { runId: RUN },
  getReadyTickets: { runId: RUN },
  claimTicket: { runId: RUN, ticketId: TICKET, worker: { label: 'probe' } },
  heartbeatAttempt: { attemptId: ATTEMPT, claimToken: TOKEN },
  submitAttempt: { attemptId: ATTEMPT, claimToken: TOKEN, outputs: { summary: 'probe' } },
  acceptAttempt: { attemptId: ATTEMPT },
  rejectAttempt: { attemptId: ATTEMPT, reasons: ['probe'] },
  failAttempt: { attemptId: ATTEMPT, claimToken: TOKEN, failure: { reason: 'probe' } },
  reconcileAttempt: { attemptId: ATTEMPT, resolution: 'abandon' },
  carryForwardTicket: { runId: RUN, ticketId: TICKET, note: 'probe' },
  recordRowCheck: {
    runId: RUN,
    sprintId: probeId('sprint'),
    row: 1,
    commit: 'abcdef1',
    checks: [{ name: 'probe', status: 'passed' }]
  },
  pauseRun: { runId: RUN },
  resumeRun: { runId: RUN },
  cancelRun: { runId: RUN },
  takeoverRun: { runId: RUN },
  adoptRevision: { runId: RUN, revisionId: probeId('revision'), reason: 'Probe adoption reason, long enough.' },
  recordAttemptMetrics: { attemptId: ATTEMPT, claimToken: TOKEN, reports: [PROBE_REPORT] },
  recordRunMetrics: { runId: RUN, overhead: 'orchestration', reports: [PROBE_REPORT] },
  getRunMetrics: { runId: RUN },
  getPlannedBaselines: { epicId: EPIC },
  getTicketGrade: { runId: RUN, ticketId: TICKET },
  getSprintGrade: { runId: RUN, sprintId: probeId('sprint') },
  getRunGrade: { runId: RUN },
  getEpicGrade: { epicId: EPIC },
  getReportScorecard: { reportId: probeId('report') },
  reassessReportScorecard: { reportId: probeId('report') },
  getSpaceSignals: { level: 'run', id: RUN },
  getTicketPerformance: { runId: RUN, ticketId: TICKET },
  getEscapedDefects: { epicId: EPIC },
  getRunEfficiency: { runId: RUN },
  getRunTiming: { runId: RUN },
  getMetricsSummary: {},
  getGradingPolicy: undefined,
  recordHumanFeedback: { target: { epicId: EPIC, ticketId: TICKET }, feedback: { kind: 'rating', value: 4 } },
  recordEscapedDefects: {
    target: { epicId: EPIC },
    records: [{ defectEvent: 'report', severity: 'low', attribution: 'unassigned', discoveryPhase: 'after_epic', evidence: [{ kind: 'commit', id: 'abcdef1', detail: 'source build' }] }]
  },
  setTicketBudget: { epicId: EPIC, ticketId: TICKET, budget: { tokens: 1000 }, expectedDraftRevision: 1 },
  redraftNextSprint: { runId: RUN },
  previewCorrections: { reportId: probeId('report'), experimentIds: [probeId('experiment')] },
  createCorrections: { reportId: probeId('report'), experimentIds: [probeId('experiment')] },
  submitSprintReport: { runId: RUN, sprintId: probeId('sprint'), report: { summary: 'probe' } },
  getSprintReport: { runId: RUN },
  getRetroFindings: { reportId: probeId('report') },
  getExperiment: { experimentId: probeId('experiment') },
  recordExperimentEvent: { experimentId: probeId('experiment'), event: { kind: 'status', status: 'selected' } },
  getCheckpoint: { runId: RUN },
  approveCheckpoint: { runId: RUN, reportId: probeId('report') },
  advanceSprint: { runId: RUN },
  approveAndAdvance: { runId: RUN, reportId: probeId('report') },
  approveWithRedraft: { runId: RUN, expectedDraftRevision: 1 },
  authorizeAutoContinue: { runId: RUN, enabled: true },
  grantRetry: { runId: RUN, ticketId: TICKET },
  retryTicket: { runId: RUN, ticketId: TICKET, failureReason: 'The probe failed for a probing reason.', newApproach: 'A probing approach that differs entirely.' },
  acknowledgeAutoRetry: { runId: RUN, ticketId: TICKET, number: 1 },
  listEvents: {},
  getAttemptTimeline: { attemptId: ATTEMPT },
  getRunTimeline: { runId: RUN },
  getContext: { event: 'run.started' },
  addAttachment: { path: '/no/such/probe.png', label: 'probe', purpose: 'evidence' },
  uploadAttachment: { data: 'AAAA' },
  getAttachment: { attachmentId: probeId('attachment'), as: 'metadata' },
  addComment: { epicId: EPIC, body: 'probe' },
  listComments: { epicId: EPIC },
  createKanbanCard: { title: 'Probe card' },
  updateKanbanCard: { cardId: CARD, expectedRevision: 1, title: 'Probe edit' },
  listKanbanCards: {},
  getKanbanCard: { cardId: CARD },
  addKanbanMessage: { cardId: CARD, body: 'probe' },
  listKanbanMessages: { cardId: CARD },
  playKanbanCard: { cardId: CARD },
  launchKanbanCards: { cardIds: [CARD] },
  claimKanbanCard: { cardId: CARD },
  heartbeatKanbanCard: { attemptId: CARD_ATTEMPT, claimToken: CARD_TOKEN },
  submitKanbanCard: { attemptId: CARD_ATTEMPT, claimToken: CARD_TOKEN, outputs: { summary: 'probe' } },
  failKanbanCard: { attemptId: CARD_ATTEMPT, claimToken: CARD_TOKEN, reason: 'probe' },
  approveKanbanCard: { cardId: CARD },
  kickBackKanbanCard: { cardId: CARD, comment: 'probe' },
  listProfiles: undefined,
  getProfile: { name: 'probe-profile' },
  saveProfile: { name: 'probe-profile', capability: defaultCapabilityProfile() },
  queueTransfer: { epicId: EPIC },
  cancelTransfer: { epicId: EPIC },
  startTransfer: { epicId: EPIC },
  recordTransferItem: { epicId: EPIC, ref: 'project', linearId: 'lin-probe' },
  getTransfer: { epicId: EPIC },
  submitTransferReadback: { epicId: EPIC, readback: {}, final: false },
  getAgentIdentity: {},
  listAgentPeers: {},
  sendAgentMessage: { to: probeId('mailEndpoint'), clientMessageId: 'probe-1', body: 'probe' },
  readAgentInbox: {},
  acknowledgeAgentMessages: { messageIds: [probeId('mailMessage')] },
  getAgentMailStatus: {}
}

const COMMAND_NAMES = Object.keys(PROBES) as CommandName[]

/** The error code a command answers the probe with, or `ok`. */
async function outcomeOf(workspace: Workspace, name: CommandName): Promise<string> {
  const command = workspace[name] as (input: unknown) => Promise<unknown>
  try {
    await command.call(workspace, PROBES[name])
    return 'ok'
  } catch (error) {
    return error instanceof DomainError ? error.code : 'thrown'
  }
}

interface Session {
  role: SessionRole
  allowSave: boolean
}

const SESSIONS: Session[] = [
  { role: 'desktop', allowSave: false },
  { role: 'planner', allowSave: false },
  { role: 'planner', allowSave: true },
  { role: 'orchestrator', allowSave: false },
  { role: 'orchestrator', allowSave: true },
  { role: 'worker', allowSave: true },
  { role: 'reviewer', allowSave: false },
  // The authority every ungranted `dm` invocation runs with, so it belongs in the matrix too.
  { role: 'reader', allowSave: true }
]

describe('declared command capabilities match what the services enforce', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = createHarness()
    await harness.open('desktop', { allowSave: false }).initializeRepository({ name: 'probe' })
  })

  afterAll(() => {
    harness.cleanup()
  })

  it.each(SESSIONS)('a $role session (allowSave $allowSave) is refused exactly the commands it lacks', async (session) => {
    const workspace = harness.open(session.role, { allowSave: session.allowSave })
    const held = new Set(capabilitiesForRole(session.role, { allowSave: session.allowSave }))
    const outcomes = new Map<CommandName, string>()
    for (const name of COMMAND_NAMES) {
      outcomes.set(name, await outcomeOf(workspace, name))
    }

    const refused = COMMAND_NAMES.filter((name) => outcomes.get(name) === 'unauthorized')
    // Uploading image bytes is the desktop transport's alone, so a holder on any other transport is refused too.
    // A mailbox command also needs the session's own desktop-bound CLI grant, which no session here has: holding
    // `mail.use` without one is refused just the same.
    const lacking = COMMAND_NAMES.filter(
      (name) =>
        !held.has(COMMAND_CAPABILITIES[name]) ||
        name === 'uploadAttachment' ||
        name === 'switchStorageMode' ||
        COMMAND_CAPABILITIES[name] === 'mail.use'
    )
    expect(refused).toEqual(lacking)
    // The probe project is a single repository, which an authorized rescan refuses as having nothing to rescan.
    // The probe image path does not exist, so an authorized add stops at reading the file.
    const invalid = COMMAND_NAMES.filter((name) => outcomes.get(name) === 'invalid_input')
    const expectedInvalid = [
      ...(held.has('project.repositories') ? ['rescanRepositories'] : []),
      ...(held.has('attachment.write') ? ['addAttachment'] : [])
    ]
    expect(invalid).toEqual(expectedInvalid)
  })
})

describe('COMMAND_CAPABILITIES', () => {
  it('reserves the human-only capabilities for the desktop actions that exist for them', () => {
    const humanOnly = COMMAND_NAMES.filter((name) => HUMAN_ONLY_CAPABILITIES.includes(COMMAND_CAPABILITIES[name]))
    expect(humanOnly.sort()).toEqual([
      'acknowledgeAutoRetry',
      'approveAndAdvance',
      'approveCheckpoint',
      'approveKanbanCard',
      'approveWithRedraft',
      'authorizeAutoContinue',
      'backupDatabase',
      'cancelTransfer',
      'deleteEpic',
      'deleteKanbanCard',
      'deleteTicket',
      'grantRetry',
      'issueGrant',
      'kickBackKanbanCard',
      'playKanbanCard',
      'queueRun',
      'queueTransfer',
      'recordEscapedDefects',
      'recordHumanFeedback',
      'renewGrant',
      'resolveEpicConflict',
      'revokeGrant',
      'switchStorageMode'
    ])
  })
})

describe('transfer capabilities', () => {
  const ROLES: SessionRole[] = ['desktop', 'planner', 'orchestrator', 'worker', 'reviewer', 'reader']

  it('keeps transfer.queue human-only, held by the desktop alone', () => {
    expect(HUMAN_ONLY_CAPABILITIES).toContain('transfer.queue')
    expect(ROLES.filter((role) => capabilitiesForRole(role, { allowSave: true }).includes('transfer.queue'))).toEqual([
      'desktop'
    ])
  })

  it('gives epic.transfer to the orchestrator and the desktop only', () => {
    expect(ROLES.filter((role) => capabilitiesForRole(role, { allowSave: true }).includes('epic.transfer'))).toEqual([
      'desktop',
      'orchestrator'
    ])
  })
})
