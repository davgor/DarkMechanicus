/**
 * A scripted, deterministic Linear transfer agent (no LLM) that follows `skills/linear-transfer.md` step by
 * step against the fake Linear MCP server, and the fixture epics it transfers. The integration test drives it
 * through the Workspace command table; `scripts/linear-transfer-smoke.mjs` drives it through the built MCP
 * server over stdio. Not shipped.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { CommandApi, DraftOp } from '../shared/domain/api'
import type {
  LinearIssueItem,
  LinearReadback,
  LinearReadbackIssue,
  LinearRelationItem,
  LinearTransferPacket,
  TransferItemKind,
  TransferItemView,
  TransferMismatch,
  TransferReadbackResult
} from '../shared/domain/transfer'
import {
  callLinear,
  type FakeIssue,
  type FakeLabel,
  type FakeMilestone,
  type FakeProject,
  type FakeRelation,
  type FakeStateType,
  type FakeTeam
} from './fakeLinearMcp'

/** What the driver asks of Dark Mechanicus: the orchestrator's transfer tools. */
type TransferApi = Pick<CommandApi, 'getCapabilities' | 'getTransfer' | 'startTransfer' | 'recordTransferItem' | 'submitTransferReadback'>

/** What planning a fixture epic asks of Dark Mechanicus. */
export type PlanApi = Pick<CommandApi, 'createEpic' | 'getPlan' | 'updatePlanDraft' | 'savePlan'>

/** What completing a ticket in Dark Mechanicus asks of it: a run, an accepted attempt, and stopping the run. */
type RunApi = Pick<CommandApi, 'getPlan' | 'startRun' | 'claimTicket' | 'submitAttempt' | 'acceptAttempt' | 'cancelRun'>

// ---------------------------------------------------------------------------------------------------------
// Fixture epics

/** Sets each sprint's acceptance node to cover the sprint's work tickets, then saves the draft. */
async function coverAndSave(api: PlanApi, epicId: string): Promise<void> {
  const { bundle } = await api.getPlan({ epicId, view: 'draft' })
  const kinds = new Map(bundle.tickets.map((ticket) => [ticket.id, ticket]))
  const ops: DraftOp[] = bundle.sprints.flatMap((sprint) => {
    const tickets = sprint.ticketIds.flatMap((id) => kinds.get(id) ?? [])
    const work = tickets.filter((ticket) => ticket.kind !== 'acceptance')
    return tickets
      .filter((ticket) => ticket.kind === 'acceptance')
      .map((node) => ({
        op: 'update_ticket' as const,
        ticket: node.id,
        patch: { acceptanceCriteria: work.map((ticket) => ({ text: `${ticket.title} is verified`, covers: ticket.id })) }
      }))
  })
  const update = await api.updatePlanDraft({ epicId, ops })
  if (!update.validation.valid) {
    throw new Error(`The fixture plan is invalid: ${JSON.stringify(update.validation.errors)}`)
  }
  const saved = await api.savePlan({ epicId, expectedDraftRevision: update.draftRevision })
  if (saved.status !== 'saved') {
    throw new Error(`The fixture plan was not saved: ${saved.status}`)
  }
}

/**
 * Two sprints. Sprint 1 has two rows (Define the API and Build the screen, then Wire the screen to the API);
 * sprint 2 has Write the guide and Release, which Wire blocks. Write the guide is related to Define the API.
 * Each sprint ends with its acceptance node. Returns the epic id.
 */
