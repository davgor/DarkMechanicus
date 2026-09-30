/**
 * Hand-written `CommandApi` stand-in for adapter tests (MCP tools, IPC handlers). Methods without
 * an override fail loudly, and every call is recorded so tests can assert on what an adapter sent.
 * Not shipped.
 */
import { DomainError } from '../core/errors'
import type { CommandApi, CommandName } from '../shared/domain/api'

interface StubCall {
  name: string
  input: unknown
}

export type StubApi = CommandApi & { calls: StubCall[] }

/** Any command method: `never` parameters accept every concrete method signature. */
type AnyMethod = (input: never) => Promise<unknown>

/** A `Record` over every command name makes the compiler flag a missing or misspelled entry. */
const COMMAND_FLAGS: Record<CommandName, true> = {
  getCapabilities: true,
  getProject: true,
  initializeRepository: true,
  getStorageStatus: true,
  flushPortableState: true,
  reconcileRepository: true,
  searchHistory: true,
  listBranchEpics: true,
  backupDatabase: true,
  listSessions: true,
  listEpics: true,
  createEpic: true,
  getEpic: true,
  setEpicStatus: true,
  setEpicBranch: true,
  getPlan: true,
  openDraft: true,
  updatePlanDraft: true,
  validatePlan: true,
  savePlan: true,
  discardPlanDraft: true,
  listRevisions: true,
  listTickets: true,
  getTicket: true,
  setTicketStatus: true,
  listProfiles: true,
  getProfile: true,
  saveProfile: true,
  registerHost: true,
  matchCapabilities: true,
  queueRun: true,
  startRun: true,
  getRun: true,
  getReadyTickets: true,
  claimTicket: true,
  heartbeatAttempt: true,
  submitAttempt: true,
  acceptAttempt: true,
  rejectAttempt: true,
  failAttempt: true,
  reconcileAttempt: true,
  carryForwardTicket: true,
  pauseRun: true,
  resumeRun: true,
  cancelRun: true,
  takeoverRun: true,
  adoptRevision: true,
  submitSprintReport: true,
  getSprintReport: true,
  getCheckpoint: true,
  approveCheckpoint: true,
  advanceSprint: true,
  approveAndAdvance: true,
  authorizeAutoContinue: true,
  grantRetry: true,
  listEvents: true
}

export const COMMAND_NAMES = Object.keys(COMMAND_FLAGS) as CommandName[]

function stubMethod(name: CommandName, override: AnyMethod | undefined, calls: StubCall[]): AnyMethod {
  return async (input?: unknown) => {
    calls.push({ name, input })
    if (override === undefined) {
      throw new DomainError('internal', `not stubbed: ${name}`)
    }
    return override(input as never)
  }
}

export function createStubApi(overrides: Partial<CommandApi> = {}): StubApi {
  const calls: StubCall[] = []
  const methods: Record<string, AnyMethod | StubCall[]> = { calls }
  for (const name of COMMAND_NAMES) {
    methods[name] = stubMethod(name, overrides[name], calls)
  }
  return methods as unknown as StubApi
}

/**
 * Stub whose listed methods resolve to fixed JSON-shaped values. Adapter tests only care that a
 * value passes through untouched, so this avoids building complete view fixtures for every command.
 */
export function createCannedApi(canned: Partial<Record<CommandName, unknown>>): StubApi {
  const overrides: Record<string, AnyMethod> = {}
  for (const name of COMMAND_NAMES) {
    if (name in canned) {
      overrides[name] = async () => canned[name]
    }
  }
  return createStubApi(overrides as Partial<CommandApi>)
}
