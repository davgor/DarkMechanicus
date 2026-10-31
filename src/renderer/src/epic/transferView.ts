/** Pure view model of an epic's Linear transfer: whether one is open, its progress and the last read-back's mismatches. */
import type { LinearTransferPacket, TransferMismatch, TransferMismatchField, TransferStatus, TransferView } from '../../../shared/domain/transfer'

/** The Linear MCP setup an agent's CLI needs once, as the transfer guide and `dm transfer` give it. */
export const LINEAR_SETUP_LINES: readonly { cli: string; setup: string }[] = [
  { cli: 'Claude Code', setup: 'claude mcp add --transport http linear-server https://mcp.linear.app/mcp, then /mcp to sign in' },
  { cli: 'Codex', setup: 'codex mcp add linear --url https://mcp.linear.app/mcp' },
  { cli: 'Cursor', setup: "add https://mcp.linear.app/mcp in Cursor's MCP settings" }
]

/** A transfer the person authorized that is not verified or canceled yet: it locks runs and Save. */
export function isOpenTransfer(status: TransferStatus | null): boolean {
  return status === 'queued' || status === 'in_progress'
}

const STATUS_LABELS: Record<'queued' | 'in_progress', string> = {
  queued: 'QUEUED',
  in_progress: 'IN PROGRESS'
}

const STATUS_TEXT: Record<'queued' | 'in_progress', string> = {
  queued: 'Waiting for an agent to start it.',
  in_progress: 'An agent is carrying it out in Linear.'
}

const FIELD_LABELS: Record<TransferMismatchField, string> = {
  recorded: 'not recorded',
  present: 'missing in Linear',
  name: 'name',
  url: 'URL',
  summary: 'summary',
  position: 'position',
  milestone: 'milestone',
  title: 'title',
  priority: 'priority',
  labels: 'labels',
  description: 'description',
  state: 'state',
  relation: 'relation',
  unexpected: 'unexpected item',
  duplicate: 'duplicate',
  team: 'team'
}

export interface MismatchRow {
  /** The DM key of the issue, or what else the mismatch is about (the project, a sprint, a relation). */
  subject: string
  field: string
}

export interface TransferStripView {
  pill: { label: string; tone: 'ready' | 'running' }
  text: string
  /** "3 of 12 created". */
  created: string
  mismatches: MismatchRow[]
}

function issueKey(packet: LinearTransferPacket | null, ref: string): string {
  return packet?.issues.find((issue) => issue.ref === ref)?.key ?? ref
}

/** What a mismatch without a DM key is about, named from the packet where it can be. */
function subjectOf(mismatch: TransferMismatch, packet: LinearTransferPacket | null): string {
  if (mismatch.key !== undefined) {
    return mismatch.key
  }
  if (mismatch.ref === 'project') {
    return 'Project'
  }
  const milestone = packet?.milestones.find((item) => item.ref === mismatch.ref)
  if (milestone !== undefined) {
    return `Sprint ${milestone.position}`
  }
  const relation = packet?.relations.find((item) => item.ref === mismatch.ref)
  if (relation !== undefined) {
    return relation.kind === 'blocks'
      ? `${issueKey(packet, relation.blockerRef)} blocks ${issueKey(packet, relation.blockedRef)}`
      : `${issueKey(packet, relation.fromRef)} related to ${issueKey(packet, relation.toRef)}`
  }
  return mismatch.ref
}

/** The strip shown while a transfer is open; null when none is. */
export function transferStripView(transfer: TransferView | null): TransferStripView | null {
  if (transfer === null || (transfer.status !== 'queued' && transfer.status !== 'in_progress')) {
    return null
  }
  const status = transfer.status
  const total = transfer.recorded.length + transfer.next.length
  return {
    pill: { label: STATUS_LABELS[status], tone: status === 'queued' ? 'ready' : 'running' },
    text: STATUS_TEXT[status],
    created: `${transfer.recorded.length} of ${total} created`,
    mismatches: transfer.lastMismatches.map((mismatch) => ({ subject: subjectOf(mismatch, transfer.packet), field: FIELD_LABELS[mismatch.field] }))
  }
}