export async function planTwoSprintEpic(api: PlanApi): Promise<string> {
  const epic = await api.createEpic({ title: 'Linear handoff fixture', intent: 'Move the plan to Linear.', successCriteria: ['The plan is in Linear'] })
  const ops: DraftOp[] = [
    { op: 'add_ticket', ref: 'api', sprint: '1', ticket: { title: 'Define the API', priority: 'high', tags: ['backend'], acceptanceCriteria: ['The API is documented'] } },
    { op: 'add_ticket', ref: 'ui', sprint: '1', ticket: { title: 'Build the screen', tags: ['frontend'], acceptanceCriteria: ['The screen renders'] } },
    { op: 'add_ticket', ref: 'wire', sprint: '1', ticket: { title: 'Wire the screen to the API', tags: ['backend', 'frontend'] } },
    { op: 'add_dependency', from: 'api', to: 'wire' },
    { op: 'add_dependency', from: 'ui', to: 'wire' },
    { op: 'add_sprint', ref: 's2', sprint: { goal: 'Ship it\nWith a guide.', exitCriteria: ['Released'] } },
    { op: 'add_ticket', ref: 'guide', sprint: 's2', ticket: { title: 'Write the guide', priority: 'low', tags: ['docs'] } },
    { op: 'add_ticket', ref: 'release', sprint: 's2', ticket: { title: 'Release', priority: 'critical', tags: ['Backend'] } },
    { op: 'add_dependency', from: 'wire', to: 'release' },
    { op: 'add_relation', kind: 'related_to', from: 'guide', to: 'api' }
  ]
  await api.updatePlanDraft({ epicId: epic.id, ops })
  await coverAndSave(api, epic.id)
  return epic.id
}

/** One sprint: Prepare blocks Deliver, then the acceptance node. Returns the epic id. */
export async function planOneSprintEpic(api: PlanApi): Promise<string> {
  const epic = await api.createEpic({ title: 'Cancel path fixture', successCriteria: ['It is in Linear'] })
  const ops: DraftOp[] = [
    { op: 'add_ticket', ref: 'prepare', sprint: '1', ticket: { title: 'Prepare', tags: ['ops'] } },
    { op: 'add_ticket', ref: 'deliver', sprint: '1', ticket: { title: 'Deliver', priority: 'high' } },
    { op: 'add_dependency', from: 'prepare', to: 'deliver' }
  ]
  await api.updatePlanDraft({ epicId: epic.id, ops })
  await coverAndSave(api, epic.id)
  return epic.id
}

/**
 * Completes the saved epic's ticket titled `title` the way Dark Mechanicus does, by an accepted attempt in a run,
 * then cancels the run, since a transfer is queued only while no run is active. Returns the ticket id.
 */
export async function completeTicket(api: RunApi, epicId: string, title: string): Promise<string> {
  const { bundle } = await api.getPlan({ epicId, view: 'saved' })
  const ticketId = bundle.tickets.find((ticket) => ticket.title === title)?.id ?? fail(`The fixture has no ticket ${title}.`)
  const run = await api.startRun({ epicId })
  const claim = await api.claimTicket({ runId: run.id, ticketId, worker: { label: 'fixture-worker' } })
  await api.submitAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken, outputs: { summary: `Delivered ${title}.` } })
  await api.acceptAttempt({ attemptId: claim.attempt.id })
  await api.cancelRun({ runId: run.id, reason: 'The rest of the epic moves to Linear.' })
  return ticketId
}

// ---------------------------------------------------------------------------------------------------------
// The driver

/** A point the driver passes: right after it created a Linear item, or right after it recorded one. */
export interface DriverStep {
  phase: 'created' | 'recorded'
  kind: TransferItemKind
  ref: string
  /** How many issues are recorded at this point. */
  recordedIssues: number
}

/** Thrown when `interrupt` stops the driver, as if its session had crashed at that step. */
export class TransferInterrupted extends Error {}

interface DriverOptions {
  dm: TransferApi
  linear: Client
  epicId: string
  /** The team the person picked. */
  teamKey: string
  /** Names this agent session's idempotency keys (with the epic id), so a resumed session never reuses one. */
  session: string
  /** Issues per read-back page; each page is one read-back part. */
  pageSize?: number
  /** Called after each create and each record; true stops the driver there. */
  interrupt?: (step: DriverStep) => boolean
  /** Creates the issues the packet marks completed in the default state, as an agent that skipped that step would. */
  leaveCompletedOpen?: boolean
}

