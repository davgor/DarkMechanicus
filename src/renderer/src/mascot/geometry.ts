import type { MotionRect } from './motion'

interface TicketNodeGeometry {
  id: string
  type?: string
  position: { x: number; y: number }
  measured?: { width?: number; height?: number }
  width?: number
  height?: number
  data?: unknown
}

interface ViewportGeometry { x: number; y: number; zoom: number }

function workState(data: unknown): boolean {
  if (!data || typeof data !== 'object' || !('model' in data)) return false
  const model = data.model
  return Boolean(model && typeof model === 'object' && 'inProgress' in model && model.inProgress === true)
}

/** React Flow's current node positions become CSS coordinates in the board overlay. */
export function ticketSurfaces(nodes: TicketNodeGeometry[], viewport: ViewportGeometry): MotionRect[] {
  return nodes.flatMap((node) => {
    const width = node.measured?.width ?? node.width
    const height = node.measured?.height ?? node.height
    if (node.type !== 'ticket' || width === undefined || height === undefined) return []
    return [{
      id: node.id,
      x: node.position.x * viewport.zoom + viewport.x,
      y: node.position.y * viewport.zoom + viewport.y,
      width: width * viewport.zoom,
      height: height * viewport.zoom,
      inProgress: workState(node.data)
    }]
  })
}
