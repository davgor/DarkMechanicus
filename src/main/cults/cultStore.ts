/**
 * The cult repository over the app database (`appDatabase.ts`, v5 tables). Cults are app-level, not per folder.
 * Every write is one transaction that also appends its pipeline event, so a crash never leaves a state change
 * without its event or a run ended with petitions still pending. Lifecycle moves are decided by the pure
 * `runState` machine; roster and run worker type rules by `archetypes.ts`. Processes, timers and IPC live elsewhere.
 */
import type { Db } from '../../core/db/database'
import type { DynamicWorkerTypeInput, RunWorkerType } from '../../shared/cults/archetypes'
import type {
  CultEventInput,
  CultEventPage,
  CultEventPageRequest,
  CultEventView,
  CultInput,
  CultMemberView,
  CultPetitionView,
  CultRunView,
  CultView,
  MemberInput,
  MemberUpdate,
  PetitionDecisionInput,
  PetitionInput,
  RunStartInput,
  SlotCoverage,
  SpecialistReportInput,
  SpecialistReportView
} from '../../shared/cults/cult'
import type { RunEvent } from '../../shared/cults/runState'
import * as members from './cultMembers'
import * as petitions from './cultPetitions'
import { findCult, type StoreContext } from './cultRecords'
import * as runs from './cultRuns'

export interface CultStore {
  createCult(input: CultInput): CultView
  /** Replaces the definition; omitted `slots` keep the roster while the archetype is unchanged. */
  updateCult(cultId: string, input: CultInput): CultView
  /** Cascades to the cult's runs and everything they hold; refused while a run is active. */
  deleteCult(cultId: string): void
  getCult(cultId: string): CultView | null
  listCults(): CultView[]
  /** Refused with `active_run_exists` while another run of the cult is active. */
  startRun(cultId: string, input: RunStartInput): CultRunView
  /** Persists one lifecycle move and its event atomically; illegal moves are `invalid_state`. */
  transitionRun(runId: string, event: RunEvent, summary?: string): CultRunView
  setChronicle(runId: string, chronicle: string): CultRunView
  recordShrine(runId: string, shrine: { path: string; revision: string }): CultRunView
  getRun(runId: string): CultRunView | null
  /** Newest first. */
  listRuns(cultId?: string): CultRunView[]
  /** Runs not yet ended, for restart reconciliation. */
  activeRunsOnStartup(): CultRunView[]
  addMember(runId: string, input: MemberInput): CultMemberView
  updateMember(runId: string, chatId: string, change: MemberUpdate): CultMemberView
  listMembers(runId: string): CultMemberView[]
  createWorkerType(runId: string, creatorChatId: string, input: DynamicWorkerTypeInput): RunWorkerType
  retireWorkerType(runId: string, typeId: string): RunWorkerType
  /** Retired types included: completed-run history keeps them. */
  listWorkerTypes(runId: string): RunWorkerType[]
  submitReport(runId: string, input: SpecialistReportInput): SpecialistReportView
  listReports(runId: string): SpecialistReportView[]
  slotCoverage(runId: string): SlotCoverage[]
  createPetition(runId: string, input: PetitionInput, memberName?: string | null): CultPetitionView
  decidePetition(petitionId: string, decision: PetitionDecisionInput): CultPetitionView
  listPetitions(runId: string): CultPetitionView[]
  appendEvent(runId: string, input: CultEventInput): CultEventView
  pageEvents(runId: string, request?: CultEventPageRequest): CultEventPage
}

export function createCultStore(options: { db: Db; now?: () => string }): CultStore {
  const ctx: StoreContext = { db: options.db, now: options.now ?? (() => new Date().toISOString()) }
  return {
    createCult: (input) => runs.createCult(ctx, input),
    updateCult: (cultId, input) => runs.updateCult(ctx, cultId, input),
    deleteCult: (cultId) => runs.deleteCult(ctx, cultId),
    getCult: (cultId) => findCult(ctx.db, cultId),
    listCults: () => runs.listCults(ctx),
    startRun: (cultId, input) => runs.startRun(ctx, cultId, input),
    transitionRun: (runId, event, summary) => runs.transitionRun(ctx, runId, event, summary),
    setChronicle: (runId, chronicle) => runs.setChronicle(ctx, runId, chronicle),
    recordShrine: (runId, shrine) => runs.recordShrine(ctx, runId, shrine),
    getRun: (runId) => runs.getRun(ctx, runId),
    listRuns: (cultId) => runs.listRuns(ctx, cultId),
    activeRunsOnStartup: () => runs.activeRunsOnStartup(ctx),
    addMember: (runId, input) => members.addMember(ctx, runId, input),
    updateMember: (runId, chatId, change) => members.updateMember(ctx, runId, chatId, change),
    listMembers: (runId) => members.listMembers(ctx, runId),
    createWorkerType: (runId, creatorChatId, input) => members.createWorkerType(ctx, runId, creatorChatId, input),
    retireWorkerType: (runId, typeId) => members.retireWorkerType(ctx, runId, typeId),
    listWorkerTypes: (runId) => members.listWorkerTypes(ctx, runId),
    submitReport: (runId, input) => members.submitReport(ctx, runId, input),
    listReports: (runId) => members.listReports(ctx, runId),
    slotCoverage: (runId) => members.slotCoverage(ctx, runId),
    createPetition: (runId, input, memberName) => petitions.createPetition(ctx, runId, input, memberName ?? null),
    decidePetition: (petitionId, decision) => petitions.decidePetition(ctx, petitionId, decision),
    listPetitions: (runId) => petitions.listPetitions(ctx, runId),
    appendEvent: (runId, input) => petitions.appendEvent(ctx, runId, input),
    pageEvents: (runId, request) => petitions.pageEvents(ctx, runId, request)
  }
}