interface TransferLog {
  /** The transfer was already in progress when this session started. */
  resumed: boolean
  /** How many refs were already recorded. */
  alreadyRecorded: number
  /** The refs this session created in Linear, in order. */
  created: string[]
  /** The refs this session found in Linear (by marker, or a relation by listing) and recorded. */
  adopted: string[]
}

interface VerifyLog {
  /** Each read-back's final result, in order. */
  results: TransferReadbackResult[]
  /** What the driver changed in Linear between read-backs. */
  fixes: string[]
}

interface Placed {
  linearId: string
  identifier?: string
  url?: string
}

interface ReadProject {
  parts: LinearReadback[]
  issues: FakeIssue[]
}

type Item =
  | { kind: 'project'; ref: string; packet: LinearTransferPacket['project'] }
  | { kind: 'milestone'; ref: string; packet: LinearTransferPacket['milestones'][number] }
  | { kind: 'issue'; ref: string; packet: LinearIssueItem }
  | { kind: 'relation'; ref: string; packet: LinearRelationItem }

const PAGE_SIZE = 3

function hasMarkerLine(marker: string, ...texts: string[]): boolean {
  return texts.some((text) => text.split('\n').some((line) => line.trim() === marker))
}

/** A relation's ends as the fake's create takes them. */
function relationEnds(relation: LinearRelationItem): Omit<FakeRelation, 'id'> {
  return relation.kind === 'blocks'
    ? { type: 'blocks', issueId: relation.blockerRef, relatedIssueId: relation.blockedRef }
    : { type: 'related', issueId: relation.fromRef, relatedIssueId: relation.toRef }
}

function readIssue(issue: FakeIssue): LinearReadbackIssue {
  const { id, identifier, milestoneId, title, description, priority, labels, stateType, sortOrder } = issue
  return { linearId: id, identifier, milestoneId, title, description, priority, labels, stateType, sortOrder }
}

export class TransferDriver {
  private packet: LinearTransferPacket | null = null
  private recorded = new Map<string, TransferItemView>()
  private teamId = ''
  private states: { name: string; type: FakeStateType }[] = []
  private keys = 0

  constructor(private readonly options: DriverOptions) {}

  /** Guide steps 1 to 6 (and 8 on a resume): start or resume, then place every unrecorded ref in order. */
  async transfer(): Promise<TransferLog> {
    const { dm, epicId } = this.options
    const capabilities = await dm.getCapabilities()
    if (capabilities.role !== 'orchestrator') {
      throw new Error(`The transfer needs an orchestrator session, not ${capabilities.role}.`)
    }
    const before = await dm.getTransfer({ epicId })
    const started = await dm.startTransfer({ epicId, idempotencyKey: this.key('start') })
    this.load(started.packet, started.recorded)
    const log: TransferLog = { resumed: before.status === 'in_progress', alreadyRecorded: started.recorded.length, created: [], adopted: [] }
    await this.pickTeam()
    await this.ensureLabels()
    for (const ref of started.next) {
      await this.place(this.itemOf(ref), log)
    }
    return log
  }

  /**
   * Guide step 7: read the whole project back and submit it; after a mismatch fix each one and read the whole
   * project back again from the start. Stops at a verified read-back or after `maxRounds` read-backs, fixing
   * after each rejected one; the last result tells which.
   */
  async verify(maxRounds = 3): Promise<VerifyLog> {
    const { dm, epicId } = this.options
    const view = await dm.getTransfer({ epicId })
    this.load(view.packet ?? fail('The transfer has no packet.'), view.recorded)
    await this.pickTeam()
    const log: VerifyLog = { results: [], fixes: [] }
    for (let round = 0; round < maxRounds; round += 1) {
      const read = await this.readBack()
      const result = await this.submit(read.parts)
      log.results.push(result)
      if (result.status === 'verified') {
        return log
      }
      log.fixes.push(...(await this.fix(result.mismatches, read.issues)))
    }
    return log
  }

