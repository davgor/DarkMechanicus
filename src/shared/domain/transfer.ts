/**
 * The Linear transfer packet: one saved plan revision laid out as a Linear project, in execution order.
 * Built purely from the saved bundle (no I/O); an agent creates the items in Linear from it. Every
 * project, milestone and issue carries a marker, written as the last line of its text, that the agent
 * searches for before creating, so a repeated transfer finds what an earlier one already created.
 */

export const LINEAR_TRANSFER_FORMAT = 'darkmechanicus.linear-transfer'
export const LINEAR_TRANSFER_VERSION = 1

/** A Linear issue identifier, `<team key>-<number>` such as `ENG-12`: the team key, then the number. */
export const LINEAR_IDENTIFIER_PATTERN = /^([A-Za-z0-9]{1,12})-(\d{1,9})$/

/** Linear's issue priority numbers: 1 urgent (critical), 2 high, 3 medium (normal), 4 low. */
export type LinearPriority = 1 | 2 | 3 | 4

/** `completed` for a ticket DM records as completed; `default` lets Linear use the team's default state. */
export type LinearIssueState = 'default' | 'completed'

export interface LinearProjectItem {
  ref: 'project'
  /** `dm:<epicId>/project`. */
  marker: string
  /** The epic title. */
  name: string
  /** At most 255 characters; ends with the marker. */
  summary: string
  /** The epic intent and success criteria; ends with the marker. */
  content: string
}

/** One sprint. */
export interface LinearMilestoneItem {
  /** The sprint id. */
  ref: string
  /** `dm:<epicId>/<sprintId>`. */
  marker: string
  /** 1-based, in sprint ordinal order. */
  position: number
  /** `Sprint N: <first line of the goal>`. */
  name: string
  /** The goal and exit criteria; ends with the marker. */
  description: string
}

/** One ticket. */
export interface LinearIssueItem {
  /** The ticket id. */
  ref: string
  /** The DM display key, e.g. `DM-12`. */
  key: string
  /** `dm:<epicId>/<ticketId>`. */
  marker: string
  /** 1-based execution position across the whole epic. */
  position: number
  /** The ref of the milestone (sprint) the issue belongs to. */
  milestoneRef: string
  title: string
  /** Body, criteria checklist, references, back-link; ends with the marker. */
  description: string
  priority: LinearPriority
  labels: string[]
  state: LinearIssueState
  /** Refs of the issues that block this one, in execution order. */
  blockedBy: string[]
}

/** `blockerRef` blocks `blockedRef`; ref `rel:<blockerId>:<blockedId>`. */
export interface LinearBlocksRelation {
  ref: string
  kind: 'blocks'
  blockerRef: string
  blockedRef: string
}

/** A nonblocking link between two issues (a plan `related_to`); ref `see:<fromId>:<toId>`. */
export interface LinearRelatedRelation {
  ref: string
  kind: 'related'
  fromRef: string
  toRef: string
}

export type LinearRelationItem = LinearBlocksRelation | LinearRelatedRelation

export interface LinearTransferPacket {
  format: typeof LINEAR_TRANSFER_FORMAT
  version: typeof LINEAR_TRANSFER_VERSION
  epicId: string
  revisionId: string
  /** `contentHash` of the packet without this field. */
  packetHash: string
  project: LinearProjectItem
  milestones: LinearMilestoneItem[]
  /** In execution order. */
  issues: LinearIssueItem[]
  /** Deduplicated, in issue order. */
  relations: LinearRelationItem[]
}

/** Where a transfer stands; `not_started` when the person never queued one. */
export type TransferStatus = 'not_started' | 'queued' | 'in_progress' | 'verified' | 'canceled'

export type TransferItemKind = 'project' | 'milestone' | 'issue' | 'relation'

/** One packet item already created in Linear. */
export interface TransferItemView {
  ref: string
  kind: TransferItemKind
  linearId: string
  identifier: string | null
  url: string | null
  recordedAt: string
}

export interface TransferView {
  epicId: string
  status: TransferStatus
  /** The stored packet, or the one the current saved revision builds when no transfer exists (null if never saved). */
  packet: LinearTransferPacket | null
  recorded: TransferItemView[]
  /** What the last read-back found different from the packet; empty before any read-back and once verified. */
  lastMismatches: TransferMismatch[]
  /** The unrecorded refs, in packet order. */
  next: string[]
}

/** What an agent works from when it starts or resumes a transfer. */
export interface StartedTransferView {
  packet: LinearTransferPacket
  recorded: TransferItemView[]
  next: string[]
}

/** Queue, cancel or start the transfer of one epic. */
export interface TransferActionInput {
  epicId: string
  idempotencyKey?: string
}

/** The Linear item an agent created (or adopted) for one packet ref. */
export interface RecordTransferItemInput {
  epicId: string
  ref: string
  linearId: string
  identifier?: string
  url?: string
  /** Overwrite a ref already recorded with a different Linear id. */
  replace?: boolean
  idempotencyKey?: string
}

/** The Linear project as an agent read it back. */
export interface LinearReadbackProject {
  linearId: string
  url: string
  name: string
  summary: string
  content: string
}

