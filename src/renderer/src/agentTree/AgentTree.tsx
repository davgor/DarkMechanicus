import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '../components/Icon'
import { formatElapsed } from '../epic/time'
import { elapsedMs, headerText, type AgentTreeNode, type AgentTreeModel } from './agentTreeModel'
import './agentTree.css'

/**
 * Optional needs-you controls: with them a waiting row's dot and a collapsed row's bubbled dot are buttons that call
 * `select` with the row's node id; `below` is the number waiting in a row's subtree and `deciding` the rows whose
 * prompts the Magos is still deciding.
 */
export interface NeedsYouControls {
  below: ReadonlyMap<string, number>
  deciding: ReadonlySet<string>
  select(id: string): void
}

interface AgentTreeProps {
  tree: AgentTreeModel
  selectedId: string | null
  onSelect(id: string): void
  now: number
  label?: string
  needsYou?: NeedsYouControls
  /** A row's small trailing progress, such as its to-do count; null renders nothing. */
  progress?: (node: AgentTreeNode) => ReactNode
}

interface Row {
  key: string
  parent: string | null
  depth: number
  name: string
  node: AgentTreeNode | null
  children: Row[]
  open: boolean
}

// Tuple keys keep synthetic groups distinct even from arbitrary external node ids.
function nodeRow(node: AgentTreeNode, parent: string | null, depth: number): Row {
  return { key: JSON.stringify(['node', node.id]), parent, depth, name: node.name, node, children: [], open: true }
}

function rowsFor(roots: AgentTreeNode[], expansion: ReadonlyMap<string, boolean>): Row[] {
  const rows: Row[] = []
  const stack = roots.map((node) => nodeRow(node, null, 1)).reverse()
  while (stack.length) {
    const row = stack.pop()!
    if (row.node) {
      row.children = row.node.children.map((node) => nodeRow(node, row.key, row.depth + 1))
      if (row.node.finished.length) {
        const key = JSON.stringify(['finished', row.node.id])
        row.children.push({ key, parent: row.key, depth: row.depth + 1, name: `Finished ${row.node.finished.length}`,
          node: null, open: false, children: row.node.finished.map((node) => nodeRow(node, key, row.depth + 2)) })
      }
    }
    row.open = expansion.get(row.key) ?? row.open
    rows.push(row)
    if (row.open) stack.push(...row.children.slice().reverse())
  }
  return rows
}

/**
 * The keys of the rows that hold the node with `id` (its ancestors and a Finished group), outermost first; null when
 * the tree has no such node. Walks with a stack, as `rowsFor` does, so a deep model never recurses.
 */
function ancestorKeys(roots: AgentTreeNode[], id: string): string[] | null {
  const stack = roots.map((node) => ({ node, ancestors: [] as string[] }))
  while (stack.length) {
    const { node, ancestors } = stack.pop()!
    if (node.id === id) return ancestors
    const key = JSON.stringify(['node', node.id])
    const finished = JSON.stringify(['finished', node.id])
    for (const child of node.children) stack.push({ node: child, ancestors: [...ancestors, key] })
    for (const child of node.finished) stack.push({ node: child, ancestors: [...ancestors, key, finished] })
  }
  return null
}

/**
 * Opens the rows that hide the selected node (a collapsed ancestor, a closed Finished group) and scrolls its row into
 * view, once per selection, so an agent selected from outside the tree (a landing, a link) is shown. A row the person
 * picked in the tree is already in view, so the returned `picked` marks it shown. Later toggles by the person stand
 * until the selection changes again.
 */
function useRevealSelected(roots: AgentTreeNode[], selectedId: string | null,
  setExpansion: (update: (previous: ReadonlyMap<string, boolean>) => ReadonlyMap<string, boolean>) => void,
  elements: ReadonlyMap<string, HTMLLIElement>): (id: string) => void {
  const revealed = useRef<string | null>(null)
  const scroll = useRef<string | null>(null)
  useEffect(() => {
    if (selectedId === null || revealed.current === selectedId) return
    const ancestors = ancestorKeys(roots, selectedId)
    if (ancestors === null) return
    revealed.current = selectedId
    scroll.current = JSON.stringify(['node', selectedId])
    if (ancestors.length > 0) setExpansion((previous) => {
      if (ancestors.every((key) => previous.get(key) === true)) return previous
      const next = new Map(previous)
      for (const key of ancestors) next.set(key, true)
      return next
    })
  }, [roots, selectedId, setExpansion])
  useEffect(() => {
    const element = scroll.current === null ? undefined : elements.get(scroll.current)
    if (element === undefined) return
    scroll.current = null
    // jsdom has no scrollIntoView.
    element.scrollIntoView?.({ block: 'nearest' })
  })
  return (id) => { revealed.current = id }
}

