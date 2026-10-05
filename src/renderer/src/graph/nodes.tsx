import { Handle, Position, type NodeProps, type NodeTypes } from '@xyflow/react'
import type { CSSProperties } from 'react'
import type { DividerFlowNode, EpicFlowNode, JoinFlowNode, RowCheckFlowNode, SprintFlowNode, TicketFlowNode } from './flowElements'
import type { RowCheckState, TicketNodeModel } from './graphModel'
import type { Tone } from './ticketStates'
import { WorkingHourglass } from './WorkingHourglass'

const DIVIDER_TONES: Record<'passed' | 'locked' | 'awaiting' | 'neutral', Tone> = {
  passed: 'accepted',
  locked: 'running',
  awaiting: 'attention',
  neutral: 'neutral'
}

/** Every check state has a glyph next to its words, so color never carries the state alone. */
const CHECK_ICONS: Record<RowCheckState, string> = { passed: '✓', failed: '✗', none: '–' }

/** The corner of the bracket and the arrowhead into the acceptance node, in the units of the join's width. */
const JOIN_STEM = 3
const JOIN_HEAD = 6

function TicketNode({ data }: NodeProps<TicketFlowNode>): JSX.Element {
  const card = data.model
  const classes = [
    'pg-card',
    `ew-tone-${card.tone}`,
    card.dashed ? 'is-dashed' : '',
    card.acceptance ? 'is-acceptance' : '',
    data.active ? 'is-active' : ''
  ]
  return (
    <div className={classes.filter((name) => name !== '').join(' ')} data-ticket={card.id}>
      {card.note === null ? null : <span className="pg-note">{card.note}</span>}
      <Handle type="target" position={Position.Top} isConnectable={data.editable} />
      <span className="pg-card-head">
        <span className="pg-card-label">{card.label}</span>
        <Hourglass card={card} onOpen={data.onOpenActivity} />
      </span>
      <span className="pg-card-title">{card.title}</span>
      {card.acceptance ? <span className="pg-kind">ACCEPTANCE</span> : null}
      <TicketTags size={card.size} effort={card.effort} />
      <Handle type="source" position={Position.Bottom} isConnectable={data.editable} />
    </div>
  )
}

/** The hourglass beside a card's state label while its ticket is being worked on. */
function Hourglass(props: { card: TicketNodeModel; onOpen(ticketId: string, attemptId: string): void }): JSX.Element | null {
  const { card, onOpen } = props
  const attemptId = card.working
  if (attemptId === null) {
    return null
  }
  return <WorkingHourglass ticketKey={card.ticketKey} onOpen={() => onOpen(card.id, attemptId)} />
}

/** The effort and size badges on a card's bottom edge: the effort beside the size, either one alone, none for neither. */
function TicketTags({ size, effort }: Pick<TicketNodeModel, 'size' | 'effort'>): JSX.Element | null {
  if (size === null && effort === null) {
    return null
  }
  return (
    <span className="pg-tags">
      {effort === null ? null : (
        <span className="pg-effort" title={`Effort: ${effort}`}>
          {`${effort} effort`}
        </span>
      )}
      {size === null ? null : (
        <span className={size === 'micro' ? 'pg-size is-micro' : 'pg-size'} title={`Size: ${size}`}>
          {size}
        </span>
      )}
    </span>
  )
}

function SprintNode({ data }: NodeProps<SprintFlowNode>): JSX.Element {
  const sprint = data.model
  return (
    <div className={sprint.active ? 'pg-sprint is-active' : 'pg-sprint'}>
      <span className="pg-sprint-heading">{sprint.heading}</span>
      <span className="pg-sprint-goal" title={sprint.goal} style={{ '--pg-goal-lines': sprint.goalLines } as CSSProperties}>
        {sprint.goal}
      </span>
      <span className="pg-sprint-detail">{sprint.detail}</span>
      {data.editable ? (
        <button type="button" className="pg-add nodrag" onClick={() => data.onAddTicket(sprint.sprintId)}>
          + Ticket
        </button>
      ) : null}
      {data.editable && !sprint.hasAcceptance ? (
        <button type="button" className="pg-add nodrag" onClick={() => data.onAddAcceptance(sprint.sprintId)}>
          + Acceptance
        </button>
      ) : null}
    </div>
  )
}

function DividerNode({ data }: NodeProps<DividerFlowNode>): JSX.Element {
  return (
    <div className={`pg-divider ew-tone-${DIVIDER_TONES[data.model.tone]}`}>
      <span className="pg-divider-pill">{data.model.label}</span>
    </div>
  )
}

/** The one bracket from a sprint's work rows to its acceptance node: down the gutter, then an arrow into the card. */
function JoinNode({ data }: NodeProps<JoinFlowNode>): JSX.Element {
  const { width, height, met, label } = data.model
  return (
    <svg
      className={met ? 'pg-join is-met' : 'pg-join is-waiting'}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <path className="pg-join-line" d={`M${width} 0H${JOIN_STEM}V${height}H${width - JOIN_HEAD}`} />
      <path className="pg-join-head" d={`M${width - JOIN_HEAD} ${height - 4}L${width} ${height}L${width - JOIN_HEAD} ${height + 4}Z`} />
    </svg>
  )
}

function RowCheckNode({ data }: NodeProps<RowCheckFlowNode>): JSX.Element {
  const chip = data.model
  return (
    <div className={`pg-rowcheck ew-tone-${chip.tone}`} title={chip.detail}>
      <span className="pg-rowcheck-row">{chip.label}</span>
      <span className="pg-rowcheck-status">
        <span aria-hidden="true">{CHECK_ICONS[chip.state]}</span> {chip.status}
      </span>
    </div>
  )
}

function EpicNode({ data }: NodeProps<EpicFlowNode>): JSX.Element {
  return (
    <div className="pg-epic">
      <svg width="20" height="20" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="pg-epic-icon">
        <path d="M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5zM8 6v4M6.2 7l3.6 2" />
      </svg>
      <span className="pg-epic-text">
        <span className="pg-epic-eyebrow">{data.model.eyebrow}</span>
        <span className="pg-epic-title">{data.model.title}</span>
      </span>
    </div>
  )
}

export const NODE_TYPES: NodeTypes = {
  ticket: TicketNode,
  sprint: SprintNode,
  divider: DividerNode,
  epic: EpicNode,
  join: JoinNode,
  rowcheck: RowCheckNode
}