  private key(action: string): string {
    this.keys += 1
    return `${this.options.session}:${this.options.epicId}:${action}:${this.keys}`
  }

  private load(packet: LinearTransferPacket, recorded: TransferItemView[]): void {
    this.packet = packet
    this.recorded = new Map(recorded.map((item) => [item.ref, item]))
  }

  private linearIdOf(ref: string): string {
    return this.recorded.get(ref)?.linearId ?? fail(`Ref ${ref} is not recorded.`)
  }

  private itemOf(ref: string): Item {
    const packet = this.packet ?? fail('The transfer has not started.')
    if (ref === packet.project.ref) {
      return { kind: 'project', ref, packet: packet.project }
    }
    const milestone = packet.milestones.find((item) => item.ref === ref)
    const issue = packet.issues.find((item) => item.ref === ref)
    const relation = packet.relations.find((item) => item.ref === ref)
    if (milestone !== undefined) {
      return { kind: 'milestone', ref, packet: milestone }
    }
    if (issue !== undefined) {
      return { kind: 'issue', ref, packet: issue }
    }
    return relation === undefined ? fail(`Ref ${ref} is not in the packet.`) : { kind: 'relation', ref, packet: relation }
  }

  /** Guide step 3: the team the person picked. */
  private async pickTeam(): Promise<void> {
    const { linear, teamKey } = this.options
    const { teams } = await callLinear<{ teams: FakeTeam[] }>(linear, 'list_teams')
    this.teamId = teams.find((team) => team.key === teamKey)?.id ?? fail(`No team ${teamKey}.`)
    const { statuses } = await callLinear<{ statuses: { name: string; type: FakeStateType }[] }>(linear, 'list_issue_statuses', { teamId: this.teamId })
    this.states = statuses
  }

  private stateName(type: FakeStateType): string {
    return this.states.find((state) => state.type === type)?.name ?? fail(`The team has no ${type} state.`)
  }

  /** Guide step 4: find each label the issues use, or create it once. */
  private async ensureLabels(): Promise<void> {
    const { linear } = this.options
    const { labels } = await callLinear<{ labels: FakeLabel[] }>(linear, 'list_issue_labels', { teamId: this.teamId })
    const known = new Set(labels.map((label) => label.name.toLowerCase()))
    for (const name of (this.packet?.issues ?? []).flatMap((issue) => issue.labels)) {
      if (!known.has(name.toLowerCase())) {
        await callLinear(linear, 'create_issue_label', { teamId: this.teamId, name })
        known.add(name.toLowerCase())
      }
    }
  }

  /** Guide step 5: search by marker (a relation: list the existing ones) before creating, then record. */
  private async place(item: Item, log: TransferLog): Promise<void> {
    const found = await this.findExisting(item)
    if (found === null) {
      const created = await this.create(item)
      log.created.push(item.ref)
      this.checkpoint('created', item)
      await this.record(item, created)
    } else {
      log.adopted.push(item.ref)
      await this.record(item, found)
    }
    this.checkpoint('recorded', item)
  }

  private checkpoint(phase: DriverStep['phase'], item: Item): void {
    const recordedIssues = [...this.recorded.values()].filter((entry) => entry.kind === 'issue').length
    if (this.options.interrupt?.({ phase, kind: item.kind, ref: item.ref, recordedIssues }) === true) {
      throw new TransferInterrupted(`Interrupted right after ${phase === 'created' ? 'creating' : 'recording'} ${item.ref}.`)
    }
  }

  private async record(item: Item, placed: Placed): Promise<void> {
    const recorded = await this.options.dm.recordTransferItem({ epicId: this.options.epicId, ref: item.ref, ...placed })
    this.recorded.set(item.ref, recorded)
  }

