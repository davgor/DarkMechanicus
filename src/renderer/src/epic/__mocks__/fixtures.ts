/**
 * Test-only builders for the epic workspace, graph, ticket and checkpoint tests. They model the
 * "Planning vertical slice" sample from the design mockups. Lives under __mocks__ so fireguard
 * treats it as support code rather than a production module.
 */
import type { TrackedFolderView } from '../../../../shared/desktop/api'
import {
  DEFAULT_POLICIES,
  defaultCapabilityProfile,
  PLAN_FORMAT_VERSION,
  type DependencyEdge,
  type PlanBundle,
  type SprintDef,
  type TicketContent
} from '../../../../shared/domain/bundle'
import type { AttemptState, TicketExecutionState } from '../../../../shared/domain/status'
import type {
  AttemptView,
  CheckpointView,
  CommentView,
  EpicDetailView,
  EventView,
  GateCondition,
  PlanView,
  ProfileView,
  ProjectView,
  RowCheckView,
  RowView,
  RunView,
  SprintIncrementView,
  SprintReportView,
  TicketDetailView,
  TicketExecutionView,
  TicketLinkView,
  TicketSummaryView,
  ValidationReport
} from '../../../../shared/domain/views'

export const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const EPIC_ID = 'ep_1'

export function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString()
}

export const MINUTE = 60_000

export function folder(patch: Partial<TrackedFolderView> = {}): TrackedFolderView {
  return {
    path: '/home/u/code/darkmechanicus',
    name: 'darkmechanicus',
    displayPath: '~/code/darkmechanicus',
    initialized: true,
    available: true,
    addedAt: '2026-01-01T00:00:00.000Z',
    ...patch
  }
}

export function ticket(key: string, title: string, patch: Partial<TicketContent> = {}): TicketContent {
  return {
    id: `tk_${key.slice(3)}`,
    key,
    title,
    body: '',
    acceptanceCriteria: [{ id: 'c1', text: `${title} works` }],
    tags: [],
    priority: 'normal',
    capability: defaultCapabilityProfile(),
    references: [],
    expectedArtifacts: [],
    optional: false,
    ...patch
  }
}

export function sprint(ordinal: number, goal: string, ticketIds: string[], patch: Partial<SprintDef> = {}): SprintDef {
  return {
    id: `sp_${ordinal}`,
    ordinal,
    goal,
    ticketIds,
    entryCriteria: [],
    exitCriteria: [],
    concurrencyCap: null,
    checkpoint: { mode: 'human' },
    ...patch
  }
}

export function edge(from: number, to: number): DependencyEdge {
  return { from: `tk_${from}`, to: `tk_${to}` }
}

const SAMPLE_TICKETS: TicketContent[] = [
  ticket('DM-101', 'Repository init'),
  ticket('DM-102', 'SQLite schema & migrations'),
  ticket('DM-103', 'Portable export outbox'),
  ticket('DM-201', 'MCP authoring tools'),
  ticket('DM-202', 'Transactional bundle import', {
    body: '`save_plan_draft` accepts one bundle of tickets.',
    acceptanceCriteria: [
      { id: 'c1', text: 'Bundle with client-local refs returns stable IDs' },
      { id: 'c2', text: 'An invalid edge rejects the whole bundle and nothing persists' },
      { id: 'c3', text: 'A retry with the same idempotency key returns the original result' },
      { id: 'c4', text: 'Export outbox entry is written in the same transaction' }
    ],
    tags: ['storage'],
    priority: 'high',
    capability: {
      ...defaultCapabilityProfile(),
      reasoning: { level: 'multi_step', rationale: 'transaction and outbox ordering' },
      tools: ['repo_read', 'repo_write', 'shell', 'test_execution'],
      skills: ['TypeScript', 'SQLite', 'Database design', 'MCP'],
      context: { estimatedInputTokens: 40_000, requiredArtifacts: [] }
    }
  }),
  ticket('DM-203', 'Folder registry & picker'),
  ticket('DM-204', 'Sidebar plan buckets'),
  ticket('DM-301', 'Plan graph view'),
  ticket('DM-302', 'Ticket detail editor'),
  ticket('DM-304', 'Safe plan deletion')
]

