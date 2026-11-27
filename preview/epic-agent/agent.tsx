import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/jitlessZod'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/settings/settings.css'
import './preview.css'
import type { AgentChatEvent, AgentChatSnapshot, AttentionItem, PendingPrompt } from '../../src/shared/agents/agentChat'
import type { Callsign } from '../../src/shared/agents/callsign'
import type { ChatItem, ChatRecord } from '../../src/shared/agents/chat'
import type { TrackedFolderView } from '../../src/shared/desktop/api'
import type { PlanView } from '../../src/shared/domain/views'
import { AgentChat } from '../../src/renderer/src/agentChat/AgentChat'
import { agentChatScenarioClockStart, agentChatScenarios } from '../../src/renderer/src/agentChat/__mocks__/agentChatScenario'
import { FakeAgentChat } from '../../src/renderer/src/__mocks__/fakeAgentChat'
import { FakeDm } from '../../src/renderer/src/__mocks__/fakeDm'
import { chatRecord } from '../../src/renderer/src/__mocks__/fixtures'
import { createManualClock } from '../../src/renderer/src/__mocks__/manualClock'
import { browserScheduler } from '../../src/renderer/src/app/scheduler'
import { ToastProvider } from '../../src/renderer/src/app/toasts'
import { ClockContext, type Clock } from '../../src/renderer/src/epic/clock'
import { EpicWorkspace } from '../../src/renderer/src/epic/EpicWorkspace'
import { ViewMemoryContext, createViewMemory } from '../../src/renderer/src/epic/viewMemory'
import { FakeBackend, scenario } from '../../src/renderer/src/epic/__mocks__/fakeBackend'
import { fakeOrchestration } from '../../src/renderer/src/epic/__mocks__/fakeOrchestration'
import { bundle, epicDetail, folder, runView, savedPlan, ticket } from '../../src/renderer/src/epic/__mocks__/fixtures'
import { NotificationSettings } from '../../src/renderer/src/settings/NotificationSettings'

/**
 * The epic Agent tab's states for `scripts/capture-agent-chat.mjs`: the real `EpicWorkspace` (or a standalone
 * `AgentChat` / `NotificationSettings`) over the renderer test fakes, seeded from `agentChatScenario.ts`. `?state=`
 * picks the state; the page reaches it with real DOM clicks after mount, then writes `#observations` (data-ready).
 */
declare global {
  interface Window { __errors: string[] }
}

type Mount = 'epic' | 'chat' | 'settings'
interface StateDef {
  mount: Mount
  /** Seeds the fakes before the page mounts. */
  seed?(context: Seeded): void
  /** Real DOM clicks (and fake pushes) after mount; resolves once the target state's DOM is present. */
  reach(context: Seeded): Promise<void>
}
interface Seeded {
  backend: FakeBackend
  chatApi: FakeAgentChat
  clock: Clock & { advance(ms: number): void }
  chats: ChatRecord[]
  folder: TrackedFolderView
  /** agent-tree: whether the Finished 1 group was expanded when the tree first showed it, before any click. */
  finishedExpandedAtStart: boolean | null
}

const STEP_MS = 12_000
const FOLDER = folder()
const RUN = runView()
const ORCHESTRATOR = chatRecord({
  id: 'chat_orch', folder: FOLDER.path, role: 'orchestrator', runId: RUN.id, epicId: 'ep_1', surface: 'gui', title: 'Orchestrator · Plan'
})
const PLANNER = chatRecord({
  id: 'chat_plan', folder: FOLDER.path, role: 'planner', epicId: 'ep_1', surface: 'gui', title: 'Planner', createdAt: '2026-02-01T10:00:00.000Z'
})
const scenarios = agentChatScenarios
const conversation = scenarios.streaming.snapshot.items
const AT = conversation[0].at
const DM442: Callsign = { role: 'Acolyte', ticketKey: 'DM-442', ordinal: null, purpose: null, ticketVerified: true }

