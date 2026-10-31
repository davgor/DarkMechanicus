/**
 * Compares what an agent read back from Linear with the stored transfer packet and the Linear items recorded
 * for it. Pure: the caller loads the packet, the recorded items and the accumulated read-back, and decides what
 * the result means for the epic. A mismatch blocks completion; a warning does not.
 */
import {
  type EpicTransferItem,
  LINEAR_IDENTIFIER_PATTERN,
  type LinearIssueItem,
  type LinearReadback,
  type LinearReadbackIssue,
  type LinearReadbackMilestone,
  type LinearReadbackProject,
  type LinearReadbackRelation,
  type LinearTransferPacket,
  type ReadbackCounts,
  type TransferItemView,
  type TransferMismatch,
  type TransferMismatchField,
  type TransferMismatchValue,
  type TransferWarning
} from '../../shared/domain/transfer'

interface ReadbackInput {
  packet: LinearTransferPacket
  recorded: TransferItemView[]
  readback: LinearReadback
}

export interface ReadbackComparison {
  mismatches: TransferMismatch[]
  warnings: TransferWarning[]
  /** The issues found in the read-back, in execution order; every issue once there is no mismatch. */
  items: EpicTransferItem[]
  /** The URL recorded for the project; with no mismatch, the read-back project has the same one. */
  projectUrl: string | null
}

interface About {
  ref: string
  key?: string
}

interface ReadItems {
  project: LinearReadbackProject | null
  milestones: LinearReadbackMilestone[]
  issues: LinearReadbackIssue[]
  relations: LinearReadbackRelation[]
}

/** A packet issue with the read-back issue recorded for it. */
interface IssuePair {
  issue: LinearIssueItem
  read: LinearReadbackIssue
}

interface Index {
  packet: LinearTransferPacket
  read: ReadItems
  /** The recorded item of each packet ref. */
  recorded: Map<string, TransferItemView>
  /** The packet ref of each recorded Linear id, by kind. */
  milestoneRefOf: Map<string, string>
  issueRefOf: Map<string, string>
  /** The read-back items by Linear id. */
  milestones: Map<string, LinearReadbackMilestone>
  issues: Map<string, LinearReadbackIssue>
  /** The packet ref of each marker. */
  markerRefs: Map<string, string>
  /** The DM key and the position of each packet issue. */
  keyOf: Map<string, string>
  positionOf: Map<string, number>
  /** The packet issues present in the read-back, in execution order. */
  pairs: IssuePair[]
}

/** Linear's workflow state types an issue of a ticket that is not completed may have; `completed` and `canceled` close it. */
const OPEN_STATE_TYPES: Record<string, true> = { triage: true, backlog: true, unstarted: true, started: true }

/** A Markdown checklist item, ticked or not. */
const CHECKLIST_ITEM = /^[-*+] \[[ xX]\] /

/** A Markdown backslash escape of ASCII punctuation, which an editor may add without changing the text. */
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g

/** A read-back with every list, so later parts and the comparison need no guards. */
function readItemsOf(readback: LinearReadback): ReadItems {
  return {
    project: readback.project ?? null,
    milestones: readback.milestones ?? [],
    issues: readback.issues ?? [],
    relations: readback.relations ?? []
  }
}

/** One entry per Linear id, where it first appeared, holding the values it was last sent with. */
function latestById<T extends { linearId: string }>(items: T[]): T[] {
  const latest = new Map<string, T>()
  for (const item of items) {
    latest.set(item.linearId, item)
  }
  return [...latest.values()]
}

function uniqueRelations(relations: LinearReadbackRelation[]): LinearReadbackRelation[] {
  const unique = new Map<string, LinearReadbackRelation>()
  for (const relation of relations) {
    unique.set(JSON.stringify([relation.kind, relation.fromId, relation.toId]), relation)
  }
  return [...unique.values()]
}

/** Adds one read-back part to what earlier parts sent: a later project or item replaces the earlier copy. */
export function mergeReadback(base: LinearReadback, part: LinearReadback): LinearReadback {
  const before = readItemsOf(base)
  const after = readItemsOf(part)
  const project = after.project ?? before.project
  return {
    ...(project === null ? {} : { project }),
    milestones: latestById([...before.milestones, ...after.milestones]),
    issues: latestById([...before.issues, ...after.issues]),
    relations: uniqueRelations([...before.relations, ...after.relations])
  }
}

