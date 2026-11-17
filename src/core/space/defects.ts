/**
 * Escaped defects: the storage rule every `escaped_defect` observation obeys (`defectProblem`, applied by the ledger
 * on record and import) and the pure read model over them (`resolveDefects`). Types and vocabulary live in
 * `src/shared/domain/performance.ts`.
 *
 * A defect is its first report. Later records cite a report (evidence `defect`) instead of changing it, so a
 * duplicate, a reassessment, a fix or a withdrawal adds evidence and never deletes any. Records are linked by
 * reference, so their order in a call never decides what they link to; reassessments of one defect apply in ledger
 * order (`recordedAt`, then id, which follows call order for server-assigned ids). Records that change charging need
 * a human or server source, or the server's review stamp (`DEFECT_AUTHORITY`), so no worker can blame, clear or
 * redirect a defect.
 */
import {
  DEFECT_ATTRIBUTIONS,
  DEFECT_AUTHORITY,
  DEFECT_EVENTS,
  DEFECT_LINKS,
  type DefectAnomaly,
  type DefectAttribution,
  type DefectEvent,
  type DefectOrigin,
  DISCOVERY_PHASES,
  type DiscoveryPhase,
  type EscapedDefect,
  type EscapedDefectsView
} from '../../shared/domain/performance'
import {
  type EvidenceKind,
  type EvidenceRef,
  type MetricAttributes,
  type MetricObservation,
  REGRESSION_SEVERITIES,
  type RegressionSeverity
} from '../../shared/domain/space'
import type { LedgerProblem } from './ledger'

type LinkName = keyof typeof DEFECT_LINKS

/** The evidence kinds each link may cite. */
const LINK_KINDS: Readonly<Record<LinkName, readonly EvidenceKind[]>> = {
  sourceBuild: ['commit'],
  origin: ['ticket', 'attempt'],
  defect: ['observation'],
  duplicate: ['observation'],
  fixedBy: ['commit', 'ticket', 'attempt']
}

const LINK_BY_DETAIL: ReadonlyMap<string, LinkName> = new Map(
  (Object.entries(DEFECT_LINKS) as [LinkName, string][]).map(([name, detail]) => [detail, name])
)

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/** The evidence of a defect record grouped by link (references without a link detail are plain citations). */
function linksOf(evidence: readonly EvidenceRef[]): Map<LinkName, EvidenceRef[]> {
  const links = new Map<LinkName, EvidenceRef[]>()
  for (const ref of evidence) {
    const name = ref.detail === null ? undefined : LINK_BY_DETAIL.get(ref.detail)
    if (name !== undefined) {
      links.set(name, [...(links.get(name) ?? []), ref])
    }
  }
  return links
}

const problem = (path: string, message: string): LedgerProblem => ({ path, message })

interface AttributeRule {
  name: string
  /** The values it takes; null: any non-empty text. */
  values: readonly string[] | null
  required: readonly DefectEvent[]
  allowed: readonly DefectEvent[]
}

/** The defect vocabulary's attributes. Any other attribute (a delivery's `sourceEvent`, say) is the caller's. */
const ATTRIBUTE_RULES: readonly AttributeRule[] = [
  { name: 'severity', values: REGRESSION_SEVERITIES, required: ['report'], allowed: ['report', 'reassessment'] },
  { name: 'attribution', values: DEFECT_ATTRIBUTIONS, required: ['report'], allowed: ['report', 'reassessment'] },
  { name: 'discoveryPhase', values: DISCOVERY_PHASES, required: ['report'], allowed: ['report'] },
  { name: 'defectKey', values: null, required: [], allowed: ['report'] },
  { name: DEFECT_AUTHORITY.attribute, values: [DEFECT_AUTHORITY.review], required: [], allowed: DEFECT_EVENTS }
]

function ruleProblem(rule: AttributeRule, event: DefectEvent, value: unknown): LedgerProblem | null {
  const path = `attributes.${rule.name}`
  if (value === undefined) {
    return rule.required.includes(event) ? problem(path, `A defect ${event} names its ${rule.name}`) : null
  }
  if (!rule.allowed.includes(event)) {
    return problem(path, `A defect ${event} has no ${rule.name}`)
  }
  if (rule.values === null) {
    return typeof value === 'string' && value.trim() !== '' ? null : problem(path, 'Expected a non-empty text')
  }
  return oneOf(rule.values, value) ? null : problem(path, `Expected one of ${rule.values.join(', ')}`)
}