// ---------------------------------------------------------------------------------------------- DOM helpers

// The renderer's lib target predates Promise.withResolvers, so the executor form stays here.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

async function until<T>(find: () => T | null | undefined | false, label: string): Promise<T> {
  const deadline = Date.now() + STEP_MS
  for (;;) {
    const found = find()
    if (found) return found
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(50)
  }
}

const $ = (selector: string, root: ParentNode = document): HTMLElement | null => root.querySelector<HTMLElement>(selector)
const text = (element: Element | null): string | null => element === null ? null : (element.textContent ?? '').replace(/\s+/g, ' ').trim()
const treeItem = (name: string): HTMLElement | null => $(`[role="treeitem"][aria-label="${CSS.escape(name)}"]`)
const buttonNamed = (name: string, root: ParentNode = document): HTMLButtonElement | null =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => (button.getAttribute('aria-label') ?? text(button)) === name) ?? null

/** A real click event, bubbling through React's root listener exactly as a pointer click does. */
function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
}

async function clickWhenPresent(find: () => Element | null, label: string): Promise<void> {
  click(await until(find, label))
}

/**
 * Clicks the Agent view button. Below 1100 px the app starts the rail collapsed, so at a narrow viewport the states
 * that show the tree reach it as a person would: one real click on Expand Epic agents.
 */
async function openAgentTab(): Promise<void> {
  await clickWhenPresent(() => $('[role="group"][aria-label="View"] .ew-toggle-agent'), 'the Agent view button')
  await until(() => $('aside[aria-label="Epic agents"]') ?? buttonNamed('Start planner'), 'the Agent stage')
  const expand = buttonNamed('Expand Epic agents')
  if (expand !== null) click(expand)
}

/** Clicks a tree row's own line (not its nested children), which selects the node. */
const selectNode = (name: string): Promise<void> =>
  clickWhenPresent(() => treeItem(name)?.querySelector(':scope > .at-row') ?? null, `the ${name} tree row`)

const chatLoaded = (): Promise<unknown> => until(() => $('.agent-chat .chat-msg-who') ?? $('.agent-chat .chat-thread'), 'the chat transcript')

// ---------------------------------------------------------------------------------------------- seeds

const snapshot = (context: Seeded, data: AgentChatSnapshot): void => {
  context.backend.agentChat.snapshotResult = { ok: true, data }
}

/** The tree scenario with the Acolytes' tickets verified, so their titles come from the saved plan by key. */
function verifiedTree(): ChatItem[] {
  return scenarios.tree.snapshot.items.map((item) => item.kind === 'thread' && item.callsign?.role === 'Acolyte'
    ? { ...item, callsign: { ...item.callsign, ticketVerified: true } }
    : item)
}

const treeSnapshot = (): AgentChatSnapshot => ({ ...scenarios.tree.snapshot, items: verifiedTree() })

/**
 * The tool scenario with the callsign main stamps on a worker's thread item (the scenario's thread predates
 * callsigns, so the tree would list it as an unnamed Servitor): the rail names it Acolyte:DM-785.
 */
const toolSnapshot = (): AgentChatSnapshot => ({
  ...scenarios.tool.snapshot,
  items: scenarios.tool.snapshot.items.map((item) => item.kind === 'thread'
    ? { ...item, callsign: { role: 'Acolyte', ticketKey: 'DM-785', ordinal: null, purpose: null, ticketVerified: false } }
    : item)
})

/** The sample saved plan plus DM-1 and DM-2 in sprint 1: the tree scenario's Acolytes name these keys. */
function planWithTreeTickets(): PlanView {
  const base = bundle()
  const extra = [ticket('DM-1', 'Add retry banner'), ticket('DM-2', 'Fix lint')]
  return savedPlan({
    bundle: {
      ...base,
      tickets: [...base.tickets, ...extra],
      sprints: base.sprints.map((item) => item.ordinal === 1 ? { ...item, ticketIds: [...item.ticketIds, ...extra.map((entry) => entry.id)] } : item)
    }
  })
}