export function bundle(patch: Partial<PlanBundle> = {}): PlanBundle {
  return {
    formatVersion: PLAN_FORMAT_VERSION,
    epic: {
      title: 'Plan through MCP, edit on the desktop',
      intent: 'Agents plan through MCP; people edit on the desktop.',
      successCriteria: [
        { id: 's1', text: 'An agent saves a plan through MCP' },
        { id: 's2', text: 'The desktop edits the same plan' },
        { id: 's3', text: 'Saved state survives a restart' }
      ],
      ownerRole: null
    },
    tickets: SAMPLE_TICKETS,
    sprints: [
      sprint(1, 'Storage foundation', ['tk_101', 'tk_102', 'tk_103']),
      sprint(2, 'Authoring through MCP', ['tk_201', 'tk_202', 'tk_203', 'tk_204']),
      sprint(3, 'Desktop editing', ['tk_301', 'tk_302', 'tk_304'])
    ],
    edges: [
      edge(101, 203),
      edge(102, 201),
      edge(102, 202),
      edge(103, 202),
      edge(203, 204),
      edge(204, 301),
      edge(201, 301),
      edge(201, 302),
      edge(202, 304)
    ],
    relations: [{ kind: 'related_to', from: 'tk_301', to: 'tk_302' }],
    policies: { ...DEFAULT_POLICIES, retryLimit: 2 },
    rationale: '',
    ...patch
  }
}

export function savedPlan(patch: Partial<PlanView> = {}): PlanView {
  return {
    epicId: EPIC_ID,
    view: 'saved',
    revisionId: 'rv_4',
    revisionNumber: 4,
    baseRevisionId: null,
    baseRevisionNumber: null,
    draftRevision: null,
    contentHash: 'hash-4',
    bundle: bundle(),
    readOnly: true,
    readOnlyReason: 'Saved revisions are read-only. Edit the draft instead.',
    changes: [],
    stale: false,
    ...patch
  }
}

export function draftPlan(patch: Partial<PlanView> = {}): PlanView {
  const draftBundle = bundle({
    tickets: [...SAMPLE_TICKETS, ticket('DM-305', 'Plan list view')],
    sprints: [
      sprint(1, 'Storage foundation', ['tk_101', 'tk_102', 'tk_103']),
      sprint(2, 'Authoring through MCP', ['tk_201', 'tk_202', 'tk_203', 'tk_204']),
      sprint(3, 'Desktop editing', ['tk_301', 'tk_302', 'tk_304', 'tk_305'])
    ]
  })
  return {
    ...savedPlan(),
    view: 'draft',
    revisionId: null,
    revisionNumber: null,
    baseRevisionId: 'rv_4',
    baseRevisionNumber: 4,
    draftRevision: 7,
    contentHash: 'hash-draft',
    bundle: draftBundle,
    readOnly: false,
    readOnlyReason: null,
    changes: [
      { kind: 'added', target: 'ticket', id: 'tk_305', label: 'DM-305 Plan list view', detail: 'added to Sprint 3' },
      { kind: 'edited', target: 'ticket', id: 'tk_302', label: 'DM-302', detail: 'acceptance criteria edited (2 lines)' },
      { kind: 'edited', target: 'sprint', id: 'sp_3', label: 'Sprint 3', detail: 'concurrency cap 2 → 3' },
      { kind: 'removed', target: 'edge', id: 'tk_102->tk_202', label: 'DM-202', detail: 'no longer requires DM-102' }
    ],
    ...patch
  }
}

export function epicDetail(patch: Partial<EpicDetailView> = {}): EpicDetailView {
  return {
    id: EPIC_ID,
    title: 'Planning vertical slice',
    status: 'in_progress',
    revision: 3,
    currentRevisionId: 'rv_4',
    currentRevisionNumber: 4,
    hasDraft: false,
    draftRevision: null,
    draftChanged: false,
    ticketCount: 10,
    sprintCount: 3,
    run: null,
    branch: null,
    pendingSave: false,
    conflict: null,
    createdAt: iso(-24 * 60 * MINUTE),
    updatedAt: iso(-10 * MINUTE),
    completedAt: null,
    intent: 'Agents plan through MCP; people edit on the desktop.',
    successCriteria: bundle().epic.successCriteria,
    ownerRole: null,
    provenance: null,
    outcome: null,
    ...patch
  }
}