function attributeProblem(event: DefectEvent, attributes: MetricAttributes): LedgerProblem | null {
  for (const rule of ATTRIBUTE_RULES) {
    const issue = ruleProblem(rule, event, attributes[rule.name])
    if (issue !== null) {
      return issue
    }
  }
  const changes = attributes.severity !== undefined || attributes.attribution !== undefined
  return event !== 'reassessment' || changes ? null : problem('attributes', 'A reassessment changes the severity, the attribution or both')
}

interface LinkCount {
  min: number
  max: number
  text: string
}

const ONE: LinkCount = { min: 1, max: 1, text: 'exactly one' }
const NONE: LinkCount = { min: 0, max: 0, text: 'no' }
const ORIGIN: LinkCount = { min: 0, max: 2, text: 'at most two' }

/** How many references of each link each event carries; a link not listed is refused. */
const LINK_COUNTS: Readonly<Record<DefectEvent, Partial<Record<LinkName, LinkCount>>>> = {
  report: { sourceBuild: ONE, origin: ORIGIN },
  duplicate: { defect: ONE, duplicate: ONE },
  reassessment: { defect: ONE, origin: ORIGIN },
  fix: { defect: ONE, fixedBy: { min: 1, max: Number.POSITIVE_INFINITY, text: 'at least one' } },
  withdrawal: { defect: ONE }
}

function oneLinkProblem(event: DefectEvent, name: LinkName, refs: readonly EvidenceRef[]): LedgerProblem | null {
  const kinds = LINK_KINDS[name]
  const wrong = refs.find((ref) => !kinds.includes(ref.kind))
  if (wrong !== undefined) {
    return problem('evidence', `A "${DEFECT_LINKS[name]}" link cites a ${kinds.join(' or ')}, not a ${wrong.kind}`)
  }
  const count = LINK_COUNTS[event][name] ?? NONE
  const fits = refs.length >= count.min && refs.length <= count.max
  return fits ? null : problem('evidence', `A defect ${event} has ${count.text} "${DEFECT_LINKS[name]}" link (${kinds.join(' or ')}), not ${refs.length}`)
}

/** Each link cites its kinds, each event carries its links in their counts, and a duplicate names another report. */
function linkProblem(event: DefectEvent, links: Map<LinkName, EvidenceRef[]>): LedgerProblem | null {
  for (const name of Object.keys(DEFECT_LINKS) as LinkName[]) {
    const issue = oneLinkProblem(event, name, links.get(name) ?? [])
    if (issue !== null) {
      return issue
    }
  }
  const [defect] = links.get('defect') ?? []
  const [duplicate] = links.get('duplicate') ?? []
  return duplicate !== undefined && duplicate.id === defect?.id ? problem('evidence', 'A duplicate record cites two different reports') : null
}

/** Why the origin links do not fit the attribution: attributed names a ticket and its accepted attempt, a candidate a ticket, unassigned nothing. */
function originProblem(attribution: unknown, origin: readonly EvidenceRef[]): LedgerProblem | null {
  const tickets = origin.filter((ref) => ref.kind === 'ticket').length
  const attempts = origin.length - tickets
  if (attribution === undefined || attribution === 'unassigned') {
    return origin.length === 0 ? null : problem('evidence', 'Only a record attributing a defect (attributed or candidate) names an origin')
  }
  if (tickets !== 1) {
    return problem('evidence', `A defect attributed as ${String(attribution)} names exactly one origin ticket (evidence detail "${DEFECT_LINKS.origin}")`)
  }
  if (attribution === 'attributed' && attempts !== 1) {
    return problem('evidence', `An attributed defect names the accepted attempt it escaped from (evidence attempt, detail "${DEFECT_LINKS.origin}")`)
  }
  return null
}

/**
 * Whether a defect record changes what is charged: every record but a report that blames no one (a candidate or
 * unassigned report only adds a defect nobody is charged for).
 */
export function defectChangesCharging(attributes: MetricAttributes): boolean {
  return attributes.defectEvent !== 'report' || attributes.attribution === 'attributed'
}

/**
 * A record that changes charging comes from a person, from the server, or from an agent session the server stamped
 * as holding `attempt.review` (an orchestrator or reviewer). A worker's or host's record that does is refused.
 */
