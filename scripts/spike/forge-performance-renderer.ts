/**
 * Renderer-side load sequences for the revamp matrix, bundled as an IIFE and injected into the built renderer.
 * They call the production renderer functions over the production preload (`window.dm.command`), so each sample is the
 * same IPC sequence the epic workspace, ticket panel and Kanban board issue.
 */
import type { CommandName } from '../../src/shared/domain/api'
import type { CommandInput, CommandOutput } from '../../src/shared/desktop/api'
import type { Runner } from '../../src/renderer/src/epic/runner'
import { loadWorkspace } from '../../src/renderer/src/epic/workspaceLoad'
import { loadHistory } from '../../src/renderer/src/ticket/ticketData'

interface DmCommand {
  command(folder: string, name: string, input: unknown): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
}

/** The board's first page of Done cards (`useKanbanBoard.ts` DONE_PAGE). */
const KANBAN_DONE_LIMIT = 20

function runnerFor(folder: string): Runner {
  // The production preload's contextBridge object; this bundle is injected into that renderer only.
  const dm = Reflect.get(window, 'dm') as DmCommand
  return async <K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandOutput<K>> => {
    const reply = await dm.command(folder, name, input)
    if (!reply.ok) throw new Error(`${name}: ${reply.error?.code ?? 'unknown'} ${reply.error?.message ?? ''}`)
    return reply.data as CommandOutput<K>
  }
}

async function timed(work: () => Promise<unknown>): Promise<{ ms: number; startedAt: number; endedAt: number }> {
  const startedAt = performance.timeOrigin + performance.now()
  const start = performance.now()
  await work()
  return { ms: performance.now() - start, startedAt, endedAt: performance.timeOrigin + performance.now() }
}

/** `useWorkspaceLoad`: the epic workspace's whole load (`loadWorkspace`). */
function planView(folder: string, epicId: string) {
  return timed(() => loadWorkspace(runnerFor(folder), epicId))
}

/** `TicketPanel` (`getTicket`) plus its History tab (`loadHistory`, paging `listEvents {epicId}`). */
function ticketPanel(folder: string, epicId: string, ticketId: string) {
  const runner = runnerFor(folder)
  return timed(() => Promise.all([runner('getTicket', { epicId, ticketId, view: 'saved' }), loadHistory(runner, epicId)]))
}

/** `useKanbanBoard` (`listKanbanCards {doneLimit}`) and the sidebar's `useKanbanCounts` (`getKanbanOpenCount`). */
function kanbanBoard(folder: string) {
  const runner = runnerFor(folder)
  return timed(() => Promise.all([runner('listKanbanCards', { doneLimit: KANBAN_DONE_LIMIT }), runner('getKanbanOpenCount', undefined)]))
}

/**
 * Resolves with the click and paint times (epoch ms) of the next click whose target content then appears: `selector`
 * must match a visible element, and the paint time is taken after the frame that first contains it.
 */
function armPaint(selector: string, text: string | null): Promise<{ clickAt: number; paintAt: number }> {
  const { promise, resolve } = Promise.withResolvers<{ clickAt: number; paintAt: number }>()
  let clickAt = 0
  document.addEventListener('click', () => { clickAt = performance.timeOrigin + performance.now() }, { capture: true, once: true })
  const check = (): void => {
    const element = [...document.querySelectorAll(selector)].find((node) => text === null || node.textContent === text)
    const box = element?.getBoundingClientRect()
    if (clickAt > 0 && box !== undefined && box.width > 0 && box.height > 0) {
      requestAnimationFrame(() => setTimeout(() => resolve({ clickAt, paintAt: performance.timeOrigin + performance.now() }), 0))
      return
    }
    requestAnimationFrame(check)
  }
  requestAnimationFrame(check)
  return promise
}

/** The `.folder` sidebar block of the tracked folder named `folderName`, or the document when null. */
function scopeOf(folderName: string | null): ParentNode | null {
  if (folderName === null) return document
  const name = [...document.querySelectorAll<HTMLElement>('.folder .folder-name')].find((node) => node.title === folderName)
  return name?.closest('.folder') ?? null
}