const callsignOf = (threadId: string): Callsign | null => {
  const thread = scenarios.tree.snapshot.items.find((item) => item.id === threadId)
  return thread?.kind === 'thread' ? thread.callsign ?? null : null
}

const attention = (threadId: string, arbitration: AttentionItem['arbitration'], title: string): AttentionItem => ({
  chatId: ORCHESTRATOR.id, promptId: `p-${threadId}`, kind: 'approval', threadId, callsign: callsignOf(threadId), arbitration, title, shown: true
})

function namedApproval(): AgentChatSnapshot {
  const base = scenarios.approval.snapshot
  const prompt = base.pending as Extract<PendingPrompt, { kind: 'approval' }>
  return {
    ...base,
    status: 'busy',
    items: [...base.items, { id: 'th-442', at: AT, kind: 'thread', parentItemId: null, label: 'Acolyte:DM-442 Run tests', state: 'running', callsign: DM442 }],
    pending: {
      ...prompt, id: 'approval-442', title: 'Run npm test?', detail: 'Run the targeted tests for DM-442.', threadId: 'th-442', callsign: DM442,
      attributed: true, arbitration: { state: 'escalated', reason: 'npm test is on your always-ask list.' },
      tool: { name: 'Bash', input: { command: 'npm test' } }
    }
  }
}

function magosDecided(): AgentChatSnapshot {
  return {
    ...scenarios.empty.snapshot,
    items: [
      ...conversation,
      { id: 'req-442', at: AT, kind: 'approval_request', callsign: DM442, requestId: 'r-442', category: 'command', tool: 'Bash', summary: 'Run npm test', input: { command: 'npm test' } },
      { id: 'dec-442', at: AT, kind: 'approval_decision', requestId: 'r-442', decision: 'deny', decidedBy: 'magos', reason: 'DM-442 changes only docs, so the full test run is not needed.' }
    ]
  }
}

function todosSnapshot(): AgentChatSnapshot {
  const bash: ChatItem = { id: 'todo-bash', at: AT, kind: 'tool_call', name: 'Bash', input: { command: 'npm test' }, status: 'running', resultSummary: null }
  return { ...scenarios.todos.snapshot, items: [...conversation, bash] }
}

const relay = (event: AgentChatEvent): AgentChatEvent => ({ ...event, folder: FOLDER.path, chatId: ORCHESTRATOR.id })

// ---------------------------------------------------------------------------------------------- states