const statuses = {
  running: { text: 'Running', glyph: '●' },
  needs_you: { text: 'Needs you', glyph: '!' },
  idle: { text: 'Idle', glyph: '○' },
  done: { text: 'Done', glyph: '✓' },
  failed: { text: 'Failed', glyph: '×' }
}

function TicketKey({ node }: { node: AgentTreeNode }): JSX.Element | null {
  if (!node.ticket) return null
  const ticketTitle = node.ticket.mismatch ? 'Label named another ticket; the claim wins' : undefined
  return <span title={ticketTitle}><span className={node.ticket.verified ? undefined : 'at-unverified'}
    title={node.ticket.verified ? undefined : 'Not confirmed by a claim'}>{node.ticket.key}</span></span>
}

function NodeDetails({ node, now, progress }: { node: AgentTreeNode; now: number; progress: Controls['progress'] }): JSX.Element {
  const elapsed = elapsedMs(node, now)
  const status = statuses[node.status]
  return <>
    <span className="at-dot" data-hue={node.hue} aria-hidden="true" />
    <span className="at-name">{node.name}</span>
    {node.chip !== null && <span className="at-chip">{node.chip}</span>}
    <TicketKey node={node} />
    <span className="at-status" data-status={node.status} aria-label={status.text}>{status.glyph}</span>
    {elapsed !== null && <span className="at-elapsed">{formatElapsed(elapsed)}</span>}
    {progress?.(node)}
    {node.lastTool !== null && <span className="at-tool">{node.lastTool}</span>}
    {node.secondary && <span className="at-secondary" title={node.secondary}>{node.secondary}</span>}
  </>
}

interface Controls {
  focused: string | undefined
  selectedId: string | null
  now: number
  needsYou: NeedsYouControls | undefined
  progress: AgentTreeProps['progress']
  register(key: string, element: HTMLLIElement | null): void
  focus(key: string): void
  toggle(row: Row): void
  activate(row: Row): void
  keyDown(event: KeyboardEvent, row: Row): void
}

function Disclosure({ row, controls }: { row: Row; controls: Controls }): JSX.Element {
  if (!row.children.length) return <span className="at-chevron-space" />
  return <button type="button" className="at-chevron" tabIndex={-1} aria-label={`${row.open ? 'Collapse' : 'Expand'} ${row.name}`}
    aria-expanded={row.open} onClick={(event) => { event.stopPropagation(); controls.toggle(row) }}>
    <Icon name="chevron-right" size={14} />
  </button>
}

function CollapsedDetails({ row, controls }: { row: Row; controls: Controls }): JSX.Element | null {
  if (row.open || !row.node) return null
  return <>
    <span className="at-count">(+{row.node.descendants})</span>
    {controls.needsYou === undefined && row.node.needsYouBelow && <span className="at-needs" aria-label="Descendant needs you" />}
  </>
}

/** The amber dot of a waiting row, or of a collapsed row with prompts waiting below it; it selects the row's card. */
function NeedsYouDot({ row, controls }: { row: Row; controls: Controls }): JSX.Element | null {
  const { needsYou } = controls
  if (needsYou === undefined || !row.node) return null
  const node = row.node
  const below = row.open ? 0 : needsYou.below.get(node.id) ?? 0
  const deciding = needsYou.deciding.has(node.id)
  return <>
    {(node.status === 'needs_you' || below > 0) && <button type="button" className="at-needs" tabIndex={-1}
      aria-label={`${node.name} needs you`} title={below > 0 ? `${below} waiting below` : undefined}
      onClick={(event) => { event.stopPropagation(); needsYou.select(node.id) }} />}
    {deciding && <span className="at-deciding" role="img" aria-label="Magos deciding" title="Magos deciding">◌</span>}
  </>
}