export function execution(
  key: string,
  sprintId: string,
  state: TicketExecutionState,
  patch: Partial<TicketExecutionView> = {}
): TicketExecutionView {
  return {
    ticketId: `tk_${key.slice(3)}`,
    key,
    sprintId,
    row: 1,
    state,
    attemptCount: state === 'later_sprint' || state === 'ready' ? 0 : 1,
    latestAttemptId: null,
    blockers: [],
    prerequisites: [],
    ...patch
  }
}

export function attempt(ticketKey: string, number: number, state: AttemptState, patch: Partial<AttemptView> = {}): AttemptView {
  return {
    id: `at_${ticketKey.slice(3)}_${number}`,
    runId: 'rn_2',
    ticketId: `tk_${ticketKey.slice(3)}`,
    number,
    kind: 'work',
    state,
    fencingToken: number,
    worker: {
      sessionId: 'ss_1',
      label: 'worker-a',
      modelId: 'model-large',
      hostId: 'claude-code',
      catalogRevision: 'cat-1',
      rationale: 'Needs multi-step reasoning'
    },
    revisionId: 'rv_4',
    ticketContentHash: 'th',
    leaseExpiresAt: null,
    heartbeatAt: null,
    outputs: null,
    evidence: null,
    failure: null,
    decision: null,
    createdAt: iso(-60 * MINUTE),
    updatedAt: iso(-30 * MINUTE),
    submittedAt: null,
    decidedAt: null,
    reconciledAt: null,
    superseded: false,
    ...patch
  }
}

export const SAMPLE_ATTEMPTS: AttemptView[] = [
  attempt('DM-101', 1, 'accepted', {
    outputs: { summary: 'Init done', artifacts: [], commits: ['3f9a0d1c'], changedFiles: ['src/init.ts'], branch: 'epic' },
    updatedAt: iso(-100 * MINUTE)
  }),
  attempt('DM-202', 1, 'failed', {
    failure: { reason: '2 tests failed', details: 'idempotency replay returned a new id', retryable: true },
    evidence: {
      checks: [
        { name: 'Unit tests', status: 'failed', detail: '2 failed' },
        { name: 'Typecheck', status: 'passed', detail: '0 errors' },
        { name: 'Lint', status: 'skipped', detail: 'not configured' }
      ],
      criteria: [
        { criterionId: 'c1', met: true, note: 'stable ids returned' },
        { criterionId: 'c2', met: false, note: 'partial rows remained' }
      ],
      notes: 'Replay test is **flaky**.'
    },
    updatedAt: iso(-20 * MINUTE)
  }),
  attempt('DM-202', 2, 'running', {
    leaseExpiresAt: iso(4 * MINUTE + 12_000),
    heartbeatAt: iso(-20_000),
    updatedAt: iso(-1 * MINUTE)
  }),
  attempt('DM-201', 1, 'submitted', {
    outputs: {
      summary: 'Added create_epic and update_plan_draft tools.',
      artifacts: [],
      commits: ['a1b2c3d4e5f6'],
      changedFiles: ['src/mcp/tools.ts', 'src/mcp/server.ts'],
      branch: 'epic/planning'
    },
    submittedAt: iso(-5 * MINUTE),
    updatedAt: iso(-5 * MINUTE)
  })
]