  private async findExisting(item: Item): Promise<Placed | null> {
    const { linear } = this.options
    if (item.kind === 'relation') {
      return this.findRelation(item.packet)
    }
    if (item.kind === 'project') {
      const { projects } = await callLinear<{ projects: FakeProject[] }>(linear, 'search_projects', { query: item.packet.marker })
      const project = projects.find((found) => hasMarkerLine(item.packet.marker, found.summary, found.content))
      return project === undefined ? null : { linearId: project.id, url: project.url }
    }
    const projectId = this.linearIdOf('project')
    if (item.kind === 'milestone') {
      const { milestones } = await callLinear<{ milestones: FakeMilestone[] }>(linear, 'search_milestones', { query: item.packet.marker })
      const milestone = milestones.find((found) => found.projectId === projectId && hasMarkerLine(item.packet.marker, found.description))
      return milestone === undefined ? null : { linearId: milestone.id }
    }
    const { issues } = await callLinear<{ issues: FakeIssue[] }>(linear, 'search_issues', { query: item.packet.marker })
    const issue = issues.find((found) => found.projectId === projectId && hasMarkerLine(item.packet.marker, found.description))
    return issue === undefined ? null : { linearId: issue.id, identifier: issue.identifier, url: issue.url }
  }

  /** Guide step 6: the relations of the blocked issue (or the related link's target) already in Linear. */
  private async findRelation(relation: LinearRelationItem): Promise<Placed | null> {
    const ends = relationEnds(relation)
    const wanted = { type: ends.type, issueId: this.linearIdOf(ends.issueId), relatedIssueId: this.linearIdOf(ends.relatedIssueId) }
    const { relations } = await callLinear<{ relations: FakeRelation[] }>(this.options.linear, 'list_issue_relations', { issueId: wanted.relatedIssueId })
    const found = relations.find((item) => {
      const forward = item.issueId === wanted.issueId && item.relatedIssueId === wanted.relatedIssueId
      const backward = item.issueId === wanted.relatedIssueId && item.relatedIssueId === wanted.issueId
      return item.type === wanted.type && (forward || (wanted.type === 'related' && backward))
    })
    return found === undefined ? null : { linearId: found.id }
  }

  private async create(item: Item): Promise<Placed> {
    const { linear } = this.options
    if (item.kind === 'project') {
      const { name, summary, content } = item.packet
      const project = await callLinear<FakeProject>(linear, 'create_project', { teamId: this.teamId, name, summary, content })
      return { linearId: project.id, url: project.url }
    }
    if (item.kind === 'milestone') {
      const { name, description } = item.packet
      const milestone = await callLinear<FakeMilestone>(linear, 'create_milestone', { projectId: this.linearIdOf('project'), name, description })
      return { linearId: milestone.id }
    }
    if (item.kind === 'issue') {
      return this.createIssue(item.packet)
    }
    const ends = relationEnds(item.packet)
    const args = { type: ends.type, issueId: this.linearIdOf(ends.issueId), relatedIssueId: this.linearIdOf(ends.relatedIssueId) }
    return { linearId: (await callLinear<FakeRelation>(linear, 'create_issue_relation', args)).id }
  }

  /** One issue in its milestone, with the packet's text, priority and labels; completed only when the packet says so. */
  private async createIssue(issue: LinearIssueItem): Promise<Placed> {
    const created = await callLinear<FakeIssue>(this.options.linear, 'create_issue', {
      teamId: this.teamId,
      projectId: this.linearIdOf('project'),
      milestoneId: this.linearIdOf(issue.milestoneRef),
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      labels: issue.labels,
      sortOrder: issue.position,
      ...(issue.state === 'completed' && this.options.leaveCompletedOpen !== true ? { state: this.stateName('completed') } : {})
    })
    return { linearId: created.id, identifier: created.identifier, url: created.url }
  }

