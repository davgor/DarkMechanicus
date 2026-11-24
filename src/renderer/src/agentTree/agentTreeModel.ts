/** Generic, iterative agent forest model; independent of chat and transport state. */
export type AgentStatus = 'running' | 'needs_you' | 'idle' | 'done' | 'failed'

export interface AgentTreeNodeInput {
  id: string
  parentId: string | null
  name: string
  secondary: string
  chip: string | null
  ticket: { key: string; verified: boolean; mismatch: boolean } | null
  status: AgentStatus
  startedAt: number | null
  endedAt: number | null
  lastTool: string | null
}

export interface AgentTreeNode extends AgentTreeNodeInput {
  depth: number
  hue: number
  children: AgentTreeNode[]
  finished: AgentTreeNode[]
  descendants: number
  needsYouBelow: boolean
}

export interface AgentTreeCounts {
  needsYou: number
  working: number
  done: number
  failed: number
}

export interface AgentTreeModel {
  roots: AgentTreeNode[]
  counts: AgentTreeCounts
}

/** FNV-1a over UTF-16 code units, including both units of surrogate pairs. */
export function hueOf(id: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index++) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193)
  }
  return (hash >>> 0) % 8
}

export function elapsedMs(node: AgentTreeNodeInput, now: number): number | null {
  return node.startedAt === null ? null : (node.endedAt ?? now) - node.startedAt
}

/** Last occurrences win, including their position in the input order. */
export function buildAgentTree(inputs: readonly AgentTreeNodeInput[]): AgentTreeModel {
  const nodes = new Map<string, AgentTreeNode>()
  for (const input of inputs) {
    nodes.delete(input.id)
    nodes.set(input.id, {
      ...input,
      depth: 0,
      hue: hueOf(input.id),
      children: [],
      finished: [],
      descendants: 0,
      needsYouBelow: false
    })
  }
  repairParents(nodes)
  const { roots, counts } = attachNodes(nodes)
  aggregateNodes(nodes, roots)
  return { roots, counts }
}

function repairParents(nodes: Map<string, AgentTreeNode>): void {
  // Cut only the repeated node's parent edge. Settled chains need no further walks.
  const settled = new Set<string>()
  for (const node of nodes.values()) {
    if (settled.has(node.id)) continue
    const path = new Set<string>()
    let current: AgentTreeNode | undefined = node
    while (current !== undefined && !settled.has(current.id)) {
      if (path.has(current.id)) {
        current.parentId = null
        break
      }
      path.add(current.id)
      const parent: AgentTreeNode | undefined = current.parentId === null ? undefined : nodes.get(current.parentId)
      if (parent === undefined) current.parentId = null
      current = parent
    }
    for (const id of path) settled.add(id)
  }
}

function attachNodes(nodes: Map<string, AgentTreeNode>): { roots: AgentTreeNode[]; counts: AgentTreeCounts } {
  const roots: AgentTreeNode[] = []
  const counts: AgentTreeCounts = { needsYou: 0, working: 0, done: 0, failed: 0 }
  for (const node of nodes.values()) {
    if (node.status === 'needs_you') counts.needsYou++
    else if (node.status === 'running') counts.working++
    else if (node.status === 'done') counts.done++
    else if (node.status === 'failed') counts.failed++

    const parent = node.parentId === null ? undefined : nodes.get(node.parentId)
    if (parent === undefined) roots.push(node)
    else if (node.status === 'done' || node.status === 'failed') parent.finished.push(node)
    else parent.children.push(node)
  }
  return { roots, counts }
}

function aggregateNodes(nodes: Map<string, AgentTreeNode>, roots: AgentTreeNode[]): void {
  // Parent-before-child order gives depths; reverse order aggregates both child groups.
  const ordered = [...roots]
  for (let index = 0; index < ordered.length; index++) {
    const node = ordered[index]
    for (const child of node.children) {
      child.depth = node.depth + 1
      ordered.push(child)
    }
    for (const child of node.finished) {
      child.depth = node.depth + 1
      ordered.push(child)
    }
  }
  for (let index = ordered.length - 1; index >= 0; index--) {
    const node = ordered[index]
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId)
    if (parent === undefined) continue
    parent.descendants += node.descendants + 1
    if (node.status === 'needs_you' || node.needsYouBelow) parent.needsYouBelow = true
  }
}

/** Counts omit idle nodes, so callers supply whether the forest has any roots. */
export function headerText(counts: AgentTreeCounts, hasNodes: boolean): string {
  const parts: string[] = []
  if (counts.needsYou !== 0) parts.push(`${counts.needsYou} needs you`)
  if (counts.working !== 0) parts.push(`${counts.working} working`)
  if (counts.done !== 0) parts.push(`${counts.done} done`)
  if (counts.failed !== 0) parts.push(`${counts.failed} failed`)
  return parts.length > 0 ? parts.join(' · ') : hasNodes ? 'Idle' : 'No agents'
}