export function runView(patch: Partial<RunView> = {}): RunView {
  return {
    id: 'rn_2',
    number: 2,
    epicId: EPIC_ID,
    revisionId: 'rv_4',
    revisionNumber: 4,
    state: 'running',
    activeSprintId: 'sp_2',
    activeSprintOrdinal: 2,
    sprintCount: 3,
    host: { label: 'Claude Code', type: 'claude-code', catalogId: null },
    skillVersion: '1',
    ownerMachineId: 'mc_1',
    ownedByThisMachine: true,
    pauseReason: null,
    autoContinue: false,
    createdAt: iso(-(2 * 60 + 20) * MINUTE),
    startedAt: iso(-(2 * 60 + 14) * MINUTE),
    updatedAt: iso(-1 * MINUTE),
    endedAt: null,
    counts: {
      accepted: 4,
      submitted: 1,
      running: 1,
      ready: 1,
      waiting: 3,
      blocked: 0,
      failed: 0,
      needsReconciliation: 0
    },
    tickets: [
      execution('DM-101', 'sp_1', 'accepted'),
      execution('DM-102', 'sp_1', 'accepted'),
      execution('DM-103', 'sp_1', 'accepted'),
      execution('DM-201', 'sp_2', 'submitted'),
      execution('DM-202', 'sp_2', 'running', { attemptCount: 2 }),
      execution('DM-203', 'sp_2', 'accepted'),
      execution('DM-204', 'sp_2', 'ready'),
      execution('DM-301', 'sp_3', 'later_sprint'),
      execution('DM-302', 'sp_3', 'later_sprint'),
      execution('DM-304', 'sp_3', 'later_sprint')
    ],
    rows: [],
    increments: [],
    attempts: SAMPLE_ATTEMPTS,
    checkpoint: null,
    ...patch
  }
}

/** One recorded check of a dependency row: passed, or failed on its first entry. */
export function rowCheck(sprintId: string, row: number, passed: boolean, patch: Partial<RowCheckView> = {}): RowCheckView {
  return {
    id: `rc_${sprintId}_${row}`,
    runId: 'rn_2',
    sprintId,
    row,
    number: 1,
    commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    checks: passed
      ? [{ name: 'Unit tests', status: 'passed', detail: '12 passed' }]
      : [
          { name: 'Unit tests', status: 'failed', detail: '2 failed' },
          { name: 'Typecheck', status: 'passed', detail: '0 errors' }
        ],
    passed,
    recordedBy: 'orchestrator',
    createdAt: iso(-10 * MINUTE),
    ...patch
  }
}

/** A dependency row (counted from 1) with the keys of its tickets and its latest check, if any. */
export function rowView(sprintId: string, row: number, keys: string[], latestCheck: RowCheckView | null = null): RowView {
  return { sprintId, row, tickets: keys.map((key) => ({ ticketId: `tk_${key.slice(3)}`, key })), latestCheck }
}

