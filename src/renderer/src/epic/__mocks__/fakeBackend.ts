/**
 * Hand-written `window.dm` for epic workspace tests. It answers commands from a mutable scenario
 * (so mutations change what the next load returns) and records every call, letting tests assert
 * on recorded requests and rendered state instead of mock expectations.
 */
import type { CommandName } from '../../../../shared/domain/api'
import type { DomainErrorShape } from '../../../../shared/domain/errors'
import type {
  CommandInput,
  CommandOutput,
  CommandResult,
  DmApi,
  FolderPickResult,
  McpConfigView,
  TrackedFolderView
} from '../../../../shared/desktop/api'
import type {
  CheckpointView,
  EpicDetailView,
  EventView,
  PlanView,
  RunView,
  TicketDetailView,
  ValidationReport
} from '../../../../shared/domain/views'
import { CommandError } from '../../api/dm'
import type { Runner } from '../runner'
import {
  checkpointView,
  draftPlan,
  epicDetail,
  event,
  runView,
  savedPlan,
  summaries,
  ticketDetail,
  validation
} from './fixtures'

export interface Scenario {
  epic: EpicDetailView
  saved: PlanView | null
  draft: PlanView | null
  run: RunView | null
  checkpoint: CheckpointView | null
  validation: ValidationReport
  ticket: TicketDetailView
  events: EventView[]
}

export interface RecordedCall {
  name: CommandName
  input: unknown
}

type Handler = (input: never) => unknown

export function scenario(patch: Partial<Scenario> = {}): Scenario {
  return {
    epic: epicDetail(),
    saved: savedPlan(),
    draft: null,
    run: runView(),
    checkpoint: checkpointView({ report: null }),
    validation: validation(),
    ticket: ticketDetail(),
    events: [event(1, 'attempt.claimed'), event(2, 'attempt.failed', { payload: { reason: '2 tests failed' } })],
    ...patch
  }
}

export class FakeBackend implements DmApi {
  readonly calls: RecordedCall[] = []
  readonly opened: string[] = []
  /** Queued failures per command, consumed one per call. */
  readonly failures: Partial<Record<CommandName, DomainErrorShape[]>> = {}
  /** Promises a command waits on before answering (to observe in-flight states). */
  readonly gates: Partial<Record<CommandName, Promise<void>>> = {}
  readonly handlers: Partial<Record<CommandName, Handler>>

  constructor(readonly state: Scenario = scenario()) {
    this.handlers = defaultHandlers(state)
  }

  readonly runner: Runner = async <K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandOutput<K>> => {
    const result = await this.command('/repo', name, input)
    if (result.ok) {
      return result.data
    }
    throw new CommandError(result.error)
  }

  fail(name: CommandName, code: DomainErrorShape['code'], message: string): void {
    this.failures[name] = [...(this.failures[name] ?? []), { code, message }]
  }

  names(): string[] {
    return this.calls.map((call) => call.name)
  }

  inputs(name: CommandName): unknown[] {
    return this.calls.filter((call) => call.name === name).map((call) => call.input)
  }