export function readbackCounts(readback: LinearReadback): ReadbackCounts {
  const read = readItemsOf(readback)
  return {
    project: read.project !== null,
    milestones: read.milestones.length,
    issues: read.issues.length,
    relations: read.relations.length
  }
}

function mismatch(about: About, field: TransferMismatchField, expected: TransferMismatchValue, actual: TransferMismatchValue): TransferMismatch {
  return about.key === undefined
    ? { ref: about.ref, field, expected, actual }
    : { ref: about.ref, key: about.key, field, expected, actual }
}

/** A mismatch when two texts differ beyond surrounding whitespace. */
function textDiffers(about: About, field: TransferMismatchField, expected: string, actual: string): TransferMismatch[] {
  return expected.trim() === actual.trim() ? [] : [mismatch(about, field, expected, actual)]
}

/** A line as compared: trimmed, unescaped, and a ticked checklist item counts as the unticked one. */
function normalizedLine(line: string): string {
  const plain = line.trim().replace(MARKDOWN_ESCAPE, '$1')
  return CHECKLIST_ITEM.test(plain) ? `- [ ] ${plain.replace(CHECKLIST_ITEM, '')}` : plain
}

function linesOf(text: string): string[] {
  return text.split('\n').map(normalizedLine)
}

function aboutRef(index: Index, ref: string): About {
  const key = index.keyOf.get(ref)
  return key === undefined ? { ref } : { ref, key }
}

/** The packet refs whose markers stand on a line of `text`, each once. */
function markersIn(index: Index, text: string): string[] {
  const refs = linesOf(text).flatMap((line) => {
    const ref = index.markerRefs.get(line)
    return ref === undefined ? [] : [ref]
  })
  return [...new Set(refs)]
}

function indexOf(input: ReadbackInput): Index {
  const { packet } = input
  const read = readItemsOf(input.readback)
  const recorded = new Map(input.recorded.map((item) => [item.ref, item]))
  const issues = new Map(read.issues.map((item) => [item.linearId, item]))
  const markers = [packet.project, ...packet.milestones, ...packet.issues].map((item): [string, string] => [item.marker, item.ref])
  const pairs = packet.issues.flatMap((issue) => {
    const linearId = recorded.get(issue.ref)?.linearId
    const found = linearId === undefined ? undefined : issues.get(linearId)
    return found === undefined ? [] : [{ issue, read: found }]
  })
  return {
    packet,
    read,
    recorded,
    milestoneRefOf: new Map(input.recorded.filter((item) => item.kind === 'milestone').map((item) => [item.linearId, item.ref])),
    issueRefOf: new Map(input.recorded.filter((item) => item.kind === 'issue').map((item) => [item.linearId, item.ref])),
    milestones: new Map(read.milestones.map((item) => [item.linearId, item])),
    issues,
    markerRefs: new Map(markers),
    keyOf: new Map(packet.issues.map((item) => [item.ref, item.key])),
    positionOf: new Map(packet.issues.map((item) => [item.ref, item.position])),
    pairs
  }
}

/** The read-back item recorded for `about.ref`, or why there is none: not recorded, or not read back. */
function locate<T>(index: Index, about: About, found: Map<string, T>): { read: T } | { missing: TransferMismatch } {
  const linearId = index.recorded.get(about.ref)?.linearId
  if (linearId === undefined) {
    return { missing: mismatch(about, 'recorded', true, false) }
  }
  const read = found.get(linearId)
  return read === undefined ? { missing: mismatch(about, 'present', linearId, null) } : { read }
}

function projectMismatches(index: Index): TransferMismatch[] {
  const { project } = index.packet
  const about = { ref: project.ref }
  const linearId = index.recorded.get(project.ref)?.linearId
  if (linearId === undefined) {
    return [mismatch(about, 'recorded', true, false)]
  }
  const read = index.read.project
  if (read === null || read.linearId !== linearId) {
    return [mismatch(about, 'present', linearId, read?.linearId ?? null)]
  }
  const summary = read.summary.includes(project.marker) ? [] : [mismatch(about, 'summary', project.marker, read.summary)]
  return [...textDiffers(about, 'name', project.name, read.name), ...urlMismatches(index, read), ...summary]
}

