/** Pure view model for the ticket detail panel (Overview, Attempts, Evidence and History tabs). */
import type {
  CapabilityProfile,
  Modality,
  ReasoningEffort,
  ReasoningLevel,
  TicketContent,
  TicketSize,
  ToolCapability,
  WorkType
} from '../../../shared/domain/bundle'
import type { AttemptView, CheckStatus, EventView, TicketDetailView, TicketLinkView } from '../../../shared/domain/views'
import { formatAgo, formatCountdown } from '../epic/time'
import {
  ATTEMPT_LABELS,
  ATTEMPT_TONES,
  EXECUTION_LABELS,
  EXECUTION_TONES,
  STATUS_LABELS,
  STATUS_TONES,
  type Tone
} from '../graph/ticketStates'

export const WORK_TYPE_LABELS: Record<WorkType, string> = {
  implementation: 'Implementation',
  architecture: 'Architecture',
  investigation: 'Investigation',
  testing: 'Testing',
  review: 'Review',
  documentation: 'Documentation'
}

export const REASONING_LABELS: Record<ReasoningLevel, string> = {
  routine: 'Routine',
  multi_step: 'Multi-step',
  deep: 'Deep'
}

export const SIZE_LABELS: Record<TicketSize, string> = {
  micro: 'Micro',
  small: 'Small',
  medium: 'Medium',
  large: 'Large'
}

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High'
}

export const QUALITY_LABELS = { standard: 'Standard', high: 'High' } as const

export const COST_LABELS = { low: 'Low', normal: 'Normal' } as const

export const TOOL_LABELS: Record<ToolCapability, string> = {
  repo_read: 'Repo read',
  repo_write: 'Repo write',
  shell: 'Shell',
  browser: 'Browser',
  test_execution: 'Test execution',
  network: 'Network'
}

export const MODALITY_LABELS: Record<Modality, string> = { text: 'Text', images: 'Images' }

const CHECK_ICONS: Record<CheckStatus, string> = { passed: '✓', failed: '✗', skipped: '–' }
const MAX_FILES = 12

export interface CriterionItem {
  id: string
  text: string
  verified: boolean
  note: string
}

interface CapabilityRow {
  label: string
  value: string
  note: string
}

export interface LinkRow {
  ticketId: string
  key: string
  title: string
  label: string
  tone: Tone
}

export interface AttemptCard {
  id: string
  heading: string
  state: string
  tone: Tone
  kindLabel: string
  worker: string
  rationale: string
  lease: string
  summary: string
  commits: string[]
  files: string[]
  moreFiles: number
  failure: string
  decision: string
  reasons: string[]
  superseded: boolean
  canReview: boolean
  canAbandon: boolean
}

interface EvidenceView {
  source: string
  checks: { name: string; status: CheckStatus; detail: string; icon: string }[]
  criteria: { text: string; met: boolean; note: string }[]
  notes: string
}

interface HistoryItem {
  seq: number
  title: string
  when: string
  detail: string
}

function newestFirst(attempts: AttemptView[]): AttemptView[] {
  return [...attempts].sort((a, b) => b.number - a.number)
}

function latestWithEvidence(attempts: AttemptView[]): AttemptView | null {
  return newestFirst(attempts).find((item) => item.evidence !== null) ?? null
}

export function criteriaChecklist(ticket: TicketContent, attempts: AttemptView[]): { heading: string; items: CriterionItem[] } {
  const results = new Map((latestWithEvidence(attempts)?.evidence?.criteria ?? []).map((item) => [item.criterionId, item]))
  const items = ticket.acceptanceCriteria.map((criterion) => ({
    id: criterion.id,
    text: criterion.text,
    verified: results.get(criterion.id)?.met === true,
    note: results.get(criterion.id)?.note ?? ''
  }))
  const verified = items.filter((item) => item.verified).length
  const heading =
    items.length === 0 ? 'ACCEPTANCE CRITERIA · NONE YET' : `ACCEPTANCE CRITERIA · ${verified} OF ${items.length} VERIFIED`
  return { heading, items }
}