const agentStates: Record<string, StateDef> = {
  'agent-empty': {
    mount: 'epic',
    seed: (context) => { context.chats.length = 0 },
    reach: async () => {
      await openAgentTab()
      await until(() => buttonNamed('Start planner'), 'Start planner')
    }
  },
  'agent-streaming': {
    mount: 'epic',
    seed: (context) => snapshot(context, scenarios.streaming.snapshot),
    reach: async (context) => {
      await openAgentTab()
      await chatLoaded()
      for (const event of scenarios.streaming.events) context.backend.agentChat.emit(relay(event))
      await until(() => $('.agent-chat-stream'), 'the streaming bubble')
    }
  },
  'agent-tool': {
    mount: 'epic',
    seed: (context) => snapshot(context, toolSnapshot()),
    reach: async () => {
      await openAgentTab()
      await until(() => $('.agent-chat .chat-thread') && $('.agent-chat .chat-tool-name, .agent-chat [class*="chat-tool"]'), 'the tool card and subagent thread')
      await clickWhenPresent(() => buttonNamed('Expand Finished 1'), 'the Finished 1 group')
      await until(() => treeItem('Acolyte:DM-785'), 'the Acolyte:DM-785 tree row')
    }
  },
  'agent-approval': {
    mount: 'epic',
    seed: (context) => snapshot(context, scenarios.approval.snapshot),
    reach: async () => {
      await openAgentTab()
      await until(() => $('.agent-prompt[role="alertdialog"]'), 'the docked approval card')
    }
  },
  'agent-worker': {
    mount: 'epic',
    seed: (context) => snapshot(context, treeSnapshot()),
    reach: async () => {
      await openAgentTab()
      await selectNode('Acolyte:DM-2')
      await until(() => $('[aria-label="Acolyte:DM-2 thread"]') && $('.agent-chat-hint'), 'the worker thread with its relay note')
    }
  },
  'agent-tree': {
    mount: 'epic',
    seed: (context) => snapshot(context, treeSnapshot()),
    reach: async (context) => {
      await openAgentTab()
      const finished = await until(() => treeItem('Finished 1'), 'the Finished 1 group')
      context.finishedExpandedAtStart = finished.getAttribute('aria-expanded') === 'true'
      await clickWhenPresent(() => buttonNamed('Expand Finished 1'), 'the Finished 1 group')
      await until(() => treeItem('Acolyte:DM-1') && treeItem('Inquisitor:DM-2') && treeItem('Servitor-1'), 'the expanded agent tree')
    }
  },
  'rail-collapsed': {
    mount: 'epic',
    seed: (context) => snapshot(context, treeSnapshot()),
    reach: async () => {
      await openAgentTab()
      await until(() => treeItem('Acolyte:DM-2'), 'the agent tree')
      await clickWhenPresent(() => buttonNamed('Collapse Epic agents'), 'Collapse Epic agents')
      await until(() => $('aside[aria-label="Epic agents"][data-collapsed="true"]'), 'the collapsed rail')
    }
  },
  'agent-todos': {
    mount: 'epic',
    seed: (context) => snapshot(context, todosSnapshot()),
    reach: async () => {
      await openAgentTab()
      await until(() => $('.todo-card-list [aria-current="step"]') && /· Bash/.test(text($('.turn-activity')) ?? ''), 'the to-do card and activity line')
    }
  },
  'agent-todos-collapsed': {
    mount: 'epic',
    seed: (context) => snapshot(context, todosSnapshot()),
    reach: async () => {
      await openAgentTab()
      await clickWhenPresent(() => $('.todo-card-header'), 'the To-dos header')
      await until(() => $('.todo-card-active'), 'the collapsed card’s active task')
    }
  },
  'agent-stalled': {
    mount: 'epic',
    seed: (context) => snapshot(context, scenarios.stalled.snapshot),
    reach: async (context) => {
      await openAgentTab()
      await chatLoaded()
      context.clock.advance(scenarios.stalled.advanceMs ?? 0)
      await until(() => $('.turn-activity-stalled'), 'the stalled activity line')
    }
  },
  'agent-changes': {
    mount: 'epic',
    seed: (context) => snapshot(context, scenarios.changes.snapshot),
    reach: async () => {
      await openAgentTab()
      await clickWhenPresent(() => buttonNamed('Expand Finished 1'), 'the Finished 1 group')
      await selectNode('Acolyte:DM-3')
      await until(() => $('[aria-label="Acolyte:DM-3 thread"]') && /^Changes · 2 files$/.test(text($('.acc-header')) ?? ''), 'the worker’s Changes card')
    }
  },
  'agent-approval-named': {
    mount: 'epic',
    seed: (context) => snapshot(context, namedApproval()),
    reach: async () => {
      await openAgentTab()
      await until(() => $('.agent-prompt .agent-prompt-arbitration'), 'the named approval card')
    }
  },
  'agent-magos-decided': {
    mount: 'epic',
    seed: (context) => snapshot(context, magosDecided()),
    reach: async () => {
      await openAgentTab()
      await until(() => /Denied by the Magos/.test(text($('.chat-approval-card')) ?? ''), 'the Magos decision record')
    }
  },
  'agent-needs-you': {
    mount: 'epic',
    // The planner chat is not watched (no transcript, so no subagent rows): its subagent's prompt badges its own row.
    // The Magos's main-thread prompt is queued behind the shown head, so it waits on no one yet and badges nothing.
    seed: (context) => {
      snapshot(context, treeSnapshot())
      context.chats.push(PLANNER)
      context.backend.agentChat.attentionResult = {
        ok: true, data: [
          attention('th-look', 'off', 'Run the glob?'), attention('th-review', 'escalated', 'Read src/lint.ts?'),
          { ...attention('th-plan-look', 'off', 'Read the plan?'), chatId: PLANNER.id, callsign: null },
          { ...attention('th-look', 'off', 'Run the build?'), promptId: 'p-queued', threadId: null, callsign: null, shown: false }
        ]
      }
    },
    reach: async () => {
      await openAgentTab()
      await until(() => buttonNamed('Servitor-1 needs you'), 'the worker’s needs-you dot')
      await until(() => buttonNamed('Lexmechanic needs you'), 'the unwatched planner’s needs-you dot')
      await clickWhenPresent(() => buttonNamed('Collapse Acolyte:DM-2'), 'Collapse Acolyte:DM-2')
      await until(() => buttonNamed('Acolyte:DM-2 needs you'), 'the collapsed parent’s dot')
    }
  },
  // Ten GUI chats: the run's Magos and nine planners, each named apart, with the second planner selected.
  'agent-planners': {
    mount: 'epic',
    seed: (context) => {
      snapshot(context, { ...scenarios.empty.snapshot, items: conversation })
      for (let index = 1; index <= 9; index++) {
        context.chats.push(chatRecord({
          id: `chat_plan_${index}`, folder: FOLDER.path, role: 'planner', epicId: 'ep_1', surface: 'gui', title: 'Planner',
          createdAt: `2026-02-0${index}T10:00:00.000Z`
        }))
      }
    },
    reach: async () => {
      await openAgentTab()
      await selectNode('Lexmechanic-2')
      await until(() => treeItem('Lexmechanic-2')?.getAttribute('aria-selected') === 'true' && treeItem('Lexmechanic-9'), 'the selected Lexmechanic-2')
      await chatLoaded()
    }
  }
}