/** The read-back project must have the URL recorded for it; no recorded URL fails closed until the agent records one. */
function urlMismatches(index: Index, read: LinearReadbackProject): TransferMismatch[] {
  const recorded = index.recorded.get(index.packet.project.ref)?.url ?? null
  return recorded !== null && recorded.trim() === read.url.trim() ? [] : [mismatch({ ref: index.packet.project.ref }, 'url', recorded, read.url)]
}

/** Each present milestone's rank among the present milestones, in packet order and in read-back order. */
function positionMismatches(index: Index, present: string[]): TransferMismatch[] {
  const wanted = new Set(present)
  const order = index.read.milestones
    .map((item) => index.milestoneRefOf.get(item.linearId))
    .filter((ref): ref is string => ref !== undefined && wanted.has(ref))
  return present.flatMap((ref, rank) => {
    const actual = order.indexOf(ref)
    return actual === rank ? [] : [mismatch({ ref }, 'position', rank + 1, actual + 1)]
  })
}

function milestoneMismatches(index: Index): TransferMismatch[] {
  const present: string[] = []
  const mismatches = index.packet.milestones.flatMap((milestone) => {
    const about = { ref: milestone.ref }
    const located = locate(index, about, index.milestones)
    if ('missing' in located) {
      return [located.missing]
    }
    present.push(milestone.ref)
    return textDiffers(about, 'name', milestone.name, located.read.name)
  })
  return [...mismatches, ...positionMismatches(index, present)]
}

function sameLabels(expected: string[], actual: string[]): boolean {
  const normalize = (labels: string[]) => [...new Set(labels.map((label) => label.trim().toLowerCase()))].sort()
  const want = normalize(expected)
  const got = normalize(actual)
  return want.length === got.length && want.every((label, at) => label === got[at])
}

/** The lines a packet issue's Linear description must keep: its checklist items, its back-link and its marker. */
function requiredLines(issue: LinearIssueItem, epicId: string): string[] {
  const backLink = `DM key ${issue.key} · epic ${epicId} · revision `
  const kept = linesOf(issue.description).filter((line) => line.startsWith('- [ ] ') || line.startsWith(backLink))
  return [...new Set([...kept, issue.marker])]
}

function descriptionMismatches(index: Index, about: About, pair: IssuePair): TransferMismatch[] {
  const lines = new Set(linesOf(pair.read.description))
  const missing = requiredLines(pair.issue, index.packet.epicId).filter((line) => !lines.has(line))
  return missing.length === 0 ? [] : [mismatch(about, 'description', missing, null)]
}

/** State types compare without case; a value that is not one of Linear's state types is a mismatch either way. */
function stateMismatches(about: About, pair: IssuePair): TransferMismatch[] {
  const { stateType } = pair.read
  const type = stateType.trim().toLowerCase()
  if (pair.issue.state === 'completed') {
    return type === 'completed' ? [] : [mismatch(about, 'state', 'completed', stateType)]
  }
  return OPEN_STATE_TYPES[type] === true ? [] : [mismatch(about, 'state', 'triage, backlog, unstarted or started', stateType)]
}

function milestoneOfIssue(index: Index, about: About, pair: IssuePair): TransferMismatch[] {
  const expected = index.recorded.get(pair.issue.milestoneRef)?.linearId
  // An unrecorded milestone is already a mismatch of its own.
  return expected === undefined || pair.read.milestoneId === expected ? [] : [mismatch(about, 'milestone', expected, pair.read.milestoneId)]
}

function issueFieldMismatches(index: Index, pair: IssuePair): TransferMismatch[] {
  const { issue, read } = pair
  const about = { ref: issue.ref, key: issue.key }
  return [
    ...milestoneOfIssue(index, about, pair),
    ...textDiffers(about, 'title', issue.title, read.title),
    ...(read.priority === issue.priority ? [] : [mismatch(about, 'priority', issue.priority, read.priority)]),
    ...(sameLabels(issue.labels, read.labels) ? [] : [mismatch(about, 'labels', issue.labels, read.labels)]),
    ...descriptionMismatches(index, about, pair),
    ...stateMismatches(about, pair)
  ]
}

function issueMismatches(index: Index): TransferMismatch[] {
  return index.packet.issues.flatMap((issue) => {
    const located = locate(index, { ref: issue.ref, key: issue.key }, index.issues)
    return 'missing' in located ? [located.missing] : issueFieldMismatches(index, { issue, read: located.read })
  })
}