/** The center of `box` when the box is non-empty and its center lies inside the window, in CSS pixels. */
function onScreenCenter(box: DOMRect): { x: number; y: number } | null {
  const x = box.left + box.width / 2
  const y = box.top + box.height / 2
  const inside = x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight
  return box.width > 0 && box.height > 0 && inside ? { x, y } : null
}

/** True when a click at `point` would reach `node` (no overlay, such as the sidebar footer, covers it there). */
function reaches(node: Element, point: { x: number; y: number }): boolean {
  const hit = document.elementFromPoint(point.x, point.y)
  return hit !== null && (hit === node || node.contains(hit))
}

/**
 * The center of the first element matching `selector` (and `text` when given) that a click would reach, in CSS
 * pixels. An element that is covered or off screen is scrolled to the middle of its scroll container first.
 */
function centerOf(folderName: string | null, selector: string, text: string | null): { x: number; y: number } | null {
  for (const node of scopeOf(folderName)?.querySelectorAll(selector) ?? []) {
    if (text !== null && node.textContent !== text) continue
    const point = onScreenCenter(node.getBoundingClientRect())
    if (point !== null && reaches(node, point)) return point
    node.scrollIntoView({ block: 'center', inline: 'nearest' })
    const scrolled = onScreenCenter(node.getBoundingClientRect())
    if (scrolled !== null && reaches(node, scrolled)) return scrolled
  }
  return null
}

/** Fully visible ticket nodes of the plan graph, in DOM order, with the click point of each. */
function visibleTickets(): { id: string; title: string; x: number; y: number }[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node .pg-card[data-ticket]')].flatMap((node) => {
    const box = node.getBoundingClientRect()
    const visible = box.width > 0 && box.top > 0 && box.bottom < window.innerHeight && box.left > 0 && box.right < window.innerWidth
    const title = node.querySelector('.pg-card-title')?.textContent ?? ''
    return visible ? [{ id: node.dataset['ticket'] ?? '', title, x: box.left + box.width / 2, y: box.top + box.height / 2 }] : []
  })
}

let armed: Promise<{ clickAt: number; paintAt: number }> | null = null

/** Arms the paint watch synchronously, so the following CDP click is the one it times; `painted` awaits it. */
function arm(selector: string, text: string | null): void {
  armed = armPaint(selector, text)
}

function painted(): Promise<{ clickAt: number; paintAt: number }> | null {
  return armed
}

let clicks: { x: number; y: number; target: string }[] = []
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.className.toString() : String(event.target)
  clicks = [...clicks.slice(-4), { x: event.clientX, y: event.clientY, target }]
}, { capture: true })

/** Diagnostics for a selector wait that timed out: folders, `selector` matches, buckets, recent clicks, window size. */
function describe(selector: string) {
  return {
    folders: [...document.querySelectorAll<HTMLElement>('.folder .folder-name')].map((node) => node.title),
    matches: [...document.querySelectorAll<HTMLElement>(selector)].map((node) => {
      const box = node.getBoundingClientRect()
      const point = onScreenCenter(box)
      const hit = point === null ? null : document.elementFromPoint(point.x, point.y)
      return { text: node.textContent, top: Math.round(box.top), height: Math.round(box.height), hit: hit?.className.toString() ?? null }
    }),
    buckets: [...document.querySelectorAll<HTMLElement>('.bucket-header')].map((node) => {
      const box = node.getBoundingClientRect()
      return { label: node.getAttribute('aria-label'), expanded: node.getAttribute('aria-expanded'), top: Math.round(box.top), left: Math.round(box.left) }
    }),
    clicks,
    focused: document.hasFocus(),
    // A hidden page gets no animation frames, so a paint watch never resolves.
    visibility: document.visibilityState,
    window: { width: window.innerWidth, height: window.innerHeight },
    path: location.hash
  }
}

Object.assign(window, { dmRevamp: { planView, ticketPanel, kanbanBoard, arm, painted, centerOf, visibleTickets, describe } })