async function reachGraph(): Promise<void> {
  await until(() => $('[aria-label="Plan graph"] .react-flow__node'), 'the plan graph')
}

const STATES: Record<string, StateDef> = {
  graph: { mount: 'epic', reach: reachGraph },
  'header-long': {
    mount: 'epic',
    seed: (context) => {
      context.folder = { ...FOLDER, name: `a-very-long-repository-folder-name-${'that-cannot-fit-beside-the-view-group-'.repeat(3)}at-any-width` }
      context.backend = new FakeBackend(scenario({
        saved: planWithTreeTickets(), run: RUN,
        epic: epicDetail({ title: 'An epic title long enough to need truncating beside the View group and plan actions at 1024 px' })
      }))
    },
    reach: reachGraph
  },
  ...agentStates,
  'chat-rail': {
    mount: 'chat',
    seed: (context) => { context.chatApi.snapshotResult = { ok: true, data: scenarios.tree.snapshot } },
    reach: async () => {
      await clickWhenPresent(() => $('.agent-chat-agents'), 'the Agents button')
      await selectNode('Inquisitor:DM-2')
      await until(() => treeItem('Inquisitor:DM-2')?.getAttribute('aria-selected') === 'true', 'the selected Inquisitor:DM-2 node')
    }
  },
  'chat-rail-collapsed': {
    mount: 'chat',
    seed: (context) => { context.chatApi.snapshotResult = { ok: true, data: scenarios.tree.snapshot } },
    reach: async () => {
      await clickWhenPresent(() => $('.agent-chat-agents'), 'the Agents button')
      await clickWhenPresent(() => buttonNamed('Collapse Chat agents'), 'Collapse Chat agents')
      await until(() => $('aside[aria-label="Chat agents"]') === null && $('.agent-chat-agents')?.getAttribute('aria-pressed') === 'false',
        'the rail closed by its chevron and the Agents toggle released')
    }
  },
  'settings-notifications': {
    mount: 'settings',
    reach: async () => { await until(() => $('[role="switch"]'), 'the notification settings form') }
  }
}