interface RelationEnds {
  kind: 'blocks' | 'related'
  from: string
  to: string
}

/** A relation keyed for comparison. A related link is symmetric, so its ends are put in execution order. */
function relationEntry(index: Index, ends: RelationEnds): [string, RelationEnds] {
  const swap = ends.kind === 'related' && (index.positionOf.get(ends.from) ?? 0) > (index.positionOf.get(ends.to) ?? 0)
  const canonical = swap ? { kind: ends.kind, from: ends.to, to: ends.from } : ends
  return [`${canonical.kind}:${canonical.from}:${canonical.to}`, canonical]
}

function relationText(index: Index, ends: RelationEnds): string {
  const verb = ends.kind === 'blocks' ? 'blocks' : 'related to'
  return `${index.keyOf.get(ends.from) ?? ends.from} ${verb} ${index.keyOf.get(ends.to) ?? ends.to}`
}

/** The packet relations whose two issues are recorded, by key, with their refs. */
function expectedRelations(index: Index): Map<string, { ref: string; ends: RelationEnds }> {
  const expected = new Map<string, { ref: string; ends: RelationEnds }>()
  for (const relation of index.packet.relations) {
    const ends: RelationEnds =
      relation.kind === 'blocks'
        ? { kind: 'blocks', from: relation.blockerRef, to: relation.blockedRef }
        : { kind: 'related', from: relation.fromRef, to: relation.toRef }
    if (index.recorded.has(ends.from) && index.recorded.has(ends.to)) {
      const [key, canonical] = relationEntry(index, ends)
      expected.set(key, { ref: relation.ref, ends: canonical })
    }
  }
  return expected
}

/** The read-back blocks and related relations between recorded issues, by key. */
function readRelations(index: Index): Map<string, RelationEnds> {
  const read = new Map<string, RelationEnds>()
  for (const relation of index.read.relations) {
    const from = index.issueRefOf.get(relation.fromId)
    const to = index.issueRefOf.get(relation.toId)
    if ((relation.kind === 'blocks' || relation.kind === 'related') && from !== undefined && to !== undefined) {
      const [key, ends] = relationEntry(index, { kind: relation.kind, from, to })
      read.set(key, ends)
    }
  }
  return read
}

/** Every packet relation is recorded, and the blocks and related relations match as sets. */
function relationMismatches(index: Index): TransferMismatch[] {
  const unrecorded = index.packet.relations
    .filter((relation) => !index.recorded.has(relation.ref))
    .map((relation) => mismatch({ ref: relation.ref }, 'recorded', true, false))
  const expected = expectedRelations(index)
  const read = readRelations(index)
  const missing = [...expected]
    .filter(([key]) => !read.has(key))
    .map(([, relation]) => mismatch({ ref: relation.ref }, 'relation', relationText(index, relation.ends), null))
  const extra = [...read]
    .filter(([key]) => !expected.has(key))
    .map(([, ends]) => {
      const ref = `${ends.kind === 'blocks' ? 'rel' : 'see'}:${ends.from}:${ends.to}`
      return mismatch({ ref }, 'relation', null, relationText(index, ends))
    })
  return [...unrecorded, ...missing, ...extra]
}

function unexpected(index: Index, item: { linearId: string; description: string }, shown: string): TransferMismatch {
  const [ref] = markersIn(index, item.description)
  return mismatch(ref === undefined ? { ref: item.linearId } : aboutRef(index, ref), 'unexpected', null, shown)
}

function unexpectedMismatches(index: Index): TransferMismatch[] {
  const milestones = index.read.milestones
    .filter((item) => !index.milestoneRefOf.has(item.linearId))
    .map((item) => unexpected(index, item, item.linearId))
  const issues = index.read.issues
    .filter((item) => !index.issueRefOf.has(item.linearId))
    .map((item) => unexpected(index, item, item.identifier))
  return [...milestones, ...issues]
}

/**
 * A marker carried by more than one read-back milestone or issue (actual: their Linear ids), and one Linear item
 * recorded for more than one packet ref (actual: those refs), in packet order.
 */