function authorityProblem(observation: MetricObservation): LedgerProblem | null {
  const { source, attributes } = observation
  const stamped = attributes[DEFECT_AUTHORITY.attribute] === DEFECT_AUTHORITY.review
  if (stamped && (source.kind === 'human' || source.kind === 'server')) {
    return problem(`attributes.${DEFECT_AUTHORITY.attribute}`, 'Only an agent or host record carries the review stamp')
  }
  const trusted = source.kind === 'human' || source.kind === 'server' || stamped
  return trusted || !defectChangesCharging(attributes)
    ? null
    : problem('source', `A defect ${String(attributes.defectEvent)} that changes charging comes from a person, the server, or a session holding attempt.review`)
}

/**
 * Why an `escaped_defect` observation cannot be stored, or null for any other metric. A record is an observed event
 * of an epic naming its `defectEvent`: a report counts 1 and names its severity, attribution, discovery phase, the
 * build it was found in and an origin that fits the attribution; every later record counts 0 and cites the report it
 * is about. A record that changes charging needs authority (`authorityProblem`).
 */
export function defectProblem(observation: MetricObservation): LedgerProblem | null {
  if (observation.metric !== 'escaped_defect') {
    return null
  }
  const { attributes } = observation
  const event = attributes.defectEvent
  if (!oneOf(DEFECT_EVENTS, event)) {
    return problem('attributes.defectEvent', `An escaped defect record names its defectEvent: one of ${DEFECT_EVENTS.join(', ')}`)
  }
  const links = linksOf(observation.evidence)
  return (
    recordProblem(event, observation) ??
    attributeProblem(event, attributes) ??
    linkProblem(event, links) ??
    originProblem(attributes.attribution, links.get('origin') ?? []) ??
    authorityProblem(observation)
  )
}

/** A defect record belongs to an epic and is observed, a report counting 1 and every later record 0. */
function recordProblem(event: DefectEvent, { scope, measurement }: MetricObservation): LedgerProblem | null {
  if (scope.epicId === null) {
    return problem('scope.epicId', 'An escaped defect record belongs to an epic (the epic of its origin)')
  }
  const value = event === 'report' ? 1 : 0
  return measurement.state === 'observed' && measurement.value === value ? null : problem('measurement', `A defect ${event} is observed with value ${value}`)
}

// ---------------------------------------------------------------------------------------------------------------
// Read model

/** Ledger order: server time, then id (a call's server-assigned ids follow call order). */
function ledgerOrder(a: MetricObservation, b: MetricObservation): number {
  return a.recordedAt.localeCompare(b.recordedAt) || a.observationId.localeCompare(b.observationId)
}

function linkedId(observation: MetricObservation, name: LinkName): string | null {
  return observation.evidence.find((ref) => ref.detail === DEFECT_LINKS[name] && LINK_KINDS[name].includes(ref.kind))?.id ?? null
}

function originOf(observation: MetricObservation): DefectOrigin | null {
  const origin = observation.evidence.filter((ref) => ref.detail === DEFECT_LINKS.origin)
  const ticket = origin.find((ref) => ref.kind === 'ticket')
  return ticket === undefined ? null : { ticketId: ticket.id, attemptId: origin.find((ref) => ref.kind === 'attempt')?.id ?? null }
}

/** What two reports under one defect key must agree on to be one defect: severity, attribution and origin. */
function judgement(report: MetricObservation): string {
  const origin = originOf(report)
  return JSON.stringify([report.attributes.severity, report.attributes.attribution, origin?.ticketId ?? null, origin?.attemptId ?? null])
}

/**
 * Groups reports into defects: reports agreeing under one defect key in one epic, or joined by a duplicate record.
 * Each group remembers the report it reads (`base`): its first report, or the report a duplicate record names as the
 * defect when it joins another report to it.
 */
class ReportGroups {
  private readonly parent = new Map<string, string>()
  private readonly preferred = new Map<string, string>()

  constructor(private readonly rank: ReadonlyMap<string, number>) {
    for (const id of rank.keys()) {
      this.parent.set(id, id)
    }
  }

  /** Whether `id` is a report known here (a type guard, so a linked id that is null is not one). */
  has(id: string | null): id is string {
    return id !== null && this.rank.has(id)
  }

  root(id: string): string {
    let current = id
    while (this.parent.get(current) !== current) {
      current = this.parent.get(current) ?? current
    }
    this.parent.set(id, current)
    return current
  }

