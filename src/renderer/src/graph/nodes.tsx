import { Handle, Position, type NodeProps, type NodeTypes } from '@xyflow/react'
import type { CSSProperties } from 'react'
import type { DividerFlowNode, EpicFlowNode, SprintFlowNode, TicketFlowNode } from './flowElements'
import type { Tone } from './ticketStates'

const DIVIDER_TONES: Record<'passed' | 'locked' | 'awaiting' | 'neutral', Tone> = {
  passed: 'accepted',
  locked: 'running',
  awaiting: 'attention',
  neutral: 'neutral'
}

function TicketNode({ data }: NodeProps<TicketFlowNode>): JSX.Element {
  const card = data.model
  const classes = ['pg-card', `ew-tone-${card.tone}`, card.dashed ? 'is-dashed' : '', data.active ? 'is-active' : '']
  return (
    <div className={classes.filter((name) => name !== '').join(' ')} data-ticket={card.id}>
      {card.note === null ? null : <span className="pg-note">{card.note}</span>}
      <Handle type="target" position={Position.Top} isConnectable={data.editable} />
      <span className="pg-card-label">{card.label}</span>
      <span className="pg-card-title">{card.title}</span>
      {card.size === null ? null : (
        <span className={card.size === 'micro' ? 'pg-size is-micro' : 'pg-size'} title={`Size: ${card.size}`}>
          {card.size}
        </span>
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={data.editable} />
    </div>
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
  epic: EpicNode
}