// ---------------------------------------------------------------------------------------------- observations

function accessibleName(element: HTMLElement): string {
  const labelled = element.getAttribute('aria-labelledby')
  const byId = labelled === null ? null : labelled.split(/\s+/).map((id) => text(document.getElementById(id)) ?? '').join(' ').trim()
  const label = (element as HTMLInputElement).labels?.[0]
  return element.getAttribute('aria-label') ?? (byId || null) ?? (label ? text(label) : null) ?? text(element) ?? ''
}

function railObservations(): { railWidth: number | null; railRightOfStage: boolean | null } {
  const rail = $('aside[aria-label="Epic agents"], aside[aria-label="Chat agents"]')
  const stage = $('.eap-centre') ?? $('.agent-chat-main')
  if (rail === null) return { railWidth: null, railRightOfStage: null }
  const box = rail.getBoundingClientRect()
  return { railWidth: box.width, railRightOfStage: stage === null ? false : box.left >= stage.getBoundingClientRect().right - 1 }
}

function todoObservations(): Record<string, unknown> {
  const list = $('.todo-card-list')
  const active = list?.querySelector<HTMLElement>('[aria-current="step"]') ?? null
  const inside = (inner: DOMRect, outer: DOMRect): boolean =>
    inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1 && inner.left >= outer.left - 1 && inner.right <= outer.right + 1
  return {
    todosHeader: text($('.todo-card-header')),
    todoRows: document.querySelectorAll('.todo-card-row').length,
    todoListScrolls: list === null ? null : list.scrollHeight > list.clientHeight,
    activeRowVisible: list === null || active === null ? null : inside(active.getBoundingClientRect(), list.getBoundingClientRect()),
    activityLine: text($('.turn-activity'))
  }
}

/** The epic header's row: the breadcrumb and title truncation and tooltips, and their place beside the View group. */
function headerObservations(): Record<string, unknown> | null {
  const heading = $('.ew-heading')
  const crumb = $('.ew-crumb')
  const title = $('.ew-title')
  const view = $('[role="group"][aria-label="View"]')
  if (heading === null || crumb === null || title === null || view === null) return null
  const box = { heading: heading.getBoundingClientRect(), crumb: crumb.getBoundingClientRect(), view: view.getBoundingClientRect() }
  return {
    crumb: crumb.textContent, crumbTitle: crumb.title, crumbTruncated: crumb.scrollWidth > crumb.clientWidth,
    crumbOneLine: box.crumb.height <= parseFloat(getComputedStyle(crumb).lineHeight) + 1,
    title: title.textContent, titleTitle: title.title, titleTruncated: title.scrollWidth > title.clientWidth,
    besideView: box.heading.right <= box.view.left + 0.5,
    sameRow: box.crumb.top < box.view.bottom && box.crumb.bottom > box.view.top,
    contained: [...heading.querySelectorAll('*')].every((element) => element.getBoundingClientRect().right <= box.heading.right + 0.5)
  }
}

