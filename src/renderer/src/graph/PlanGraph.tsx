import '@xyflow/react/dist/style.css'
import '../epic/tones.css'
import './graph.css'
import {
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useViewport,
  type Edge,
  type NodeMouseHandler,
  type OnBeforeDelete,
  type OnConnect,
  type OnNodeDrag
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { GraphMascot } from '../mascot/GraphMascot'
import { toFlowEdges, toFlowNodes, type FlowNode } from './flowElements'
import type { GraphModel } from './graphModel'
import { legendEntries, type LegendKind } from './legend'
import { NODE_TYPES } from './nodes'

export interface PlanGraphProps {
  model: GraphModel
  /** Draft view: connect handles, drag cards between sprints, delete edges, add tickets. */
  editable: boolean
  legend: LegendKind
  draftNumber: number
  selectedTicketId: string | null
  onSelectTicket(ticketId: string): void
  onConnect(from: string, to: string): void
  /** A card was dropped with its top edge at `top` (graph coordinates). */
  onDropTicket(ticketId: string, top: number): void
  onRemoveDependency(from: string, to: string): void
  onAddTicket(sprintId: string): void
  /** Adds the sprint's acceptance node; offered only on a draft sprint that has none. */
  onAddAcceptance(sprintId: string): void
  /** The hourglass of a ticket being worked on was clicked: open the live activity of its open attempt. */
  onOpenActivity(ticketId: string, attemptId: string): void
}

const DELETE_KEYS = ['Backspace', 'Delete']
const FIT_OPTIONS = { padding: 0.08 }
const PRO_OPTIONS = { hideAttribution: true }

/** Top-to-bottom plan flowchart on a dotted canvas (React Flow). */
export function PlanGraph(props: PlanGraphProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  )
}

function GraphLegend(props: { kind: LegendKind; draftNumber: number }): JSX.Element {
  const entries = legendEntries(props.kind, props.draftNumber)
  return (
    <div className="pg-legend" aria-label="Legend">
      <div className="pg-legend-states">
        {entries.states.map((item) => (
          <span key={item.label} className={`pg-legend-item ew-tone-${item.tone}`}>
            <span className="ew-dot" aria-hidden="true" />
            {item.label}
          </span>
        ))}
      </div>
      {entries.edges.map((item) => (
        <span key={item.label} className="pg-legend-item">
          <span className={item.dashed ? 'pg-legend-line is-dashed' : 'pg-legend-line'} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </div>
  )
}

function useGraphHandlers(props: PlanGraphProps, reset: () => void) {
  const { onSelectTicket, onConnect, onDropTicket, onRemoveDependency } = props
  const onNodeClick: NodeMouseHandler<FlowNode> = useCallback(
    (_event, node) => {
      if (node.type === 'ticket') {
        onSelectTicket(node.id)
      }
    },
    [onSelectTicket]
  )
  const connect: OnConnect = useCallback((connection) => onConnect(connection.source, connection.target), [onConnect])
  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback(
    (_event, node) => {
      reset()
      onDropTicket(node.id, node.position.y)
    },
    [reset, onDropTicket]
  )
  const onBeforeDelete: OnBeforeDelete<FlowNode, Edge> = useCallback(
    ({ edges }) => {
      edges.forEach((edge) => onRemoveDependency(edge.source, edge.target))
      return Promise.resolve(false)
    },
    [onRemoveDependency]
  )
  return { onNodeClick, onConnect: connect, onNodeDragStop, onBeforeDelete }
}

function GraphCanvas(props: PlanGraphProps): JSX.Element {
  const board = useRef<HTMLDivElement>(null)
  const viewport = useViewport()
  const { model, editable, selectedTicketId, onAddTicket, onAddAcceptance, onOpenActivity } = props
  const flowNodes = useMemo(
    () => toFlowNodes(model, { editable, selectedTicketId, onAddTicket, onAddAcceptance, onOpenActivity }),
    [model, editable, selectedTicketId, onAddTicket, onAddAcceptance, onOpenActivity]
  )
  const flowEdges = useMemo(() => toFlowEdges(model, editable), [model, editable])
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(flowNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(flowEdges)
  useEffect(() => setNodes(flowNodes), [flowNodes, setNodes])
  useEffect(() => setEdges(flowEdges), [flowEdges, setEdges])
  const reset = useCallback(() => setNodes(flowNodes), [flowNodes, setNodes])
  const handlers = useGraphHandlers(props, reset)
  return (
    <div ref={board} className={editable ? 'pg is-editable' : 'pg is-readonly'} aria-label="Plan graph">
      <ReactFlow<FlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        {...handlers}
        nodesDraggable={editable}
        nodesConnectable={editable}
        deleteKeyCode={editable ? DELETE_KEYS : null}
        colorMode="dark"
        fitView
        fitViewOptions={FIT_OPTIONS}
        minZoom={0.2}
        maxZoom={1.5}
        proOptions={PRO_OPTIONS}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
        <Controls position="bottom-right" orientation="horizontal" showInteractive={false} />
        <Panel position="top-right">
          <GraphLegend kind={props.legend} draftNumber={props.draftNumber} />
        </Panel>
      </ReactFlow>
      <GraphMascot board={board} nodes={nodes} viewport={viewport} />
    </div>
  )
}