/** The verified increment of a sprint's acceptance node: one squashed commit on the epic branch. */
export function incrementView(patch: Partial<SprintIncrementView> = {}): SprintIncrementView {
  return {
    sprintId: 'sp_2',
    sprintOrdinal: 2,
    ticketId: 'tk_290',
    key: 'DM-290',
    attemptId: 'at_290_1',
    attemptState: 'accepted',
    increment: {
      branch: 'epic/planning',
      commit: '5d3e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e',
      parent: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',
      base: { kind: 'previous_increment', commit: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432' },
      passed: true,
      reasons: [],
      checks: [
        { name: 'One commit on the epic branch', status: 'passed', detail: 'epic/planning is at 5d3e1f0' },
        { name: 'Parent is the previous increment', status: 'passed', detail: '9f8e7d6' }
      ],
      verifiedAt: iso(-6 * MINUTE)
    },
    ...patch
  }
}

/** The project a repository tracks, with the two checks of its Definition of Done by default. */
export function projectView(patch: Partial<ProjectView> = {}): ProjectView {
  return {
    projectId: 'pj_1',
    name: 'DarkMechanicus',
    keyPrefix: 'DM',
    repoRoot: '/repo',
    createdAt: iso(-48 * 60 * MINUTE),
    definitionOfDone: [
      { name: 'Unit tests', command: 'npm test', description: 'Every unit test passes.' },
      { name: 'Typecheck', command: 'npm run typecheck', description: 'No type errors in any project.' }
    ],
    ...patch
  }
}

export function condition(id: GateCondition['id'], met: boolean, detail = ''): GateCondition {
  const labels: Record<GateCondition['id'], string> = {
    report_submitted: 'Sprint report submitted',
    no_active_leases: 'No worker still holds a lease',
    required_accepted: 'Every required ticket accepted',
    acceptance_accepted: 'Sprint acceptance accepted',
    increment_merged: 'Sprint increment merged',
    definition_of_done: 'Definition of Done passed',
    exit_criteria: 'Exit criteria: driver loads on both platforms',
    epic_outcome: 'Epic outcome recorded',
    approval: 'Approval'
  }
  return { id, label: labels[id], met, detail }
}

export function reportView(patch: Partial<SprintReportView> = {}): SprintReportView {
  return {
    id: 'sr_1',
    runId: 'rn_2',
    sprintId: 'sp_2',
    reportRevision: 1,
    contentHash: 'rh',
    report: {
      summary: 'Authoring works end to end. **Import** is still flaky.',
      accepted: ['tk_203', 'DM-201'],
      failed: ['tk_202'],
      blocked: [],
      changes: { files: ['src/mcp/tools.ts'], commits: ['a1b2c3d'] },
      checks: [
        { name: 'Typecheck', status: 'passed', detail: '0 errors' },
        { name: 'Package · macos-latest', status: 'failed', detail: 'exit 1' },
        { name: 'Docs', status: 'skipped', detail: 'n/a' }
      ],
      risks: ['macOS signing is unverified'],
      followUps: [
        { title: 'Provide a signing identity', body: 'Needs a person: certificate access.' },
        { title: 'Re-run driver load test', body: 'Separates signing from loading' }
      ],
      exitCriteria: [{ criterionId: 'x1', met: false, note: 'macOS unverified' }],
      epicOutcome: null
    },
    submittedBy: 'sprint reporter',
    createdAt: iso(-12 * MINUTE),
    ...patch
  }
}

export function checkpointView(patch: Partial<CheckpointView> = {}): CheckpointView {
  return {
    runId: 'rn_2',
    sprintId: 'sp_2',
    sprintOrdinal: 2,
    sprintCount: 3,
    isFinalSprint: false,
    policy: 'human',
    autoContinueAuthorized: false,
    report: reportView(),
    conditions: [
      condition('report_submitted', true, 'Required by checkpoint policy'),
      condition('no_active_leases', true, 'All claims released or expired'),
      condition('required_accepted', false, 'DM-202 failed after 2 attempts'),
      condition('exit_criteria', false, 'macOS unverified'),
      condition('approval', false, 'Waiting for your approval')
    ],
    gatesMet: false,
    canAdvance: false,
    approval: null,
    ...patch
  }
}

/**
 * The completed "MCP connection test" epic committed in this repository's portable state
 * (`.darkmechanicus/epics/ep_01m3txy30qavmd5wewct90804g` and its run history), shaped as the core
 * serves it after an import. Ids and text are the real ones; times are relative to NOW.
 */
export const MCP_TEST = {
  epicId: 'ep_01m3txy30qavmd5wewct90804g',
  runId: 'rn_01m3txzt9wj79mxsq50f5ktf1q',
  revisionId: 'rv_01m3txzpv9ws6fbj6p211ghkn9',
  sprintId: 'sp_01m3txy30q8sb4f7ekx20btcr6',
  reportId: 'rp_01m3ty66d960gb6z5bt9y4th60'
}

const MCP_TEST_TICKETS: TicketContent[] = [
  ticket('DM-1', 'Confirm epic is visible in the app', {
    id: 'tk_01m3txy30tjnwv2m5kjebfq0aj',
    acceptanceCriteria: [{ id: 'c1', text: 'Epic shows in the epic list' }]
  }),
  ticket('DM-2', 'Save or discard the draft', {
    id: 'tk_01m3txy30tvtfbzj1ecax0dvb0',
    acceptanceCriteria: [{ id: 'c1', text: 'Draft saved or discarded from the desktop' }]
  })
]

const MCP_TEST_OUTCOME = {
  summary:
    'The MCP authoring and execution path works end to end with the installed app: an agent can create epics and tickets, a person saves and queues in the desktop, and an agent can execute the run up to the human checkpoint.',
  successCriteria: [
    { criterionId: 's1', met: true, note: 'Epic and both tickets listed (DM-1 accepted); the person saved and queued it from the desktop.' },
    { criterionId: 's2', met: true, note: 'Draft saved as revision 1 from the desktop (DM-2 accepted).' }
  ]
}

export function mcpTestPlan(): PlanView {
  const [first, second] = MCP_TEST_TICKETS.map((item) => item.id)
  return savedPlan({
    epicId: MCP_TEST.epicId,
    revisionId: MCP_TEST.revisionId,
    revisionNumber: 1,
    contentHash: 'sha256:c052780122fb60803fd440e33f7137b68a85c324f73038692cb8f0782525528d',
    bundle: bundle({
      epic: {
        title: 'MCP connection test',
        intent: 'Created by Claude Code over MCP to confirm an agent can author epics. Safe to discard.',
        successCriteria: [
          { id: 's1', text: 'Epic and tickets appear in the desktop app' },
          { id: 's2', text: 'A person can Save or discard the draft' }
        ],
        ownerRole: null
      },
      tickets: MCP_TEST_TICKETS,
      sprints: [sprint(1, '', [first ?? '', second ?? ''], { id: MCP_TEST.sprintId })],
      edges: [{ from: first ?? '', to: second ?? '' }],
      relations: [],
      policies: { ...DEFAULT_POLICIES, retryLimit: 3 }
    })
  })
}

export function mcpTestEpic(patch: Partial<EpicDetailView> = {}): EpicDetailView {
  const plan = mcpTestPlan()
  return epicDetail({
    id: MCP_TEST.epicId,
    title: 'MCP connection test',
    status: 'completed',
    currentRevisionId: MCP_TEST.revisionId,
    currentRevisionNumber: 1,
    ticketCount: 2,
    sprintCount: 1,
    completedAt: iso(-40 * MINUTE),
    intent: plan.bundle.epic.intent,
    successCriteria: plan.bundle.epic.successCriteria,
    outcome: { ...MCP_TEST_OUTCOME, recordedAt: iso(-40 * MINUTE), runId: MCP_TEST.runId },
    ...patch
  })
}

export function mcpTestRun(patch: Partial<RunView> = {}): RunView {
  const tickets = MCP_TEST_TICKETS.map((item) => execution(item.key, MCP_TEST.sprintId, 'accepted', { ticketId: item.id }))
  return runView({
    id: MCP_TEST.runId,
    number: 1,
    epicId: MCP_TEST.epicId,
    revisionId: MCP_TEST.revisionId,
    revisionNumber: 1,
    state: 'completed',
    activeSprintId: null,
    activeSprintOrdinal: null,
    sprintCount: 1,
    createdAt: iso(-48 * MINUTE),
    startedAt: iso(-46 * MINUTE),
    updatedAt: iso(-40 * MINUTE),
    endedAt: iso(-40 * MINUTE),
    counts: { accepted: 2, submitted: 0, running: 0, ready: 0, waiting: 0, blocked: 0, failed: 0, needsReconciliation: 0 },
    tickets,
    attempts: [],
    ...patch
  })
}

export function mcpTestReport(): SprintReportView {
  return reportView({
    id: MCP_TEST.reportId,
    runId: MCP_TEST.runId,
    sprintId: MCP_TEST.sprintId,
    contentHash: 'sha256:b0e8d703b5b92ef6c8d2cc9c758aaf7444cccd345f0530a4a43ecefd0f02b998',
    submittedBy: 'Claude Code (orchestrator)',
    createdAt: iso(-45 * MINUTE),
    report: {
      summary:
        'Sprint 1 confirmed the full MCP loop from an external agent host (Claude Code) against the installed v0.8.0 app. Nothing failed or is blocked.',
      accepted: [
        'DM-1 Confirm epic is visible in the app: verified via list_epics; desktop-only save and queue confirm it was visible in the app',
        'DM-2 Save or discard the draft: revision 1 saved from the desktop, no draft outstanding'
      ],
      failed: [],
      blocked: [],
      changes: { commits: [], files: [] },
      checks: [
        { name: 'installed-app MCP smoke (npm run smoke:mcp)', status: 'passed', detail: '55 tools, 6 prompts' },
        { name: 'draft plan validation', status: 'passed', detail: 'validate_plan view=draft: valid, no errors or warnings' },
        { name: 'dependency gating', status: 'passed', detail: 'DM-2 stayed waiting until DM-1 was accepted' }
      ],
      risks: ['Reviews were not independent: the orchestrator session did the work and accepted it.'],
      followUps: [
        { title: 'Register darkmechanicus MCP server in Claude Code', body: 'So sessions get native tools.' },
        { title: 'Use a separate reviewer session for real epics', body: 'Review independent of the worker.' }
      ],
      exitCriteria: [],
      epicOutcome: MCP_TEST_OUTCOME
    }
  })
}

export function link(key: string, title: string, state: TicketExecutionState | null): TicketLinkView {
  return { ticketId: `tk_${key.slice(3)}`, key, title, status: 'in_progress', executionState: state }
}

export function ticketDetail(patch: Partial<TicketDetailView> = {}): TicketDetailView {
  const content = SAMPLE_TICKETS.find((item) => item.key === 'DM-202') ?? SAMPLE_TICKETS[0]
  return {
    epicId: EPIC_ID,
    view: 'saved',
    ticket: content as TicketContent,
    status: 'in_progress',
    sprintId: 'sp_2',
    sprintOrdinal: 2,
    prerequisites: [link('DM-102', 'SQLite schema & migrations', 'accepted'), link('DM-103', 'Portable export outbox', 'accepted')],
    dependents: [link('DM-304', 'Safe plan deletion', 'waiting')],
    relations: [],
    execution: execution('DM-202', 'sp_2', 'running', { attemptCount: 2 }),
    attempts: SAMPLE_ATTEMPTS.filter((item) => item.ticketId === 'tk_202'),
    readOnly: true,
    readOnlyReason: 'Read-only while run #2 is active',
    ...patch
  }
}

export function summaries(plan: PlanBundle, status: TicketSummaryView['status'] = 'backlog'): TicketSummaryView[] {
  return plan.tickets.map((item) => {
    const home = plan.sprints.find((entry) => entry.ticketIds.includes(item.id))
    return {
      id: item.id,
      key: item.key,
      title: item.title,
      status,
      sprintId: home?.id ?? null,
      sprintOrdinal: home?.ordinal ?? null,
      priority: item.priority,
      tags: item.tags,
      optional: item.optional
    }
  })
}

export function validation(patch: Partial<ValidationReport> = {}): ValidationReport {
  return {
    valid: true,
    errors: [],
    warnings: [
      {
        code: 'isolated_ticket',
        message: 'DM-305 has no prerequisites and nothing depends on it. It can start as soon as its sprint opens.',
        ticketIds: ['tk_305']
      }
    ],
    ...patch
  }
}

/** A comment on DM-202 by a worker, written `minutesAgo` minutes before NOW. */
export function comment(n: number, minutesAgo: number, patch: Partial<CommentView> = {}): CommentView {
  return {
    id: `cm_${n}`,
    epicId: EPIC_ID,
    ticketId: 'tk_202',
    body: `Comment ${n}`,
    author: { role: 'worker', label: 'worker-a' },
    createdAt: iso(-minutesAgo * MINUTE),
    ...patch
  }
}

export function event(seq: number, kind: string, patch: Partial<EventView> = {}): EventView {
  return {
    seq,
    at: iso(-seq * MINUTE),
    kind,
    epicId: EPIC_ID,
    runId: 'rn_2',
    ticketId: 'tk_202',
    sessionId: null,
    payload: {},
    ...patch
  }
}

/** A named capability profile ("deep-review") that differs from DM-202 in every capability group. */
export function profileView(patch: Partial<ProfileView> = {}): ProfileView {
  return {
    name: 'deep-review',
    description: 'Independent review of risky changes',
    capability: {
      workType: 'review',
      reasoning: { level: 'deep', rationale: 'Risky change' },
      skills: ['security-review'],
      modalities: ['text', 'images'],
      tools: ['test_execution', 'repo_read'],
      context: { estimatedInputTokens: 80_000, requiredArtifacts: ['docs/architecture.md'] },
      constraints: { environments: ['ci'], dataLocation: 'eu', maxDurationMinutes: 60, maxCostUsd: 5 },
      preferences: { quality: 'high', latency: null, cost: 'low', autonomy: 'supervised', modelOverride: null }
    },
    revision: 2,
    updatedAt: iso(0),
    ...patch
  }
}