function observe(state: string, context: Seeded | null): Record<string, unknown> {
  const view = $('[role="group"][aria-label="View"]')
  const agentLabel = $('.ew-toggle-agent strong')
  return {
    state,
    viewButtons: view === null ? [] : [...view.querySelectorAll('button')].map((button) => text(button)),
    agentFontWeight: agentLabel === null ? null : getComputedStyle(agentLabel).fontWeight,
    header: headerObservations(),
    planGraph: $('[aria-label="Plan graph"]') !== null,
    planList: $('[aria-label="Plan list"]') !== null,
    scorecard: $('section.es') !== null,
    agentChatRegion: $('section[aria-label="Agent chat"]') !== null,
    ...railObservations(),
    treeRows: [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].map((row) => ({
      name: row.getAttribute('aria-label'),
      level: Number(row.getAttribute('aria-level')),
      expanded: row.hasAttribute('aria-expanded') ? row.getAttribute('aria-expanded') === 'true' : null,
      selected: row.getAttribute('aria-selected') === 'true'
    })),
    finishedExpandedAtStart: context?.finishedExpandedAtStart ?? null,
    ...todoObservations(),
    changesHeader: text($('.acc-header')),
    cardHeading: text($('.agent-prompt h3')),
    cardArbitration: text($('.agent-prompt .agent-prompt-arbitration')),
    approvalRecord: text($('.chat-approval-card')),
    needsYouHeader: text($('.at-header')),
    badgedRows: document.querySelectorAll('button.at-needs').length,
    settingsControls: [...document.querySelectorAll<HTMLElement>('.preview-settings :is(input, textarea, select, button)')].map(accessibleName),
    agentsPressed: $('.agent-chat-agents')?.getAttribute('aria-pressed') ?? null,
    errors: [...window.__errors]
  }
}

function publish(observations: Record<string, unknown>): void {
  const script = document.createElement('script')
  script.type = 'application/json'
  script.id = 'observations'
  script.textContent = JSON.stringify(observations)
  script.dataset.ready = '1'
  document.body.append(script)
}

// ---------------------------------------------------------------------------------------------- mount

function seeded(): Seeded {
  const backend = new FakeBackend(scenario({ saved: planWithTreeTickets(), run: RUN }))
  const chatApi = new FakeAgentChat()
  return {
    backend, chatApi, clock: createManualClock(agentChatScenarioClockStart), chats: [ORCHESTRATOR], folder: FOLDER, finishedExpandedAtStart: null
  }
}

function render(mount: Mount, context: Seeded): JSX.Element {
  if (mount === 'settings') {
    window.dm = new FakeDm()
    return <ToastProvider scheduler={browserScheduler}><div className="preview-settings"><NotificationSettings /></div></ToastProvider>
  }
  const clock: Clock = context.clock
  if (mount === 'chat') {
    const dm = new FakeDm()
    dm.agentChat = context.chatApi
    window.dm = dm
    return <ClockContext.Provider value={clock}><div className="preview-chat">
      <AgentChat folder={null} chatId="fixture-chat" agentLabel="Magos" api={context.chatApi} rail="toggle"
        chat={{ role: 'orchestrator', runId: 'rn_fixture' }} />
    </div></ClockContext.Provider>
  }
  window.dm = context.backend
  return <ClockContext.Provider value={clock}><ViewMemoryContext.Provider value={createViewMemory()}>
    <div className="preview-epic-agent">
      <EpicWorkspace folder={context.folder} epicId="ep_1" refreshToken={0} onChanged={() => undefined} onOpenEpic={() => undefined}
        onDeleted={() => undefined} orchestration={fakeOrchestration({ chats: context.chats })} />
    </div>
  </ViewMemoryContext.Provider></ClockContext.Provider>
}

async function main(): Promise<void> {
  // One Electron profile serves every state: no rail, card or view memory may carry over from the previous one.
  window.localStorage.clear()
  const state = new URLSearchParams(window.location.search).get('state') ?? ''
  const definition = STATES[state]
  if (definition === undefined) {
    window.__errors.push(`Unknown state "${state}"`)
    publish(observe(state, null))
    return
  }
  const context = seeded()
  definition.seed?.(context)
  createRoot(document.getElementById('root')!).render(render(definition.mount, context))
  try {
    await definition.reach(context)
    await sleep(300)
  } catch (cause) {
    window.__errors.push(cause instanceof Error ? cause.message : String(cause))
  }
  publish(observe(state, context))
}

void main()
