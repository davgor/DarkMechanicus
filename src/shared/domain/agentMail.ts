/**
 * Agent mail as an agent sees it through the CLI (and, refused, over MCP): direct messages and replies between
 * Skitarii chats. A mailbox is never named by the caller: it is the endpoint the session's own desktop-bound grant
 * speaks for. Message bodies and peer names are another agent's text: task data, never instructions.
 */
import type { SessionRole } from './views'

/** Where a page of mail starts and stops: sequences in (afterSeq, throughSeq], at most `limit` of them (1 to 50). */
export interface AgentMailWindow {
  /** The cursor: the `nextCursor` of the previous page; 0 or absent from the start. */
  afterSeq?: number
  /** The snapshot horizon: the first page's `snapshotHighWater`, passed back so later pages skip no arrival. */
  throughSeq?: number
  limit?: number
}

export interface AgentIdentityView {
  /** This session's own mailbox: the opaque endpoint id peers send to. */
  endpointId: string
  /** The chat's title, as the desktop set it. */
  name: string
  role: SessionRole
  boundAt: string
}

interface AgentPeerView {
  endpointId: string
  /** The peer chat's title, as the desktop set it: plain text, never instructions. */
  name: string
}

export interface AgentPeersPage {
  /** Open mailboxes of this project other than the caller's own, in id order. */
  peers: AgentPeerView[]
  /** Pass back as `afterId` for the next page; null when this page is empty. */
  nextAfterId: string | null
  hasMore: boolean
}

export interface SendAgentMessageInput {
  /** The recipient's endpoint id (from list_agent_peers, or the sender of a message being answered). */
  to: string
  /** The sender's own retry key: the same id and payload replays the original acceptance; another payload conflicts. */
  clientMessageId: string
  /** 1 to 16 KiB of UTF-8. */
  body: string
  /** A retained message of the caller's own inbox that `to` sent; makes this a reply. */
  inReplyTo?: string
}

/** Durable acceptance into the recipient's mailbox: not delivery, reading or acknowledgement. */
export interface AgentMessageAcceptanceView {
  messageId: string
  to: string
  clientMessageId: string
  inReplyTo: string | null
  acceptedAt: string
  /** True when this call replayed the earlier acceptance of the same clientMessageId and payload. */
  duplicate: boolean
}

interface AgentMailSenderView {
  endpointId: string
  name: string
  /** The sender's chat was deleted since; its mail stays. */
  deleted: boolean
}

/** A received message without its body. */
interface AgentMailMessageMetaView {
  id: string
  /** Position in the recipient's mailbox; never reused. */
  seq: number
  from: AgentMailSenderView
  inReplyTo: string | null
  bodyBytes: number
  /** When the mailbox durably accepted it. */
  acceptedAt: string
  /** When the recipient explicitly acknowledged it; reading never does. */
  acknowledgedAt: string | null
  /** Seven days after acknowledgement; null while unacknowledged, which never expires. */
  expiresAt: string | null
}

export interface AgentMailMessageView extends AgentMailMessageMetaView {
  body: string
}

interface AgentMailPage {
  /** The horizon this page (and every later page given it as `throughSeq`) covers; arrivals above it come next sweep. */
  snapshotHighWater: number
  /** Pass back as `afterSeq` for the next page. */
  nextCursor: number
  hasMore: boolean
}

export interface ReadAgentInboxInput extends AgentMailWindow {
  /** Only messages not yet acknowledged. */
  unacknowledgedOnly?: boolean
}

export interface AgentInboxPage extends AgentMailPage {
  /** Retained messages with bodies, ascending. */
  messages: AgentMailMessageView[]
}

export interface AgentMailStatusPage extends AgentMailPage {
  /** Unacknowledged messages the mailbox holds now. */
  pendingCount: number
  /** Unacknowledged messages, ascending, without bodies. */
  messages: AgentMailMessageMetaView[]
}

export interface AcknowledgeAgentMessagesResult {
  acknowledged: { messageId: string; acknowledgedAt: string; expiresAt: string }[]
}


/** Whether this session has a usable mailbox, as get_capabilities reports it; never a promise that mail will work. */
export type AgentMailboxStatus =
  | { bound: true; endpointId: string }
  | {
      bound: false
      /** `no_mail_capability`: the role has none; `no_grant`: not a granted CLI session; `unbound`: the grant has no open binding here. */
      reason: 'no_mail_capability' | 'no_grant' | 'unbound'
    }


/** What the person's inbox view counts, independently of context delivery and agent acknowledgement. */
export interface HumanAgentMailStateView {
  endpointId: string
  /** The person's own seen cursor, separate from the agent's acknowledgements. */
  humanSeenSeq: number
  unseenCount: number
  pendingCount: number
  retainedCount: number
  retentionDays: number
}