function roundTenth(value: number): string {
  return String(Math.round(value * 10) / 10)
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${roundTenth(tokens / 1_000_000)}M`
  }
  return tokens >= 1_000 ? `${roundTenth(tokens / 1_000)}k` : String(tokens)
}

function listOrNone(values: string[]): string {
  return values.length === 0 ? 'None' : values.join(' · ')
}

export function capabilityRows(profile: CapabilityProfile): CapabilityRow[] {
  const tokens = profile.context.estimatedInputTokens
  const override = profile.preferences.modelOverride
  return [
    { label: 'Work type', value: WORK_TYPE_LABELS[profile.workType], note: '' },
    { label: 'Reasoning', value: REASONING_LABELS[profile.reasoning.level], note: profile.reasoning.rationale },
    { label: 'Tools', value: listOrNone(profile.tools.map((tool) => TOOL_LABELS[tool])), note: '' },
    { label: 'Modalities', value: listOrNone(profile.modalities.map((item) => MODALITY_LABELS[item])), note: '' },
    tokens === null
      ? { label: 'Context', value: 'Not estimated', note: '' }
      : { label: 'Context', value: `~${formatTokens(tokens)} tokens`, note: '(estimate)' },
    ...(override === null ? [] : [{ label: 'Model override', value: override, note: '' }])
  ]
}

export function sizeAndEffortRows(ticket: TicketContent, profile: CapabilityProfile): CapabilityRow[] {
  const rows: CapabilityRow[] = []
  if (ticket.size !== undefined) {
    rows.push({ label: 'Size', value: SIZE_LABELS[ticket.size], note: '' })
  }
  if (profile.reasoning.effort !== undefined) {
    rows.push({ label: 'Effort', value: EFFORT_LABELS[profile.reasoning.effort], note: '' })
  }
  const { quality, cost } = profile.preferences
  if (quality !== null) {
    rows.push({ label: 'Quality', value: QUALITY_LABELS[quality], note: '' })
  }
  if (cost !== null) {
    rows.push({ label: 'Cost', value: COST_LABELS[cost], note: '' })
  }
  return rows
}

export function statePill(detail: TicketDetailView): { label: string; tone: Tone } {
  const execution = detail.execution
  if (execution === null) {
    const status = detail.status ?? 'backlog'
    return { label: STATUS_LABELS[status], tone: STATUS_TONES[status] }
  }
  const attempt = execution.state === 'running' && execution.attemptCount > 1 ? ` · ATTEMPT ${execution.attemptCount}` : ''
  return { label: `${EXECUTION_LABELS[execution.state]}${attempt}`, tone: EXECUTION_TONES[execution.state] }
}

/** "Sprint 2 · Authoring through MCP · rev 4 · Read-only while run #2 is active". */
export function metaLine(detail: TicketDetailView, goal: string, revisionNumber: number | null): string {
  return [
    detail.sprintOrdinal === null ? '' : `Sprint ${detail.sprintOrdinal}`,
    goal,
    revisionNumber === null ? '' : `rev ${revisionNumber}`,
    detail.readOnlyReason ?? ''
  ]
    .filter((part) => part !== '')
    .join(' · ')
}

export function linkRows(links: TicketLinkView[]): LinkRow[] {
  return links.map((item) => {
    const base = { ticketId: item.ticketId, key: item.key, title: item.title }
    if (item.executionState !== null) {
      return { ...base, label: EXECUTION_LABELS[item.executionState], tone: EXECUTION_TONES[item.executionState] }
    }
    return item.status === null
      ? { ...base, label: 'DRAFT', tone: 'neutral' }
      : { ...base, label: STATUS_LABELS[item.status], tone: STATUS_TONES[item.status] }
  })
}

function leaseLine(item: AttemptView, now: number): string {
  if (item.state === 'lease_expired') {
    return 'lease expired — needs reconciliation'
  }
  if (item.leaseExpiresAt === null || (item.state !== 'claimed' && item.state !== 'running')) {
    return ''
  }
  const heartbeat = item.heartbeatAt === null ? '' : ` · heartbeat ${formatAgo(item.heartbeatAt, now)}`
  return `lease ${formatCountdown(item.leaseExpiresAt, now)} left${heartbeat}`
}

function workerLine(item: AttemptView): string {
  const worker = item.worker
  const model = worker.modelId === null ? [] : [`model ${worker.modelId}`]
  const host = worker.hostId === null ? [] : [`host ${worker.hostId}`]
  const effort = (worker.effort === undefined || worker.effort === null) ? [] : [`effort ${worker.effort}`]
  return [worker.label, ...model, ...host, ...effort].join(' · ')
}

function decisionLine(item: AttemptView): string {
  const decision = item.decision
  if (decision === null) {
    return ''
  }
  const outcome = decision.outcome === 'accepted' ? 'Accepted' : 'Rejected'
  const notes = decision.notes === '' ? '' : `: ${decision.notes}`
  return `${outcome} by ${decision.decidedBy}${notes}`
}

function failureLine(item: AttemptView): string {
  const failure = item.failure
  if (failure === null) {
    return ''
  }
  return failure.details === '' ? failure.reason : `${failure.reason} — ${failure.details}`
}

function outputFields(item: AttemptView): Pick<AttemptCard, 'summary' | 'commits' | 'files' | 'moreFiles'> {
  const outputs = item.outputs
  const files = outputs?.changedFiles ?? []
  return {
    summary: outputs?.summary ?? '',
    commits: (outputs?.commits ?? []).map((commit) => commit.slice(0, 7)),
    files: files.slice(0, MAX_FILES),
    moreFiles: Math.max(0, files.length - MAX_FILES)
  }
}

function attemptCard(item: AttemptView, now: number): AttemptCard {
  return {
    id: item.id,
    heading: `#${item.number}`,
    state: ATTEMPT_LABELS[item.state].toUpperCase(),
    tone: ATTEMPT_TONES[item.state],
    kindLabel: item.kind === 'carry_forward' ? 'carried forward' : '',
    worker: workerLine(item),
    rationale: item.worker.rationale ?? '',
    lease: leaseLine(item, now),
    ...outputFields(item),
    failure: failureLine(item),
    decision: decisionLine(item),
    reasons: item.decision?.reasons ?? [],
    superseded: item.superseded,
    canReview: item.state === 'submitted',
    canAbandon: item.state === 'lease_expired'
  }
}