function duplicateMismatches(index: Index): TransferMismatch[] {
  const carriers = new Map<string, string[]>()
  for (const item of [...index.read.milestones, ...index.read.issues]) {
    for (const ref of markersIn(index, item.description)) {
      carriers.set(ref, [...(carriers.get(ref) ?? []), item.linearId])
    }
  }
  const sharers = new Map<string, string[]>()
  for (const item of index.recorded.values()) {
    if (item.kind === 'milestone' || item.kind === 'issue') {
      sharers.set(item.linearId, [...(sharers.get(item.linearId) ?? []), item.ref])
    }
  }
  return [...index.packet.milestones, ...index.packet.issues].flatMap((item) => {
    const about = aboutRef(index, item.ref)
    const recorded = index.recorded.get(item.ref)?.linearId ?? null
    const ids = carriers.get(item.ref) ?? []
    const refs = recorded === null ? [] : (sharers.get(recorded) ?? [])
    return [
      ...(ids.length > 1 ? [mismatch(about, 'duplicate', recorded, ids)] : []),
      ...(refs.length > 1 ? [mismatch(about, 'duplicate', recorded, refs)] : [])
    ]
  })
}

function numberOf(identifier: string): number | null {
  const digits = LINEAR_IDENTIFIER_PATTERN.exec(identifier)?.[2]
  return digits === undefined ? null : Number(digits)
}

/** The team key most issues have; on a tie, the one met first in execution order. */
function mainTeam(teams: (string | null)[]): string | null {
  const counts = new Map<string, number>()
  for (const team of teams) {
    if (team !== null) {
      counts.set(team, (counts.get(team) ?? 0) + 1)
    }
  }
  let best: string | null = null
  for (const [team, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) {
      best = team
    }
  }
  return best
}

/** Every issue must sit in one team; an identifier that names no team is a mismatch too. */
function teamMismatches(index: Index): TransferMismatch[] {
  const teams = index.pairs.map((pair) => LINEAR_IDENTIFIER_PATTERN.exec(pair.read.identifier)?.[1] ?? null)
  const main = mainTeam(teams)
  return index.pairs.flatMap((pair, at) => {
    const team = teams[at] ?? null
    if (team !== null && team === main) {
      return []
    }
    return [mismatch({ ref: pair.issue.ref, key: pair.issue.key }, 'team', main, team ?? pair.read.identifier)]
  })
}

function identifierOrderWarnings(index: Index): TransferWarning[] {
  const warnings: TransferWarning[] = []
  let previous: { number: number; identifier: string } | null = null
  for (const { issue, read } of index.pairs) {
    const number = numberOf(read.identifier)
    if (number === null) {
      continue
    }
    if (previous !== null && number <= previous.number) {
      const detail = `${read.identifier} (position ${issue.position}) does not come after ${previous.identifier}.`
      warnings.push({ code: 'identifier_order', ref: issue.ref, key: issue.key, detail })
    }
    previous = { number, identifier: read.identifier }
  }
  return warnings
}

function sortOrderWarnings(index: Index): TransferWarning[] {
  const unreported = index.pairs.filter((pair) => typeof pair.read.sortOrder !== 'number').length
  if (unreported > 0) {
    const detail = `${unreported} of ${index.pairs.length} issues have no sortOrder in the read-back, so their order in Linear was not checked.`
    return [{ code: 'sort_order_unreported', detail }]
  }
  return index.pairs.flatMap((pair, at) => {
    const before = index.pairs[at - 1]?.read.sortOrder
    const sortOrder = pair.read.sortOrder ?? 0
    if (before === undefined || sortOrder > before) {
      return []
    }
    const detail = `sortOrder ${sortOrder} at position ${pair.issue.position} does not rise above ${before}.`
    return [{ code: 'sort_order', ref: pair.issue.ref, key: pair.issue.key, detail }]
  })
}

/** The full comparison; the mismatches are in a fixed order: by kind of check, then in packet order. */
export function compareReadback(input: ReadbackInput): ReadbackComparison {
  const index = indexOf(input)
  return {
    mismatches: [
      ...projectMismatches(index),
      ...milestoneMismatches(index),
      ...issueMismatches(index),
      ...relationMismatches(index),
      ...unexpectedMismatches(index),
      ...duplicateMismatches(index),
      ...teamMismatches(index)
    ],
    warnings: [...identifierOrderWarnings(index), ...sortOrderWarnings(index)],
    projectUrl: index.recorded.get(index.packet.project.ref)?.url ?? null,
    items: index.pairs.map(({ issue, read }) => ({
      key: issue.key,
      identifier: read.identifier,
      url: index.recorded.get(issue.ref)?.url ?? null
    }))
  }
}