function TreeRow({ row, controls, children }: { row: Row; controls: Controls; children: ReactNode }): JSX.Element {
  const expandable = row.children.length > 0
  return <li role="treeitem" aria-label={row.name} aria-level={row.depth}
    aria-selected={row.node !== null && row.node.id === controls.selectedId}
    aria-expanded={expandable ? row.open : undefined} tabIndex={row.key === controls.focused ? 0 : -1}
    ref={(element) => controls.register(row.key, element)} onFocus={(event) => {
      if (event.target === event.currentTarget) controls.focus(row.key)
    }} onKeyDown={(event) => controls.keyDown(event, row)}>
    <div className="at-row" onClick={() => controls.activate(row)}>
      <Disclosure row={row} controls={controls} />
      {row.node ? <NodeDetails node={row.node} now={controls.now} progress={controls.progress} /> : <span className="at-name">{row.name}</span>}
      <CollapsedDetails row={row} controls={controls} />
      <NeedsYouDot row={row} controls={controls} />
    </div>
    {children}
  </li>
}

function horizontalTarget(key: string, row: Row, controls: Controls): string | undefined {
  if (key === 'ArrowRight') {
    if (!row.open && row.children.length) controls.toggle(row)
    else return row.children[0]?.key
  } else if (row.open && row.children.length) controls.toggle(row)
  else return row.parent ?? undefined
  return undefined
}

function verticalTarget(key: string, row: Row, rows: Row[]): string | undefined {
  const index = rows.indexOf(row)
  switch (key) {
    case 'ArrowDown': return rows[index + 1]?.key
    case 'ArrowUp': return rows[index - 1]?.key
    case 'Home': return rows[0]?.key
    case 'End': return rows.at(-1)?.key
    default: return undefined
  }
}

function navigate(event: KeyboardEvent, row: Row, rows: Row[], controls: Controls): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft', 'Enter', ' '].includes(event.key)) return
  let target: string | undefined
  switch (event.key) {
    case 'ArrowRight': case 'ArrowLeft': target = horizontalTarget(event.key, row, controls); break
    case 'Enter': case ' ': controls.activate(row); break
    default: target = verticalTarget(event.key, row, rows)
  }
  event.preventDefault()
  event.stopPropagation()
  if (target) controls.focus(target)
}

// Build nested groups bottom-up so a deeply nested model never recurses in our renderer.
function renderRows(rows: Row[], controls: Controls): ReactNode {
  const rendered = new Map<string, ReactNode>()
  for (const row of rows.slice().reverse()) {
    const children = row.open && row.children.length > 0
      ? <ul role="group" className="at-group">{row.children.map((child) => rendered.get(child.key))}</ul> : null
    rendered.set(row.key, <TreeRow key={row.key} row={row} controls={controls}>{children}</TreeRow>)
  }
  return rows.filter((row) => row.parent === null).map((row) => rendered.get(row.key))
}

export function AgentTree({ tree, selectedId, onSelect, now, label = 'Agents', needsYou, progress }: AgentTreeProps): JSX.Element {
  const [expansion, setExpansion] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [focused, setFocused] = useState<string>()
  const elements = useRef(new Map<string, HTMLLIElement>())
  const picked = useRevealSelected(tree.roots, selectedId, setExpansion, elements.current)
  const rows = rowsFor(tree.roots, expansion)
  const active = rows.find((row) => row.key === focused) ?? rows.find((row) => row.node?.id === selectedId) ?? rows[0]
  function focus(key: string): void {
    setFocused(key)
    elements.current.get(key)?.focus()
  }
  function toggle(row: Row): void {
    focus(row.key)
    setExpansion((previous) => new Map(previous).set(row.key, !row.open))
  }
  const controls: Controls = {
    focused: active?.key, selectedId, now, needsYou, progress, focus, toggle,
    register: (key, element) => { if (element) elements.current.set(key, element); else elements.current.delete(key) },
    activate: (row) => { focus(row.key); if (row.node) { picked(row.node.id); onSelect(row.node.id) } else toggle(row) },
    keyDown: (event, row) => navigate(event, row, rows, controls)
  }
  return <div className="at-tree">
    <p className="at-header">{headerText(tree.counts, tree.roots.length > 0)}</p>
    <ul role="tree" aria-label={label} className="at-root">{renderRows(rows, controls)}</ul>
  </div>
}