export function attemptCards(attempts: AttemptView[], now: number): AttemptCard[] {
  return newestFirst(attempts).map((item) => attemptCard(item, now))
}

export function evidenceView(ticket: TicketContent, attempts: AttemptView[]): EvidenceView | null {
  const source = latestWithEvidence(attempts)
  const evidence = source?.evidence
  if (!source || !evidence) {
    return null
  }
  const texts = new Map(ticket.acceptanceCriteria.map((criterion) => [criterion.id, criterion.text]))
  return {
    source: `From attempt #${source.number}`,
    checks: evidence.checks.map((check) => ({ ...check, icon: CHECK_ICONS[check.status] })),
    criteria: evidence.criteria.map((result) => ({
      text: texts.get(result.criterionId) ?? result.criterionId,
      met: result.met,
      note: result.note
    })),
    notes: evidence.notes
  }
}

const DETAIL_KEYS = ['reason', 'summary', 'note', 'notes', 'message']

function humanize(kind: string): string {
  const words = kind.replace(/[._]+/g, ' ').trim()
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

function eventDetail(payload: Record<string, unknown>): string {
  const key = DETAIL_KEYS.find((candidate) => typeof payload[candidate] === 'string')
  return key === undefined ? '' : String(payload[key])
}

export function historyItems(events: EventView[], ticketId: string, now: number): HistoryItem[] {
  return events
    .filter((item) => item.ticketId === ticketId)
    .sort((a, b) => b.seq - a.seq)
    .map((item) => ({ seq: item.seq, title: humanize(item.kind), when: formatAgo(item.at, now), detail: eventDetail(item.payload) }))
}