  async command<K extends CommandName>(_folder: string, name: K, input: CommandInput<K>): Promise<CommandResult<CommandOutput<K>>> {
    this.calls.push({ name, input })
    await this.gates[name]
    const failure = this.failures[name]?.shift()
    if (failure) {
      return { ok: false, error: failure }
    }
    const handler = this.handlers[name] as ((value: CommandInput<K>) => unknown) | undefined
    if (!handler) {
      return { ok: false, error: { code: 'internal', message: `No fake for ${name}` } }
    }
    try {
      return { ok: true, data: handler(input) as CommandOutput<K> }
    } catch (error) {
      return { ok: false, error: { code: 'not_found', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  listFolders(): Promise<TrackedFolderView[]> {
    return Promise.resolve([])
  }

  pickFolder(): Promise<FolderPickResult> {
    return Promise.resolve({ folder: null, added: false })
  }

  untrackFolder(): Promise<TrackedFolderView[]> {
    return Promise.resolve([])
  }

  getMcpConfig(): Promise<McpConfigView> {
    return Promise.resolve({ command: 'dm', args: [], env: {}, json: '{}', note: '' })
  }

  installSkills(): Promise<{ written: string[] }> {
    return Promise.resolve({ written: [] })
  }

  copyText(): Promise<void> {
    return Promise.resolve()
  }

  openExternal(url: string): Promise<boolean> {
    this.opened.push(url)
    return Promise.resolve(true)
  }
}

function notFound(message: string): never {
  throw new Error(message)
}

function planOf(state: Scenario, view: 'saved' | 'draft'): PlanView {
  return (view === 'draft' ? state.draft : state.saved) ?? notFound(`No ${view} plan`)
}

function ticketOf(state: Scenario, input: { ticketId: string; view: 'saved' | 'draft' }): TicketDetailView {
  if (input.ticketId === state.ticket.ticket.id && input.view === state.ticket.view) {
    return state.ticket
  }
  const plan = planOf(state, input.view)
  const content = plan.bundle.tickets.find((item) => item.id === input.ticketId) ?? notFound('No ticket')
  return ticketDetail({ view: input.view, ticket: content, execution: null, attempts: [], readOnly: false, readOnlyReason: null })
}

function openDraft(state: Scenario): PlanView {
  state.draft = state.draft ?? draftPlan({ changes: [] })
  state.epic = { ...state.epic, hasDraft: true, draftRevision: state.draft.draftRevision }
  return state.draft
}

function updateDraft(state: Scenario): unknown {
  const draft = openDraft(state)
  state.draft = { ...draft, draftRevision: (draft.draftRevision ?? 0) + 1 }
  return { epicId: state.epic.id, draftRevision: state.draft.draftRevision, refMap: { new: 'tk_new' }, validation: state.validation }
}

function save(state: Scenario): unknown {
  const number = (state.epic.currentRevisionNumber ?? 0) + 1
  state.saved = savedPlan({ revisionId: `rv_${number}`, revisionNumber: number })
  state.draft = null
  state.epic = { ...state.epic, hasDraft: false, currentRevisionId: `rv_${number}`, currentRevisionNumber: number }
  return { status: 'saved', epicId: state.epic.id, revisionId: `rv_${number}`, revisionNumber: number, contentHash: 'h', error: null }
}

function discard(state: Scenario): unknown {
  state.draft = null
  state.epic = { ...state.epic, hasDraft: false, draftRevision: null }
  return { discarded: true }
}

function updateRun(state: Scenario, patch: Partial<RunView>): RunView {
  state.run = { ...(state.run ?? runView()), ...patch }
  return state.run
}

function runHandlers(state: Scenario): Partial<Record<CommandName, Handler>> {
  return {
    getRun: () => state.run,
    getCheckpoint: () => state.checkpoint ?? notFound('No checkpoint'),
    queueRun: () => updateRun(state, { state: 'queued', activeSprintOrdinal: null }),
    pauseRun: () => updateRun(state, { state: 'paused' }),
    resumeRun: () => updateRun(state, { state: 'running' }),
    cancelRun: () => updateRun(state, { state: 'canceled' }),
    takeoverRun: () => updateRun(state, { ownedByThisMachine: true, state: 'paused' }),
    adoptRevision: (input: { revisionId: string }) => updateRun(state, { revisionId: input.revisionId }),
    authorizeAutoContinue: (input: { enabled: boolean }) => updateRun(state, { autoContinue: input.enabled }),
    grantRetry: () => updateRun(state, { state: 'running' }),
    approveAndAdvance: () => updateRun(state, { state: 'running', activeSprintOrdinal: 3 }),
    acceptAttempt: () => state.ticket.attempts[0],
    rejectAttempt: () => state.ticket.attempts[0],
    reconcileAttempt: () => state.ticket.attempts[0]
  }
}

function defaultHandlers(state: Scenario): Partial<Record<CommandName, Handler>> {
  return {
    getEpic: () => state.epic,
    getPlan: (input: { view: 'saved' | 'draft' }) => planOf(state, input.view),
    listTickets: (input: { view: 'saved' | 'draft' }) => summaries(planOf(state, input.view).bundle),
    validatePlan: () => state.validation,
    getTicket: (input: { ticketId: string; view: 'saved' | 'draft' }) => ticketOf(state, input),
    listEvents: () => ({ events: state.events, cursor: state.events.length }),
    openDraft: () => openDraft(state),
    updatePlanDraft: () => updateDraft(state),
    savePlan: () => save(state),
    discardPlanDraft: () => discard(state),
    ...runHandlers(state)
  }
}