  /** The whole project: the project and its milestones, then one part per page of issues with their relations. */
  private async readBack(): Promise<ReadProject> {
    const { linear } = this.options
    const projectId = this.linearIdOf('project')
    const { id, url, name, summary, content } = await callLinear<FakeProject>(linear, 'get_project', { id: projectId })
    const { milestones } = await callLinear<{ milestones: FakeMilestone[] }>(linear, 'list_milestones', { projectId })
    const parts: LinearReadback[] = [
      { project: { linearId: id, url, name, summary, content }, milestones: milestones.map((item) => ({ linearId: item.id, name: item.name, description: item.description })) }
    ]
    const issues: FakeIssue[] = []
    let after: string | null = null
    do {
      const page: { issues: FakeIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } = await callLinear(linear, 'list_issues', {
        projectId,
        first: this.options.pageSize ?? PAGE_SIZE,
        ...(after === null ? {} : { after })
      })
      issues.push(...page.issues)
      const relations = page.issues.flatMap((issue) => issue.relations.map((item) => ({ kind: item.type, fromId: item.issueId, toId: item.relatedIssueId })))
      parts.push({ issues: page.issues.map(readIssue), relations })
      after = page.pageInfo.endCursor
    } while (after !== null)
    return { parts, issues }
  }

  /** Every part in order; only the last is final, and its result is the read-back's. */
  private async submit(parts: LinearReadback[]): Promise<TransferReadbackResult> {
    const { dm, epicId } = this.options
    let result: TransferReadbackResult | null = null
    for (const [at, readback] of parts.entries()) {
      result = await dm.submitTransferReadback({ epicId, readback, final: at === parts.length - 1 })
      if (at < parts.length - 1 && result.status !== 'partial') {
        throw new Error(`A read-back part that is not final came back ${result.status}.`)
      }
    }
    return result ?? fail('A read-back has at least one part.')
  }

  /** Updates each mismatched issue to the packet, or moves an unexpected one out of the project; never deletes. */
  private async fix(mismatches: TransferMismatch[], issues: FakeIssue[]): Promise<string[]> {
    const fixes: string[] = []
    const moved = new Set<string>()
    for (const mismatch of mismatches) {
      if (mismatch.field === 'unexpected') {
        const issue = issues.find((item) => item.identifier === mismatch.actual) ?? fail(`Cannot move ${String(mismatch.actual)} out: it is not an issue.`)
        await callLinear(this.options.linear, 'update_issue', { id: issue.id, projectId: null })
        moved.add(mismatch.ref)
        fixes.push(`moved ${issue.identifier} out of the project`)
      } else if (!(mismatch.field === 'duplicate' && moved.has(mismatch.ref))) {
        fixes.push(await this.updateToPacket(mismatch))
      }
    }
    return fixes
  }

  private async updateToPacket(mismatch: TransferMismatch): Promise<string> {
    const issue = this.packet?.issues.find((item) => item.ref === mismatch.ref)
    const fields: Partial<Record<TransferMismatch['field'], Record<string, unknown>>> =
      issue === undefined
        ? {}
        : {
            milestone: { milestoneId: this.linearIdOf(issue.milestoneRef) },
            title: { title: issue.title },
            description: { description: issue.description },
            priority: { priority: issue.priority },
            labels: { labels: issue.labels },
            state: { state: this.stateName(issue.state === 'completed' ? 'completed' : 'unstarted') }
          }
    const update = fields[mismatch.field] ?? fail(`The driver cannot fix a ${mismatch.field} mismatch of ${mismatch.ref}.`)
    await callLinear(this.options.linear, 'update_issue', { id: this.linearIdOf(mismatch.ref), ...update })
    return `updated the ${mismatch.field} of ${mismatch.key ?? mismatch.ref}`
  }
}

function fail(message: string): never {
  throw new Error(message)
}
