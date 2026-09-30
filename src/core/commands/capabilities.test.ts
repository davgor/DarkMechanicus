import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CommandName } from '../../shared/domain/api'
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

/**
 * One schema-valid input per command. Ids point at nothing, so a permitted call stops at a
 * `not_found` (or succeeds harmlessly) right after its authorization check.
 */
const PROBES: Record<CommandName, unknown> = {
  getCapabilities: undefined,
  getProject: undefined,
  initializeRepository: {},
  getStorageStatus: undefined,
  flushPortableState: undefined,
  reconcileRepository: undefined,
  searchHistory: { query: 'probe' },
  listBranchEpics: undefined,
  backupDatabase: {},
  listSessions: undefined,
  listEpics: undefined,
  createEpic: { title: 'Probe epic' },
  getEpic: { epicId: EPIC },
  setEpicStatus: { epicId: EPIC, status: 'in_progress' },
  setEpicBranch: { epicId: EPIC, branch: { repository: null, name: 'feature/probe', startCommit: null } },
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
  pauseRun: { runId: RUN },
  resumeRun: { runId: RUN },
  cancelRun: { runId: RUN },
  takeoverRun: { runId: RUN },
  adoptRevision: { runId: RUN, revisionId: probeId('revision') },
  submitSprintReport: { runId: RUN, sprintId: probeId('sprint'), report: { summary: 'probe' } },
  getSprintReport: { runId: RUN },
  getCheckpoint: { runId: RUN },
  approveCheckpoint: { runId: RUN, reportId: probeId('report') },
  advanceSprint: { runId: RUN },
  approveAndAdvance: { runId: RUN, reportId: probeId('report') },
  authorizeAutoContinue: { runId: RUN, enabled: true },
  grantRetry: { runId: RUN, ticketId: TICKET },
  listEvents: {}
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
  { role: 'reviewer', allowSave: false }
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
    const lacking = COMMAND_NAMES.filter((name) => !held.has(COMMAND_CAPABILITIES[name]))
    expect(refused).toEqual(lacking)
    expect(COMMAND_NAMES.filter((name) => outcomes.get(name) === 'invalid_input')).toEqual([])
  })
})

describe('COMMAND_CAPABILITIES', () => {
  it('reserves the human-only capabilities for the desktop actions that exist for them', () => {
    const humanOnly = COMMAND_NAMES.filter((name) => HUMAN_ONLY_CAPABILITIES.includes(COMMAND_CAPABILITIES[name]))
    expect(humanOnly.sort()).toEqual(['approveAndAdvance', 'approveCheckpoint', 'authorizeAutoContinue', 'grantRetry', 'queueRun'])
  })
})