  /** The report the group of `id` reads. */
  base(id: string): string {
    const root = this.root(id)
    return this.preferred.get(root) ?? root
  }

  /**
   * Joins the group of `duplicate` into the group of `defect`. The earlier first report stays the defect's id; the
   * joined group reads what `defect`'s group reads, so the record naming the defect decides what the defect says.
   */
  join(defect: string, duplicate: string): void {
    const [left, right] = [this.root(defect), this.root(duplicate)]
    if (left === right) {
      return
    }
    const base = this.base(left)
    const [keep, drop] = (this.rank.get(left) ?? 0) <= (this.rank.get(right) ?? 0) ? [left, right] : [right, left]
    this.parent.set(drop, keep)
    this.preferred.set(keep, base)
  }
}

/**
 * Joins reports under one defect key in one epic: each report joins the first group of that key whose judgement
 * (severity, attribution, origin) it shares, so agreeing reports count once however many disagreeing ones came
 * between them. A report that agrees with none starts its own group, listed as conflicting with the key's first report,
 * so neither silently wins.
 */
function groupByKey(reports: readonly MetricObservation[], groups: ReportGroups, anomalies: DefectAnomaly[]): void {
  const byKey = new Map<string, Map<string, string>>()
  for (const report of reports) {
    const { defectKey } = report.attributes
    if (typeof defectKey !== 'string') {
      continue
    }
    const key = `${report.scope.epicId ?? ''}\u0000${defectKey.trim()}`
    const judgements = byKey.get(key) ?? new Map<string, string>()
    byKey.set(key, judgements)
    const said = judgement(report)
    const agreeing = judgements.get(said)
    const [first] = judgements.values()
    if (agreeing !== undefined) {
      groups.join(agreeing, report.observationId)
    } else if (first !== undefined) {
      anomalies.push({ observationId: report.observationId, reason: 'conflicting_reports', relatedId: first })
    }
    judgements.set(said, agreeing ?? report.observationId)
  }
}

/**
 * Joins reports that are one defect: by defect key (`groupByKey`), and the two reports a duplicate record names, the
 * cited `defect` report deciding what the joined defect says. A duplicate record naming an unknown report is an anomaly.
 */
function groupReports(reports: readonly MetricObservation[], duplicates: readonly MetricObservation[], anomalies: DefectAnomaly[]): ReportGroups {
  const groups = new ReportGroups(new Map(reports.map((report, index) => [report.observationId, index])))
  groupByKey(reports, groups, anomalies)
  for (const record of duplicates) {
    const [defect, duplicate] = [linkedId(record, 'defect'), linkedId(record, 'duplicate')]
    if (groups.has(defect) && groups.has(duplicate)) {
      groups.join(defect, duplicate)
    } else {
      anomalies.push({ observationId: record.observationId, reason: 'unknown_defect', relatedId: null })
    }
  }
  return groups
}

/** Each withdrawn report's withdrawal (the first; a second is an anomaly). A withdrawal citing no report is one too. */
function withdrawalsOf(records: readonly MetricObservation[], groups: ReportGroups, anomalies: DefectAnomaly[]): Map<string, MetricObservation> {
  const withdrawn = new Map<string, MetricObservation>()
  for (const record of records) {
    const reportId = linkedId(record, 'defect')
    if (!groups.has(reportId)) {
      anomalies.push({ observationId: record.observationId, reason: 'unknown_defect', relatedId: null })
    } else if (withdrawn.has(reportId)) {
      anomalies.push({ observationId: record.observationId, reason: 'withdrawn_twice', relatedId: reportId })
    } else {
      withdrawn.set(reportId, record)
    }
  }
  return withdrawn
}

/**
 * One defect from its reports (ledger order; the first is its id). It reads its group's base report while that is
 * not withdrawn, else its earliest live report sharing the base's judgement (severity, attribution, origin), else its
 * earliest live report, and counts while any live report remains: withdrawing one report withdraws only that report.
 */