/** One milestone of the project as read back; the list is in the order Linear shows them. */
export interface LinearReadbackMilestone {
  linearId: string
  name: string
  description: string
}

/** One issue of the project as read back. */
export interface LinearReadbackIssue {
  linearId: string
  /** `<team key>-<number>`, e.g. `ENG-12`. */
  identifier: string
  /** The Linear id of the issue's milestone; null when it has none. */
  milestoneId: string | null
  title: string
  description: string
  /** Linear's priority number: 0 none, 1 urgent … 4 low. */
  priority: number
  labels: string[]
  /** The type of its workflow state: triage, backlog, unstarted, started, completed or canceled. */
  stateType: string
  /** Its manual sort order, when the agent's Linear tools report one. */
  sortOrder?: number
}

/** A relation between two issues as read back. Only `blocks` (fromId blocks toId) and `related` are compared. */
export interface LinearReadbackRelation {
  kind: string
  fromId: string
  toId: string
}

/**
 * What an agent read back from Linear. It is sent in parts that accumulate until the final one, and each part
 * may hold the project and any of the lists. An item sent again (the same Linear id, or the same relation)
 * replaces the earlier copy in place.
 */
export interface LinearReadback {
  project?: LinearReadbackProject
  milestones?: LinearReadbackMilestone[]
  issues?: LinearReadbackIssue[]
  relations?: LinearReadbackRelation[]
}

/**
 * One part of a read-back. It takes no idempotency key: a final part ends the accumulation in a transaction of
 * its own before the comparison, which an idempotency wrapper would fold into one; sending a part again is
 * already harmless, as the merge keeps one copy per Linear id.
 */
export interface SubmitTransferReadbackInput {
  epicId: string
  /** One part of what the agent read back from Linear; parts accumulate until the final one. */
  readback: LinearReadback
  /** The last part: compare the whole read-back, then complete the epic or report what differs. */
  final: boolean
}

/**
 * What a read-back mismatch is about:
 * - `recorded`: a packet ref has no recorded Linear item; `present`: a recorded item is not in the read-back
 *   (or the read-back project is another one);
 * - the project's `name`, its `url`, which must be the one recorded for it (no recorded URL is a mismatch too),
 *   and its `summary`, which must hold the marker;
 * - a milestone's `name` and its `position` among the milestones;
 * - an issue's `milestone`, `title`, `priority`, `labels`, `description` (its checklist lines, back-link and
 *   marker) and `state` (its state type, without case: `completed` for a completed ticket, else `triage`,
 *   `backlog`, `unstarted` or `started`);
 * - a `relation` missing from the read-back, or there without being in the packet;
 * - an `unexpected` item whose Linear id is not recorded, a `duplicate` (a marker carried by two items, or one
 *   Linear item recorded for two refs), and an issue in another `team` than the rest.
 */
export type TransferMismatchField =
  | 'recorded'
  | 'present'
  | 'name'
  | 'url'
  | 'summary'
  | 'position'
  | 'milestone'
  | 'title'
  | 'priority'
  | 'labels'
  | 'description'
  | 'state'
  | 'relation'
  | 'unexpected'
  | 'duplicate'
  | 'team'

export type TransferMismatchValue = string | number | boolean | string[] | null

/** One way the read-back differs from the packet; any mismatch keeps the epic open. */
export interface TransferMismatch {
  /** The packet ref; for an unexpected item that carries no packet marker, its Linear id. */
  ref: string
  /** The DM key, when the mismatch is about an issue. */
  key?: string
  field: TransferMismatchField
  expected: TransferMismatchValue
  actual: TransferMismatchValue
}

/**
 * `identifier_order`: an issue's identifier number does not rise with its position. `sort_order_unreported`: the
 * read-back holds no sortOrder for some issues. `sort_order`: an issue's sortOrder does not rise with its position.
 */
export type TransferWarningCode = 'identifier_order' | 'sort_order_unreported' | 'sort_order'

/** Something the read-back shows that does not block completion. */
export interface TransferWarning {
  code: TransferWarningCode
  ref?: string
  key?: string
  detail: string
}

/** How many of each item the accumulated read-back holds. */
export interface ReadbackCounts {
  project: boolean
  milestones: number
  issues: number
  relations: number
}

export interface TransferReadbackResult {
  /** `partial`: the part was stored; `rejected`: the read-back differs and the epic stays open; `verified`: the epic completed. */
  status: 'partial' | 'rejected' | 'verified'
  /** What the read-back holds so far; for a final part, what was compared. */
  received: ReadbackCounts
  mismatches: TransferMismatch[]
  warnings: TransferWarning[]
}

/** One issue of a verified transfer. */
export interface EpicTransferItem {
  /** The DM display key. */
  key: string
  /** The Linear identifier, e.g. `ENG-12`. */
  identifier: string
  /** The Linear URL the agent recorded, if any. */
  url: string | null
}

/** The verified Linear transfer that completed an epic, kept in its outcome. */
export interface EpicTransferOutcome {
  target: 'linear'
  projectUrl: string
  revisionId: string
  packetHash: string
  /** Every issue, in execution order. */
  items: EpicTransferItem[]
}
