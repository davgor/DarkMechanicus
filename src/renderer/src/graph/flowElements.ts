/** Pure mapping from the graph model to React Flow nodes and edges. */
import { MarkerType, Position, type Edge, type Node } from '@xyflow/react'
import type {
  DividerNodeModel,
  EpicNodeModel,
  GraphModel,
  GraphNode,
  SprintNodeModel,
  TicketNodeModel
} from './graphModel'

type TicketNodeData = { model: TicketNodeModel; active: boolean; editable: boolean }
type SprintNodeData = { model: SprintNodeModel; editable: boolean; onAddTicket: (sprintId: string) => void }
type DividerNodeData = { model: DividerNodeModel }
type EpicNodeData = { model: EpicNodeModel }

export type TicketFlowNode = Node<TicketNodeData, 'ticket'>
export type SprintFlowNode = Node<SprintNodeData, 'sprint'>
export type DividerFlowNode = Node<DividerNodeData, 'divider'>
export type EpicFlowNode = Node<EpicNodeData, 'epic'>
export type FlowNode = TicketFlowNode | SprintFlowNode | DividerFlowNode | EpicFlowNode

interface FlowOptions {
  editable: boolean
  selectedTicketId: string | null
  onAddTicket(sprintId: string): void
}

const MET_COLOR = '#8a8070'
const WAITING_COLOR = '#6a6254'
const HANDLE_SIZE = 1

const FIXED = { draggable: false, selectable: false, connectable: false, focusable: false, deletable: false }

function placement(item: GraphNode): { id: string; position: { x: number; y: number }; width: number; height: number } {
  return { id: item.id, position: { x: item.x, y: item.y }, width: item.width, height: item.height }
}

function ticketNode(item: TicketNodeModel, options: FlowOptions): TicketFlowNode {
  const center = (item.width - HANDLE_SIZE) / 2
  return {
    ...placement(item),
    type: 'ticket',
    data: { model: item, active: item.id === options.selectedTicketId, editable: options.editable },
    draggable: options.editable,
    connectable: options.editable,
    selectable: true,
    focusable: true,
    deletable: false,
    zIndex: 2,
    ariaLabel: `${item.label}: ${item.title}`,
    handles: [
      { type: 'target', position: Position.Top, x: center, y: 0, width: HANDLE_SIZE, height: HANDLE_SIZE },
      { type: 'source', position: Position.Bottom, x: center, y: item.height, width: HANDLE_SIZE, height: HANDLE_SIZE }
    ]
  }
}

function toFlowNode(item: GraphNode, options: FlowOptions): FlowNode {
  switch (item.kind) {
    case 'ticket':
      return ticketNode(item, options)
    case 'sprint':
      return {
        ...placement(item),
        ...FIXED,
        type: 'sprint',
        zIndex: 1,
        data: { model: item, editable: options.editable, onAddTicket: options.onAddTicket }
      }
    case 'divider':
      return { ...placement(item), ...FIXED, type: 'divider', zIndex: 0, data: { model: item } }
    case 'epic':
      return { ...placement(item), ...FIXED, type: 'epic', zIndex: 1, data: { model: item } }
  }
}

export function toFlowNodes(model: GraphModel, options: FlowOptions): FlowNode[] {
  return model.nodes.map((item) => toFlowNode(item, options))
}

export function toFlowEdges(model: GraphModel, editable: boolean): Edge[] {
  const keys = new Map(
    model.nodes.filter((item): item is TicketNodeModel => item.kind === 'ticket').map((item) => [item.id, item.ticketKey])
  )
  return model.edges.map((item) => ({
    id: item.id,
    source: item.from,
    target: item.to,
    type: 'default',
    className: item.met ? 'pg-edge is-met' : 'pg-edge is-waiting',
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: item.met ? MET_COLOR : WAITING_COLOR },
    selectable: editable,
    deletable: editable,
    focusable: editable,
    ariaLabel: `${keys.get(item.to) ?? item.to} requires ${keys.get(item.from) ?? item.from} (${item.met ? 'met' : 'waiting'})`
  }))
}