function defectOf(
  reports: readonly [MetricObservation, ...MetricObservation[]],
  preferred: string,
  withdrawn: ReadonlyMap<string, MetricObservation>
): EscapedDefect {
  const [first] = reports
  const live = reports.filter((report) => !withdrawn.has(report.observationId))
  const said = judgement(reports.find((report) => report.observationId === preferred) ?? first)
  const base = live.find((report) => report.observationId === preferred) ?? live.find((report) => judgement(report) === said) ?? live[0] ?? first
  const withdrawals = reports.flatMap((report) => {
    const record = withdrawn.get(report.observationId)
    return record === undefined ? [] : [{ observationId: record.observationId, reportId: report.observationId, recordedAt: record.recordedAt }]
  })
  const counted = withdrawals.length < reports.length
  const times = [...reports.map((report) => report.recordedAt), ...withdrawals.map((item) => item.recordedAt)].sort()
  const { attributes } = base
  return {
    defectId: first.observationId,
    reportIds: reports.map((report) => report.observationId),
    defectKey: typeof attributes.defectKey === 'string' ? attributes.defectKey.trim() : null,
    scope: base.scope,
    reportedBy: { kind: base.source.kind, actor: base.source.actor },
    severity: attributes.severity as RegressionSeverity,
    attribution: attributes.attribution as DefectAttribution,
    origin: originOf(base),
    discoveryPhase: attributes.discoveryPhase as DiscoveryPhase,
    sourceBuild: linkedId(base, 'sourceBuild') ?? '',
    discoveredAt: base.observedAt,
    recordedAt: base.recordedAt,
    status: counted ? 'open' : 'withdrawn',
    counted,
    reassessmentIds: [],
    fixes: [],
    withdrawals,
    updatedAt: times.at(-1) ?? first.recordedAt
  }
}

/** A reassessment or a fix, applied to the defect it cites. */
function applyFollowUp(defect: EscapedDefect, record: MetricObservation): void {
  const { attributes } = record
  if (attributes.defectEvent === 'reassessment') {
    defect.severity = oneOf(REGRESSION_SEVERITIES, attributes.severity) ? attributes.severity : defect.severity
    if (oneOf(DEFECT_ATTRIBUTIONS, attributes.attribution)) {
      defect.attribution = attributes.attribution
      defect.origin = originOf(record)
    }
    defect.reassessmentIds.push(record.observationId)
  } else {
    defect.fixes.push({ observationId: record.observationId, recordedAt: record.recordedAt, fixedBy: record.evidence.filter((ref) => ref.detail === DEFECT_LINKS.fixedBy) })
    defect.status = defect.counted ? 'fixed' : defect.status
  }
  defect.updatedAt = record.recordedAt > defect.updatedAt ? record.recordedAt : defect.updatedAt
}

/**
 * The escaped defects the ledger holds as of `cutoff` (records stored after it are ignored), each with its reports,
 * current severity and attribution, fixes and withdrawals. `observations` may hold any metric; only well-formed
 * `escaped_defect` records are read (one `defectProblem` refuses, such as a worker's withdrawal, never counts).
 * Reassessments apply in ledger order. Records citing no known report, and conflicting reports, are anomalies.
 */
export function resolveDefects(observations: readonly MetricObservation[], cutoff: string): EscapedDefectsView {
  const records = observations
    .filter((item) => item.metric === 'escaped_defect' && item.recordedAt <= cutoff && defectProblem(item) === null)
    .sort(ledgerOrder)
  const ofEvent = (...events: DefectEvent[]): MetricObservation[] => records.filter((item) => oneOf(events, item.attributes.defectEvent))
  const reports = ofEvent('report')
  const anomalies: DefectAnomaly[] = []
  const groups = groupReports(reports, ofEvent('duplicate'), anomalies)
  const withdrawn = withdrawalsOf(ofEvent('withdrawal'), groups, anomalies)
  const members = new Map<string, [MetricObservation, ...MetricObservation[]]>()
  for (const report of reports) {
    const root = groups.root(report.observationId)
    const grouped = members.get(root)
    members.set(root, grouped === undefined ? [report] : [...grouped, report])
  }
  const defects = new Map([...members].map(([root, grouped]) => [root, defectOf(grouped, groups.base(root), withdrawn)]))
  for (const record of ofEvent('reassessment', 'fix')) {
    const target = linkedId(record, 'defect')
    const defect = groups.has(target) ? defects.get(groups.root(target)) : undefined
    if (defect === undefined) {
      anomalies.push({ observationId: record.observationId, reason: 'unknown_defect', relatedId: null })
    } else {
      applyFollowUp(defect, record)
    }
  }
  return { cutoff, defects: [...defects.values()], anomalies }
}
