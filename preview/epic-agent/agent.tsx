import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/jitlessZod'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/settings/settings.css'
import './preview.css'
import type { AgentChatEvent, AgentChatSnapshot, AttentionItem, PendingPrompt } from '../../src/shared/agents/agentChat'
import { chatModelOptions } from '../../src/shared/agents/models'
import hostCatalog from '../../src/main/agentChat/__fixtures__/omp/models.json'
import type { Callsign } from '../../src/shared/agents/callsign'
import type { ChatItem, ChatRecord } from '../../src/shared/agents/chat'
import type { TrackedFolderView } from '../../src/shared/desktop/api'
import type { PlanView } from '../../src/shared/domain/views'
import { AgentRolePicker } from '../../src/renderer/src/agentRoles/AgentRolePicker'
import { AgentChat } from '../../src/renderer/src/agentChat/AgentChat'
import { FirstPromptDialog } from '../../src/renderer/src/agents/ChatDialogs'
import { agentChatScenarioClockStart, agentChatScenarios } from '../../src/renderer/src/agentChat/__mocks__/agentChatScenario'
import { FakeAgentChat } from '../../src/renderer/src/__mocks__/fakeAgentChat'
import { FakeChatMail, mailEntry } from '../../src/renderer/src/__mocks__/fakeChatMail'
import { FakeChats } from '../../src/renderer/src/__mocks__/fakeChats'
import { FakeDm } from '../../src/renderer/src/__mocks__/fakeDm'
import { AgentMailContext, createAgentMailStore, type AgentMailStore } from '../../src/renderer/src/agents/useAgentMail'
import { chatRecord } from '../../src/renderer/src/__mocks__/fixtures'
import { createManualClock } from '../../src/renderer/src/__mocks__/manualClock'
import { browserScheduler } from '../../src/renderer/src/app/scheduler'
import type { EpicLanding } from '../../src/renderer/src/app/landing'
import { ToastProvider } from '../../src/renderer/src/app/toasts'
import { ClockContext, type Clock } from '../../src/renderer/src/epic/clock'
import { EpicWorkspace } from '../../src/renderer/src/epic/EpicWorkspace'
import { ViewMemoryContext, createViewMemory } from '../../src/renderer/src/epic/viewMemory'
import { FakeBackend, deliveryScenario, scenario } from '../../src/renderer/src/epic/__mocks__/fakeBackend'
import { fakeOrchestration } from '../../src/renderer/src/epic/__mocks__/fakeOrchestration'
import { bundle, epicDetail, folder, runView, savedPlan, ticket } from '../../src/renderer/src/epic/__mocks__/fixtures'
import { NotificationSettings } from '../../src/renderer/src/settings/NotificationSettings'

/**
 * The epic Agent tab's states for `scripts/capture-agent-chat.mjs`: the real `EpicWorkspace` (or a standalone
 * `AgentChat` / `NotificationSettings` / `AgentRolePicker` / New chat `FirstPromptDialog`) over the renderer test fakes, seeded from
 * `agentChatScenario.ts`; the `mail` mount is a standalone Skitarii chat with its mailbox. `?state=`
 * picks the state; the page reaches it with real DOM clicks after mount, then writes `#observations` (data-ready).
 */
declare global {
  interface Window { __errors: string[] }
}

type Mount = 'epic' | 'chat' | 'models' | 'composer' | 'settings' | 'roles' | 'newChat' | 'mail'
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
  /** The `composer` mount's second chat, shown busy beside the idle one. */
  busyChatApi: FakeAgentChat
  /** The `mail` mount's chat mailboxes (`window.dm.chats.mail`). */
  chatMail: FakeChatMail
  /** Whether the epic mount reads `chatMail` through the shell's mail store, for a state that shows unseen mail. */
  epicMail: boolean
  clock: Clock & { advance(ms: number): void }
  chats: ChatRecord[]
  folder: TrackedFolderView
  /** agent-tree: whether the Finished 1 group was expanded when the tree first showed it, before any click. */
  finishedExpandedAtStart: boolean | null
  /** What another screen asked the workspace to open as it mounts (a clicked notification, a ticket's Activity link). */
  landing: EpicLanding | null
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
/** A worker running in a GUI chat of its own, bound to the epic: what a clicked notification lands on. */
const WORKER_DM2 = chatRecord({
  id: 'chat_dm2', folder: FOLDER.path, role: 'worker', epicId: 'ep_1', surface: 'gui', title: 'Acolyte:DM-2', createdAt: '2026-03-01T09:00:00.000Z'
})

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

const loadedImage = (image: Element | null): boolean => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0

/** The image-result transcript: the sent and the returned thumbnail loaded, and the gone file's placeholder in place. */
const imageResultShown = (): boolean => [...document.querySelectorAll('.chat-images img')].filter(loadedImage).length === 2
  && $('.chat-images .attachment-missing') !== null

/** Opens the idle image-result turn, whose Read call is folded behind its `Worked for` row, and waits for its thumbnails. */
async function reachImageResult(): Promise<void> {
  await clickWhenPresent(() => $('.chat-work-toggle'), 'the turn’s Worked for row')
  await until(imageResultShown, 'two loaded thumbnails and the missing image’s placeholder')
}

/** A screenshot-like PNG: a window of the given accent with a title bar and two text lines. */
async function screenshot(accent: string, index: number): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 200
  const paint = canvas.getContext('2d')!
  paint.fillStyle = '#1b1715'
  paint.fillRect(0, 0, 320, 200)
  paint.fillStyle = accent
  paint.fillRect(0, 0, 320, 36)
  paint.fillRect(24, 64, 220, 18)
  paint.fillRect(24, 100, 160, 18)
  const blob = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/png') })
  return new File([blob!], `screenshot-${index + 1}.png`, { type: 'image/png' })
}

/** A real paste of image files, as the clipboard hands them to the focused field. */
function pasteFiles(target: Element, files: File[]): void {
  const data = new DataTransfer()
  for (const file of files) data.items.add(file)
  target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
}

/**
 * Clicks the Agent view button. Below 1100 px the app starts the rail collapsed, so at a narrow viewport the states
 * that show the tree reach it as a person would: one real click on Expand Epic agents.
 */
async function openAgentTab(): Promise<void> {
  await clickWhenPresent(() => $('[role="group"][aria-label="View"] .ew-toggle-agent'), 'the Agent view button')
  await until(() => $('aside[aria-label="Epic agents"]') ?? $('.eap-empty .arp'), 'the Agent stage')
  const expand = buttonNamed('Expand Epic agents')
  if (expand !== null) click(expand)
}

/** Clicks a tree row's own line (not its nested children), which selects the node. */
const selectNode = (name: string): Promise<void> =>
  clickWhenPresent(() => treeItem(name)?.querySelector(':scope > .at-row') ?? null, `the ${name} tree row`)

const chatLoaded = (): Promise<unknown> => until(() => $('.agent-chat .chat-msg-who') ?? $('.agent-chat .chat-thread'), 'the chat transcript')

/** The Magos and Lexmechanic cards, each with its art, are shown inside `scope`. */
const roleCardsShown = (scope: string): boolean =>
  document.querySelectorAll(`${scope} .arp [role="radio"]`).length === 2 && document.querySelectorAll(`${scope} .arp svg[role="img"]`).length === 2

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
 * A busy turn (no `Worked for` fold) with the person's screenshot and a capture from the Acolyte:DM-1 thread, which
 * main bound to DM-1's attempt: the person's image goes to the epic, the capture to DM-1.
 */
function evidenceSnapshot(): AgentChatSnapshot {
  const at = '2026-11-24T08:00:00.000Z'
  const shot = (id: string, width: number, height: number) => [{ id, mime: 'image/png' as const, width, height, bytes: 48_000 }]
  const items: ChatItem[] = [
    { id: 'ask', at, kind: 'user_message', text: 'The banner overlaps the header at this width.', images: shot('ci_01m8e000000000000000000031', 1440, 900) },
    { id: 'spawn-dm1', at, kind: 'tool_call', name: 'Task', input: { description: 'Add retry banner' }, status: 'running', resultSummary: null },
    { id: 'th-dm1', at, kind: 'thread', parentItemId: 'spawn-dm1', label: 'Acolyte:DM-1 Add retry banner', state: 'running',
      callsign: { role: 'Acolyte', ticketKey: 'DM-1', ordinal: null, purpose: 'Add retry banner', ticketVerified: true } },
    { id: 'dm1-shot', at, kind: 'tool_call', threadId: 'th-dm1', name: 'Screenshot', input: { url: 'http://localhost:5173/' }, status: 'completed',
      resultSummary: 'Captured the fixed banner', images: shot('ci_01m8e000000000000000000032', 1280, 800) }
  ]
  return { ...scenarios.tree.snapshot, status: 'busy', items }
}

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

/** The first of two questions in one multi-select ask, docked over the conversation. */
function multiQuestion(): AgentChatSnapshot {
  return {
    ...scenarios.empty.snapshot,
    items: conversation,
    status: 'busy',
    pending: {
      id: 'question-multi-1', kind: 'question', title: 'Which checks should the worker run before it submits?',
      detail: 'Choose every check that applies.', threadId: null,
      attributed: false, callsign: null, arbitration: { state: 'off', reason: null }, multi: true, progress: { index: 1, total: 2 },
      options: [
        { id: 'option_0', label: 'Lint', description: 'ESLint over the changed files' },
        { id: 'option_1', label: 'Typecheck', description: 'Both tsconfig projects' },
        { id: 'option_2', label: 'Unit tests', description: 'Vitest for the touched files' },
        { id: 'option_3', label: 'Build' },
        { id: 'text', label: 'Other' }
      ]
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

/** The agent-transcript state's conversation: the person's question, then a finished reply holding a ts code block. */
function transcriptSnapshot(): AgentChatSnapshot {
  const items: ChatItem[] = [
    { id: 'tr-user', at: AT, kind: 'user_message', text: 'Can you add a retry to the fetch helper and tell me how to test it?' },
    {
      id: 'tr-reply', at: AT, kind: 'assistant_text',
      text: '**Done** — the helper now retries twice before it gives up:\n\n```ts\nexport async function fetchWithRetry(url: string, tries = 3): Promise<Response> {\n'
        + '  for (let attempt = 1; ; attempt++) {\n    try {\n      return await fetch(url)\n    } catch (error) {\n      if (attempt >= tries) throw error\n'
        + '    }\n  }\n}\n```\n\nRun `npm test` to check it.'
    }
  ]
  return { items, status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [] }
}

/** The mail-card state's Magos chat: the person's ask and the reply, with the Lexmechanic exchange between them. */
const MAIL_CHAT = 'fixture-magos'
const after = (seconds: number): string => new Date(Date.parse(AT) + seconds * 1000).toISOString()

function mailSnapshot(): AgentChatSnapshot {
  const items: ChatItem[] = [
    { id: 'mc-user', at: after(0), kind: 'user_message', text: 'Check with the Lexmechanic whether DM-1050 can start.' },
    { id: 'mc-reply', at: after(20), kind: 'assistant_text', text: 'The Lexmechanic confirmed the order; **DM-1050** starts once DM-1049 is accepted.' }
  ]
  return { items, status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [] }
}

/** The agent-worked-for state's two ended turns: three tool calls and a note before each final reply, 28m 51s and 4m 05s long. */
function workedForSnapshot(): AgentChatSnapshot {
  const start = Date.parse(AT)
  const at = (seconds: number): string => new Date(start + seconds * 1_000).toISOString()
  const call = (id: string, seconds: number, name: string, input: Record<string, string>): ChatItem =>
    ({ id, at: at(seconds), kind: 'tool_call', name, input, status: 'completed', resultSummary: 'Done' })
  const items: ChatItem[] = [
    { id: 'wf-ask-1', at: at(0), kind: 'user_message', text: 'Find why the nightly build is slow.' },
    call('wf-grep', 12, 'Grep', { pattern: 'buildStart' }),
    { id: 'wf-note-1', at: at(40), kind: 'assistant_text', text: 'The bundler runs twice; checking its config.' },
    call('wf-read-1', 65, 'Read', { path: 'electron.vite.config.ts' }),
    call('wf-bash-1', 900, 'Bash', { command: 'npm run build -- --profile' }),
    { id: 'wf-reply-1', at: at(1_731), kind: 'assistant_text', text: 'The renderer is bundled twice: `build.watch` stays on in CI. Turning it off halves the build.' },
    { id: 'wf-ask-2', at: at(1_800), kind: 'user_message', text: 'Turn it off and check the build.' },
    call('wf-read-2', 1_810, 'Read', { path: 'electron.vite.config.ts' }),
    { id: 'wf-note-2', at: at(1_830), kind: 'assistant_text', text: 'Removing the watch flag.' },
    call('wf-edit', 1_840, 'Edit', { file_path: 'electron.vite.config.ts' }),
    call('wf-bash-2', 2_000, 'Bash', { command: 'npm run build' }),
    { id: 'wf-reply-2', at: at(2_045), kind: 'assistant_text', text: 'Done — the build now takes 198 s instead of 412 s.' }
  ]
  return { items, status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [] }
}

/** A received card, then the Magos's answer to it as a sent card; the body's markup shows as the text it is. */
function seedMail(mail: FakeChatMail): void {
  const ref = { folder: FOLDER.path, chatId: MAIL_CHAT }
  const lexmechanic = { label: 'Lexmechanic', kind: 'callsign' as const }
  const magos = { label: 'Magos', kind: 'callsign' as const }
  mail.put({ ...ref, unseenCount: 1, pendingCount: 1, retainedCount: 1 })
  mail.setConversation(ref.folder, ref.chatId, [
    mailEntry({
      id: 'mm_plan14', seq: 1, from: lexmechanic, to: magos, acceptedAt: after(5),
      body: 'Plan revision 14 is saved. DM-1050 now depends on DM-1049; start it only after DM-1049 is accepted.\n<b>Not markup</b>: shown as typed.'
    }),
    mailEntry({
      id: 'mm_ack14', direction: 'sent', seq: null, from: magos, to: lexmechanic, acceptedAt: after(12), inReplyTo: 'mm_plan14',
      body: 'Understood. DM-1049 is in review; DM-1050 stays queued until it is accepted.'
    })
  ])
}
const relay = (event: AgentChatEvent): AgentChatEvent => ({ ...event, folder: FOLDER.path, chatId: ORCHESTRATOR.id })

// ---------------------------------------------------------------------------------------------- states

const agentStates: Record<string, StateDef> = {
  'agent-empty': {
    mount: 'epic',
    seed: (context) => { context.chats.length = 0 },
    reach: async () => {
      await openAgentTab()
      await until(() => roleCardsShown('.eap-empty'), 'the epic’s Magos and Lexmechanic cards')
    }
  },
  'epic-agent-picker': {
    mount: 'epic',
    // A saved plan and no run yet: both role cards can start, in place of the old Start planner button.
    seed: (context) => {
      context.chats.length = 0
      context.backend = new FakeBackend(scenario({ saved: planWithTreeTickets(), run: null, checkpoint: null }))
    },
    reach: async () => {
      await openAgentTab()
      await until(() => roleCardsShown('.eap-empty'), 'the epic’s Magos and Lexmechanic cards')
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
    seed: (context) => snapshot(context, scenarios.tool.snapshot),
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
      await until(() => $('[aria-label="Acolyte:DM-2 thread"] form.chat-composer'), 'the worker thread with its relay composer')
    }
  },
  'agent-legacy-thread': {
    mount: 'epic',
    seed: (context) => snapshot(context, scenarios.legacy.snapshot),
    reach: async () => {
      await openAgentTab()
      await until(() => treeItem('Servitor-2') && treeItem('Servitor-3'), 'the legacy parent and its nested legacy helper in the tree')
      await selectNode('Servitor-2')
      await until(() => $('[aria-label="Servitor-2 thread"] [aria-label="Thread: Servitor-3"]'),
        'the nested legacy helper named Servitor-3 in its parent’s thread view')
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
  // Landings never click Expand Epic agents: below 1100 px the rail starts collapsed and the landing itself must show the agent.
  'landing-notification': {
    mount: 'epic',
    seed: (context) => {
      snapshot(context, scenarios.streaming.snapshot)
      context.chats.push(WORKER_DM2)
      context.landing = { kind: 'epicAgent', epicId: 'ep_1', chatId: WORKER_DM2.id }
    },
    reach: async () => {
      await until(() => treeItem('Acolyte:DM-2')?.getAttribute('aria-selected') === 'true', 'the selected Acolyte:DM-2 row')
    }
  },
  'landing-activity': {
    mount: 'epic',
    seed: (context) => {
      snapshot(context, treeSnapshot())
      const chats = new FakeChats()
      chats.bound.attempts.at_202_2 = [{ folder: FOLDER.path, chatId: ORCHESTRATOR.id, threadId: 'th-dm1', role: 'worker' }]
      context.backend.chats = chats
      context.landing = { kind: 'ticket', epicId: 'ep_1', ticketId: 'tk_202', attemptId: 'at_202_2' }
    },
    reach: async () => {
      await clickWhenPresent(() => buttonNamed('Open chat', $('.tp') ?? document), 'the Activity tab’s Open chat link')
      await until(() => $('.tp') === null && treeItem('Acolyte:DM-1')?.getAttribute('aria-selected') === 'true',
        'the selected Acolyte:DM-1 row with the ticket panel closed')
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
  'agent-glass': {
    mount: 'epic',
    seed: (context) => snapshot(context, namedApproval()),
    reach: async () => {
      await openAgentTab()
      await until(() => $('aside.rr.glass[data-collapsed="false"]') && $('.agent-prompt.glass[role="alertdialog"]'), 'the open glass rail and docked approval card')
    }
  },
  'question-multi': {
    mount: 'epic',
    seed: (context) => snapshot(context, multiQuestion()),
    reach: async () => {
      await openAgentTab()
      const card = await until(() => $('.agent-prompt-multi'), 'the docked multi-select question')
      for (const label of ['Lint', 'Unit tests']) {
        click(await until(() => [...card.querySelectorAll('label.agent-prompt-check')]
          .find((row) => text(row.querySelector('.agent-prompt-check-label')) === label)?.querySelector('input') ?? null, `the ${label} checkbox`))
      }
      await until(() => text($('.agent-prompt-count')) === '2 selected', '2 selected')
    }
  },
  'agent-magos-decided': {
    mount: 'epic',
    seed: (context) => snapshot(context, magosDecided()),
    reach: async () => {
      await openAgentTab()
      // The idle chat folds the ended turn: the record shows once its work is opened.
      await clickWhenPresent(() => $('.chat-work-toggle'), 'the turn’s Worked for row')
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
  },
  // The run's Magos selected beside a live Skitarii Lexmechanic with two messages the person has not seen.
  'epic-agent-tabs': {
    mount: 'epic',
    seed: (context) => {
      snapshot(context, { ...scenarios.empty.snapshot, items: conversation })
      context.chats = [{ ...ORCHESTRATOR, agent: 'omp' }, { ...PLANNER, agent: 'omp' }]
      context.chatMail.put({ folder: FOLDER.path, chatId: PLANNER.id, unseenCount: 2, retainedCount: 2 })
      context.epicMail = true
    },
    reach: async () => {
      await openAgentTab()
      await until(() => $('.ats-tab.is-active [aria-label="Magos"]'), 'the selected Magos tab')
      await until(() => $('.ats-tab .ats-unread'), 'the Lexmechanic tab’s unread dot')
      await chatLoaded()
    }
  }
}

async function reachGraph(): Promise<void> {
  await until(() => $('[aria-label="Plan graph"] .react-flow__node'), 'the plan graph')
}

/** The delivery seeds: a plan whose Sprint 1 declares delivery to main, as a draft, a held run and a checkpoint. */
const deliveryStates: Record<string, StateDef> = {
  'delivery-editor': {
    mount: 'epic',
    seed: (context) => { context.backend = new FakeBackend(deliveryScenario('draft')) },
    reach: async () => {
      await clickWhenPresent(() => buttonNamed('View draft'), 'View draft')
      await clickWhenPresent(() => [...document.querySelectorAll<HTMLElement>('[aria-label="Plan graph"] .pg-card')]
        .find((card) => text($('.pg-card-title', card)) === 'Sprint 1 acceptance') ?? null, 'the Sprint 1 acceptance node in the draft graph')
      const section = await until(() => $('[aria-label="Edit ticket DM-199"] section[aria-label="Sprint delivery"]'), 'the acceptance node’s Sprint delivery section')
      section.scrollIntoView({ block: 'center' })
    }
  },
  'delivery-pending': {
    mount: 'epic',
    seed: (context) => { context.backend = new FakeBackend(deliveryScenario('run')) },
    reach: async () => {
      await reachGraph()
      await until(() => $('[aria-label="Run"] [role="group"][aria-label="Sprint delivery"] li.is-failed'), 'the run bar’s Sprint delivery line')
    }
  },
  'delivery-checkpoint': {
    mount: 'epic',
    seed: (context) => { context.backend = new FakeBackend(deliveryScenario('checkpoint')) },
    reach: async () => {
      await clickWhenPresent(() => buttonNamed('Sprint report', $('[aria-label="Run"]') ?? document), 'the run bar’s Sprint report button')
      await until(() => $('[aria-label="Delivery on approval"]'), 'the checkpoint gate’s Delivery on approval note')
      const previous = await until(() => $('section[aria-label="Previous sprint delivery"]:has(li.is-failed)'), 'the report’s Previous sprint delivery checks')
      previous.scrollIntoView({ block: 'nearest' })
    }
  }
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
  'chat-rail-legacy': {
    mount: 'chat',
    seed: (context) => { context.chatApi.snapshotResult = { ok: true, data: scenarios.legacy.snapshot } },
    reach: async () => {
      await clickWhenPresent(() => $('.agent-chat-agents'), 'the Agents button')
      await until(() => treeItem('Servitor-1') && treeItem('Servitor-2'), 'both Servitors in the agent tree')
      await selectNode('Servitor-2')
      await until(() => $('[aria-label="Thread: Servitor-2"]') && $('[aria-label="Thread: Servitor-1"]'), 'both Servitor thread blocks in the transcript')
    }
  },
  'agent-composer': {
    mount: 'composer',
    seed: (context) => {
      const turn: AgentChatSnapshot = { items: conversation, status: 'idle', pending: null, queued: 2, surface: 'gui', todos: [] }
      context.chatApi.snapshotResult = { ok: true, data: turn }
      context.busyChatApi.snapshotResult = { ok: true, data: { ...turn, status: 'busy' } }
    },
    reach: async () => {
      const idle = await until(() => $('[aria-label="Idle Magos"] textarea:not(:disabled)') as HTMLTextAreaElement | null, 'the idle composer')
      // React reads the native value setter's input event exactly as it reads typing.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(idle, 'Run the targeted tests\nthen report the failures')
      idle.dispatchEvent(new Event('input', { bubbles: true }))
      await until(() => buttonNamed('Send', $('[aria-label="Idle Magos"]')!)?.disabled === false
        && buttonNamed('Stop', $('[aria-label="Busy Magos"]')!), 'an enabled Send beside the idle draft and Stop on the busy chat')
    }
  },
  'agent-images': {
    mount: 'chat',
    seed: (context) => {
      context.chatApi.snapshotResult = { ok: true, data: scenarios.images.snapshot }
      context.chatApi.stagedImages = [...(scenarios.images.staged ?? [])]
    },
    reach: async () => {
      const input = await until(() => $('form.chat-composer textarea:not(:disabled)') as HTMLTextAreaElement | null, 'the composer')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, 'Why does the composer wrap in these?')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const shots = await Promise.all(['#d69b4a', '#b51a1f', '#4a8fd6', '#5aa469', '#888888'].map(screenshot))
      pasteFiles(input, shots.slice(0, 4))
      const loaded = (): boolean => [...document.querySelectorAll<HTMLImageElement>('.chat-image-chip > img')]
        .filter((image) => image.complete && image.naturalWidth > 0).length === 4
      await until(() => loaded() && buttonNamed('Send')?.disabled === false, 'four loaded image chips and an enabled Send')
      // A fifth image is refused inline, without staging.
      pasteFiles(input, shots.slice(4))
      await until(() => $('.chat-composer [role="alert"]'), 'the fifth image refused inline')
    }
  },
  // A Skitarii chat on Opus 5.5 · High over the Windows host's catalog, its model chip's menu open upward.
  'model-picker': {
    mount: 'models',
    seed: (context) => {
      context.chatApi.snapshotResult = {
        ok: true, data: { items: conversation, status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [], model: 'anthropic/claude-opus-5-5', thinking: 'high' }
      }
      context.chatApi.modelsResult = { ok: true, data: chatModelOptions(hostCatalog) }
    },
    reach: async () => {
      await until(() => $('.model-picker-label')?.textContent === 'Opus 5.5 · High' ? $('.model-picker-label') : null, 'the chip reading Opus 5.5 · High')
      await clickWhenPresent(() => $('.model-picker-chip') as HTMLButtonElement | null, 'the model chip')
      await until(() => $('.model-picker-menu [role="group"][aria-label="Codex"]') && $('.model-picker-menu [role="group"][aria-label="Effort"]'),
        'the open menu with the Codex group and the Effort control')
    }
  },
  'agent-transcript': {
    mount: 'chat',
    seed: (context) => { context.chatApi.snapshotResult = { ok: true, data: transcriptSnapshot() } },
    reach: async () => {
      const copy = await until(() => buttonNamed('Copy', $('.chat-msg-user') ?? document.createElement('div')), 'the person’s bubble with its Copy')
      await until(() => $('.chat-msg-assistant .chat-msg-actions .copy-button') && $('.chat-msg-assistant .md-code-copy'), 'the reply’s action row and code Copy')
      // Keyboard focus, as Tab would leave it: the bubble's Copy shows without a pointer over it.
      copy.focus()
      await until(() => getComputedStyle($('.chat-msg-user > .chat-msg-actions')!).opacity === '1', 'the bubble’s Copy revealed by focus')
    }
  },
  'agent-worked-for': {
    mount: 'chat',
    seed: (context) => { context.chatApi.snapshotResult = { ok: true, data: workedForSnapshot() } },
    reach: async () => {
      await clickWhenPresent(() => [...document.querySelectorAll<HTMLButtonElement>('.chat-work-toggle')][1] ?? null, 'the second turn’s Worked for row')
      await until(() => document.querySelectorAll('.chat-work-rows [aria-label^="Tool call: "]').length === 3, 'the opened turn’s three tool cards')
    }
  },
  'agent-image-result': {
    mount: 'chat',
    seed: (context) => { context.chatApi.snapshotResult = { ok: true, data: scenarios['image-result'].snapshot } },
    reach: reachImageResult
  },
  'agent-image-viewer': {
    mount: 'chat',
    seed: (context) => { context.chatApi.snapshotResult = { ok: true, data: scenarios['image-result'].snapshot } },
    reach: async () => {
      await reachImageResult()
      await clickWhenPresent(() => buttonNamed('Open Image from agent, 1440x900'), 'the tool image’s thumbnail')
      await until(() => loadedImage($('[role="dialog"] img.attachment-lightbox-image')), 'the lightbox with the full image loaded')
    }
  },
  'agent-image-evidence': {
    mount: 'epic',
    seed: (context) => snapshot(context, evidenceSnapshot()),
    reach: async () => {
      await openAgentTab()
      const toggle = await until(() => $('[aria-label="Thread: Acolyte:DM-1"] button'), 'the Acolyte:DM-1 thread')
      if (toggle.getAttribute('aria-expanded') === 'false') click(toggle)
      await until(() => [...document.querySelectorAll('.chat-images img')].filter(loadedImage).length === 2, 'both thumbnails loaded')
      await clickWhenPresent(() => buttonNamed('Attach Image from agent, 1280x800 as evidence to DM-1'), 'the capture’s Attach as evidence')
      await until(() => $('.ew-toast'), 'the toast confirming the attach')
    }
  },
  'mail-card': {
    mount: 'mail',
    seed: (context) => {
      context.chatApi.snapshotResult = { ok: true, data: mailSnapshot() }
      seedMail(context.chatMail)
    },
    reach: async () => {
      await until(() => document.querySelectorAll('.chat-mail-received').length === 1 && document.querySelectorAll('.chat-mail-sent').length === 1,
        'a received and a sent mail card')
    }
  },
  'settings-notifications': {
    mount: 'settings',
    reach: async () => { await until(() => $('[role="switch"]'), 'the notification settings form') }
  },
  'agent-role-picker': {
    mount: 'roles',
    reach: async () => {
      await until(() => roleCardsShown('.preview-roles'), 'the Magos and Lexmechanic cards with their art')
    }
  },
  'new-chat-picker': {
    mount: 'newChat',
    reach: async () => {
      const field = await until(() => $('[role="dialog"] textarea') as HTMLTextAreaElement | null, 'the New chat dialog’s prompt field')
      await until(() => document.querySelectorAll('.arp svg[role="img"]').length === 2, 'both role cards with their art')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, 'Plan the sign-in refresh repair')
      field.dispatchEvent(new Event('input', { bubbles: true }))
      await until(() => buttonNamed('Start')?.disabled === false, 'an enabled Start')
    }
  },
  ...deliveryStates
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

/**
 * The delivery regions: the acceptance node's Sprint delivery section, the run bar's Sprint delivery line, the
 * checkpoint's Delivery on approval note and Previous sprint delivery section, and the first failed check as
 * "name: detail" (from the previous-sprint section when shown, else from the run bar's line).
 */
function deliveryObservations(): Record<string, unknown> {
  const line = $('[aria-label="Run"] [role="group"][aria-label="Sprint delivery"]')
  const previous = $('section[aria-label="Previous sprint delivery"]')
  const failed = (previous ?? line)?.querySelector('li.is-failed') ?? null
  return {
    sprintDeliveryRegion: $('[aria-label^="Edit ticket"] section[aria-label="Sprint delivery"]') !== null,
    deliveryLine: text(line?.querySelector(':scope > span') ?? null),
    deliveryApproval: text($('[aria-label="Delivery on approval"]')),
    previousDelivery: previous !== null,
    firstFailedCheck: failed === null ? null : `${text(failed.children[1] ?? null)}: ${text(failed.children[2] ?? null)}`
  }
}

/** The docked multi-select question: its legend, progress, checked option labels, count and Submit; null without one. */
function questionObservations(): Record<string, unknown> | null {
  const form = $('.agent-prompt .agent-prompt-multi')
  if (form === null) return null
  const rows = [...form.querySelectorAll<HTMLElement>('label.agent-prompt-check')]
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')
  return {
    legend: text(form.querySelector('legend')),
    progress: text($('.agent-prompt .agent-prompt-progress')),
    checkboxes: rows.length,
    checked: rows.filter((row) => row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked === true)
      .map((row) => text(row.querySelector('.agent-prompt-check-label'))),
    count: text(form.querySelector('.agent-prompt-count')),
    submitEnabled: submit === null ? null : !submit.matches(':disabled')
  }
}

/** The computed glass of the Agent stage: the backdrop's image, and the rail's, docked card's and transcript's surfaces. */
function glassObservations(): Record<string, unknown> | null {
  const stage = $('section.eap')
  if (stage === null) return null
  const surface = (element: HTMLElement | null): { background: string; backdropFilter: string } | null => {
    if (element === null) return null
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, backdropFilter: style.backdropFilter }
  }
  return {
    backdrop: getComputedStyle(stage).backgroundImage,
    rail: surface($('aside.rr')),
    card: surface($('.agent-prompt')),
    transcript: surface($('.agent-chat-scroll'))
  }
}

const ROLE_CARD_TEXTS = '.arc-name, .arc-role, .arc-facts li, .arc-reason'

/**
 * One role card: its radio's name and checked state, its art's label and rendered size, the card's surface, the texts
 * that overflow their boxes, and whether anything is clipped (an overflowing text, or the card leaving the window).
 */
function roleCardObservation(card: HTMLElement): Record<string, unknown> {
  const radio = $('[role="radio"]', card)
  const art = card.querySelector<SVGSVGElement>('svg[role="img"]')
  if (radio === null || art === null) return { name: null, art: null }
  const box = card.getBoundingClientRect()
  const artBox = art.getBoundingClientRect()
  const overflowing = [...card.querySelectorAll<HTMLElement>(ROLE_CARD_TEXTS)]
    .filter((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
    .map((element) => text(element))
  const offscreen = box.left < 0 || box.top < 0 || box.right > window.innerWidth || box.bottom > window.innerHeight
  const style = getComputedStyle(card)
  return {
    name: accessibleName(radio), checked: radio.getAttribute('aria-checked') === 'true', reason: text($('.arc-reason', card)),
    art: art.getAttribute('aria-label'),
    artWidth: artBox.width, artHeight: artBox.height, background: style.backgroundColor, backdropFilter: style.backdropFilter,
    overflowing, clipped: offscreen || overflowing.length > 0
  }
}

/** The role picker's cards in order; null when the page shows none. */
function rolePickerObservations(): Record<string, unknown> | null {
  const cards = [...document.querySelectorAll<HTMLElement>('.arp .arc')]
  return cards.length === 0 ? null : { cards: cards.map(roleCardObservation) }
}

/**
 * The New chat dialog: its accessible name, whether the role picker sits wholly above the First prompt field, and
 * whether the dialog scrolls (which would hide Start below the fold).
 */
function newChatObservations(): Record<string, unknown> | null {
  const dialog = $('[role="dialog"]')
  const picker = dialog?.querySelector<HTMLElement>('.arp') ?? null
  const field = dialog?.querySelector('textarea') ?? null
  if (dialog === null || picker === null || field === null) return null
  return {
    title: accessibleName(dialog), pickerAbovePrompt: picker.getBoundingClientRect().bottom <= field.getBoundingClientRect().top,
    scrolls: dialog.scrollHeight > dialog.clientHeight + 1
  }
}

/**
 * Each shared composer on the page: its glass card, text-area height in lines, chips and Send or Stop button, the
 * attach button leading its row, and its image chips (loaded thumbnails, whether they sit above the text, the alert).
 */
function composerObservations(): Record<string, unknown>[] {
  const shape = (button: HTMLElement | null): Record<string, unknown> | null => {
    if (button === null) return null
    const { width, height } = button.getBoundingClientRect()
    return { radius: getComputedStyle(button).borderTopLeftRadius, width, height }
  }
  return [...document.querySelectorAll<HTMLElement>('form.chat-composer')].map((form) => {
    const style = getComputedStyle(form)
    const input = form.querySelector('textarea')
    const inputStyle = input === null ? null : getComputedStyle(input)
    const lines = input === null || inputStyle === null ? null
      : Math.round((input.getBoundingClientRect().height - parseFloat(inputStyle.paddingTop) - parseFloat(inputStyle.paddingBottom))
        / parseFloat(inputStyle.lineHeight))
    return {
      radius: style.borderTopLeftRadius, background: style.backgroundColor, backdropFilter: style.backdropFilter,
      width: form.getBoundingClientRect().width, lines, placeholder: input?.placeholder ?? null,
      chips: [...form.querySelectorAll('.chat-composer-chip')].map(text),
      send: shape(form.querySelector<HTMLElement>('button[aria-label="Send"]')),
      sendEnabled: form.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled === false,
      stop: shape(form.querySelector<HTMLElement>('button[aria-label="Stop"]')),
      attach: shape(form.querySelector<HTMLElement>('.chat-composer-row > button[aria-label="Attach images"]:first-child')),
      images: imageChipObservations(form, input)
    }
  })
}

function imageChipObservations(form: HTMLElement, input: HTMLTextAreaElement | null): Record<string, unknown> {
  const list = form.querySelector<HTMLElement>('ul[aria-label="Attached images"]')
  const thumbnails = [...form.querySelectorAll<HTMLImageElement>('.chat-image-chip > img')]
  return {
    chips: thumbnails.length,
    loaded: thumbnails.filter((image) => image.complete && image.naturalWidth > 0).length,
    removable: form.querySelectorAll('.chat-image-chip > button[aria-label^="Remove image"]').length,
    aboveText: list !== null && input !== null && list.getBoundingClientRect().bottom <= input.getBoundingClientRect().top,
    alert: text(form.querySelector('[role="alert"]'))
  }
}

/** The agent-transcript state's layout: the reading column, the person's bubble, the plain reply and the Copy buttons. */
function transcriptObservations(): Record<string, unknown> | null {
  const rows = $('.chat-rows')
  const bubble = $('.chat-msg-user > article')
  const reply = $('.chat-msg-assistant > article')
  const block = $('.chat-msg-assistant .md-code-block')
  if (rows === null || bubble === null || reply === null || block === null) return null
  const column = rows.getBoundingClientRect()
  const holder = rows.parentElement!.getBoundingClientRect()
  const bubbleBox = bubble.getBoundingClientRect()
  const replyStyle = getComputedStyle(reply)
  const visible = (button: HTMLElement | null): string | null => {
    if (button === null) return null
    let element: HTMLElement | null = button
    for (; element !== null; element = element.parentElement) if (getComputedStyle(element).opacity === '0') return null
    return text(button)
  }
  const codeCopy = $('.md-code-copy', block)
  const codeBox = block.getBoundingClientRect()
  const copyBox = codeCopy?.getBoundingClientRect() ?? null
  return {
    columnWidth: column.width,
    columnOffset: Math.abs((column.left - holder.left) - (holder.right - column.right)),
    bubble: {
      radius: getComputedStyle(bubble).borderTopLeftRadius, background: getComputedStyle(bubble).backgroundColor,
      rightGap: column.right - bubbleBox.right, leftGap: bubbleBox.left - column.left
    },
    bubbleCopy: visible($('.chat-msg-user .copy-button')),
    bubbleCopyFocused: document.activeElement === $('.chat-msg-user .copy-button'),
    reply: { background: replyStyle.backgroundColor, border: replyStyle.borderTopWidth, width: reply.getBoundingClientRect().width },
    replyActions: [...document.querySelectorAll<HTMLElement>('.chat-msg-assistant > .chat-msg-actions .copy-button')].map(visible),
    codeCopy: visible(codeCopy),
    codeCopyCorner: copyBox === null ? null : { top: copyBox.top - codeBox.top, right: codeBox.right - copyBox.right }
  }
}

/** Whether the active tab meets the chat header on the header's own surface, with rounded top corners only. */
function activeTabJoined(active: HTMLElement | null): { activeJoined: boolean; roundedTop: boolean } {
  const header = $('.eap-centre .agent-chat-header')
  if (active === null || header === null) return { activeJoined: false, roundedTop: false }
  const style = getComputedStyle(active)
  return {
    activeJoined: style.backgroundColor === getComputedStyle(header).backgroundColor
      && Math.abs(active.getBoundingClientRect().bottom - header.getBoundingClientRect().top) <= 1,
    roundedTop: style.borderTopLeftRadius === '8px' && style.borderTopRightRadius === '8px' && style.borderBottomLeftRadius === '0px'
  }
}

/**
 * The epic-agent-tabs strip: each tab's accessible name, selection, unread dot and ✕; whether the strip sits above the
 * chat; and whether the active tab joins the chat header.
 */
function agentTabsObservations(): Record<string, unknown> | null {
  const list = $('[role="tablist"][aria-label="Agent tabs"]')
  if (list === null) return null
  const chat = $('.eap-centre .agent-chat')
  return {
    tabs: [...list.querySelectorAll<HTMLElement>('.ats-tab')].map((tab) => ({
      name: $('[role="tab"]', tab)?.getAttribute('aria-label') ?? null,
      selected: $('[role="tab"]', tab)?.getAttribute('aria-selected') === 'true',
      unread: $('.ats-unread', tab) !== null,
      closable: $('.ats-close', tab) !== null
    })),
    aboveChat: chat !== null && list.getBoundingClientRect().bottom <= chat.getBoundingClientRect().top + 1,
    ...activeTabJoined($('.ats-tab.is-active', list))
  }
}

/** The mail-card state's transcript: rows in order (mail or item) and each card's head, body and whether markup rendered. */
function mailObservations(mail: FakeChatMail | null): Record<string, unknown> | null {
  const cards = [...document.querySelectorAll<HTMLElement>('.chat-mail')]
  if (cards.length === 0) return null
  return {
    rows: [...document.querySelectorAll<HTMLElement>('.chat-rows > li')].map((row) => row.classList.contains('chat-mail') ? 'mail' : 'item'),
    cards: cards.map((card) => ({
      direction: card.classList.contains('chat-mail-sent') ? 'sent' : 'received',
      head: text($('.chat-mail-head', card)),
      reply: text($('.chat-mail-reply', card)),
      body: $('.chat-mail-body', card)?.textContent ?? null,
      markup: $('.chat-mail-body *', card) !== null
    })),
    seen: mail?.calls.filter((call) => call.method === 'markSeen').map((call) => call.args) ?? null
  }
}

/** The agent-worked-for state: each turn's disclosure and whether it is open, what follows a folded one, and the tool cards shown. */
function workedForObservations(): Record<string, unknown> | null {
  const toggles = [...document.querySelectorAll<HTMLButtonElement>('.chat-work-toggle')]
  if (toggles.length === 0) return null
  const tools = (root: ParentNode): string[] => [...root.querySelectorAll('[aria-label^="Tool call: "]')].map((row) => row.getAttribute('aria-label') ?? '')
  const folded = toggles.find((toggle) => toggle.getAttribute('aria-expanded') === 'false')?.closest('li')
  const opened = $('.chat-work-rows')
  return {
    toggles: toggles.map((toggle) => [(toggle.textContent ?? '').replace('›', '').trim(), toggle.getAttribute('aria-expanded') === 'true']),
    afterFolded: folded?.nextElementSibling?.querySelector('article')?.getAttribute('aria-label') ?? null,
    openedTools: opened === null ? [] : tools(opened),
    toolsOutside: tools(document).length - (opened === null ? 0 : tools(opened).length)
  }
}

/**
 * The transcript's image thumbnails in document order (whose they are, name, scheme, lazy, loaded, box width) and the
 * open lightbox, or null when the transcript shows none.
 */
function chatImageObservations(): Record<string, unknown> | null {
  const pictures = [...document.querySelectorAll<HTMLElement>('.chat-images .chat-image-picture')]
  if (pictures.length === 0) return null
  const dialog = $('[role="dialog"].attachment-lightbox')
  const full = dialog === null ? null : $('img.attachment-lightbox-image', dialog)
  return {
    thumbs: pictures.map((picture) => ({
      under: picture.closest('.chat-msg-user') !== null ? 'you' : picture.closest('.chat-tool') !== null ? 'tool' : null,
      name: picture instanceof HTMLImageElement ? picture.alt : picture.getAttribute('aria-label'),
      scheme: picture instanceof HTMLImageElement ? new URL(picture.src).protocol : null,
      lazy: picture instanceof HTMLImageElement && picture.loading === 'lazy',
      loaded: loadedImage(picture),
      width: picture.closest('.chat-image-thumb')?.getBoundingClientRect().width ?? null
    })),
    // Attach as evidence, by each button's accessible name: inside an epic only.
    evidence: [...document.querySelectorAll<HTMLElement>('.chat-image-evidence')].map((button) => button.getAttribute('aria-label')),
    viewer: dialog === null ? null : {
      name: dialog.getAttribute('aria-label'),
      scheme: full instanceof HTMLImageElement ? new URL(full.src).protocol : null,
      loaded: loadedImage(full),
      closeFocused: document.activeElement === buttonNamed('Close', dialog)
    }
  }
}

/** The epic workspace's toast and the Attach as evidence requests that reached the fake main. */
function evidenceObservations(context: Seeded | null): Record<string, unknown> {
  return { toast: text($('.ew-toast span')), requests: context === null ? [] : context.backend.agentChat.callsOf('attachEvidence') }
}

const menuRadios = (root: ParentNode): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]

/** Where the model menu sits: the chip just before Send, the menu above it and inside the window. */
function modelMenuPlacement(chip: HTMLElement, menu: HTMLElement): Record<string, unknown> {
  const row = chip.closest('.chat-composer-row')
  const send = row === null ? null : buttonNamed('Send', row)
  const box = menu.getBoundingClientRect()
  return {
    beforeSend: send !== null && chip.closest('.model-picker')?.nextElementSibling === send,
    upward: box.bottom <= chip.getBoundingClientRect().top,
    inWindow: box.top >= 0 && box.left >= 0 && box.right <= window.innerWidth
  }
}

/** What the open model menu lists: its provider groups, the checked model, More models and the Effort control. */
function modelMenuContents(menu: HTMLElement): Record<string, unknown> {
  const more = $('.model-picker-more', menu)
  const style = getComputedStyle(menu)
  return {
    groups: [...menu.querySelectorAll<HTMLElement>('.model-picker-list [role="group"]')].map((group) => ({
      label: group.getAttribute('aria-label'), models: menuRadios(group).map((item) => text($('.model-picker-name', item)))
    })),
    checked: menuRadios(menu).filter((item) => item.hasAttribute('data-model') && item.getAttribute('aria-checked') === 'true')
      .map((item) => text($('.model-picker-name', item))),
    more: more === null ? null : { name: text(more), expanded: more.getAttribute('aria-expanded') },
    efforts: menuRadios($('[role="group"][aria-label="Effort"]', menu) ?? document.createElement('div'))
      .map((item) => ({ label: text(item), checked: item.getAttribute('aria-checked') === 'true' })),
    surface: { background: style.backgroundColor, backdropFilter: style.backdropFilter }
  }
}

/** The model-picker state's chip and its open menu; null on a page without both. */
function modelPickerObservations(): Record<string, unknown> | null {
  const chip = $('.model-picker-chip')
  const menu = $('.model-picker-menu')
  if (chip === null || menu === null) return null
  return { chip: text($('.model-picker-label', chip)), ...modelMenuPlacement(chip, menu), ...modelMenuContents(menu) }
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
    questionCard: questionObservations(),
    approvalRecord: text($('.chat-approval-card')),
    glass: glassObservations(),
    rolePicker: rolePickerObservations(),
    newChat: newChatObservations(),
    needsYouHeader: text($('.at-header')),
    badgedRows: document.querySelectorAll('button.at-needs').length,
    ticketPanel: $('.tp') !== null,
    settingsControls: [...document.querySelectorAll<HTMLElement>('.preview-settings :is(input, textarea, select, button)')].map(accessibleName),
    agentsPressed: $('.agent-chat-agents')?.getAttribute('aria-pressed') ?? null,
    composers: composerObservations(),
    transcript: transcriptObservations(),
    mail: mailObservations(context?.chatMail ?? null),
    agentTabs: agentTabsObservations(),
    workedFor: workedForObservations(),
    chatImages: chatImageObservations(),
    evidence: evidenceObservations(context),
    modelPicker: modelPickerObservations(),
    ...deliveryObservations(),
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

/** The shell's mail store over the seeded mailboxes, tracking the preview's folder. */
function epicMailStore(context: Seeded): AgentMailStore {
  context.backend.chats.mail = context.chatMail
  const store = createAgentMailStore(context.chatMail)
  store.track([FOLDER.path])
  return store
}

function seeded(): Seeded {
  const backend = new FakeBackend(scenario({ saved: planWithTreeTickets(), run: RUN }))
  const chatApi = new FakeAgentChat()
  return {
    backend, chatApi, busyChatApi: new FakeAgentChat(), chatMail: new FakeChatMail(), epicMail: false,
    clock: createManualClock(agentChatScenarioClockStart), chats: [ORCHESTRATOR],
    folder: FOLDER, finishedExpandedAtStart: null, landing: null
  }
}

/** The standalone Magos chat over its mailbox, under the shell's mail store. */
function mailChat(context: Seeded): JSX.Element {
  const dm = new FakeDm()
  dm.agentChat = context.chatApi
  dm.chats.mail = context.chatMail
  window.dm = dm
  const store = createAgentMailStore(context.chatMail)
  store.track([FOLDER.path])
  return <ClockContext.Provider value={context.clock}><AgentMailContext.Provider value={store}><div className="preview-chat">
    <AgentChat folder={FOLDER.path} chatId={MAIL_CHAT} agentLabel="Magos" agentChip="Magos · Skitarii" context="dark-mechanicus" api={context.chatApi} />
  </div></AgentMailContext.Provider></ClockContext.Provider>
}

function render(mount: Mount, context: Seeded): JSX.Element {
  if (mount === 'roles') {
    return <div className="preview-roles"><AgentRolePicker onChoose={() => undefined} /></div>
  }
  if (mount === 'newChat') {
    return <div className="preview-roles"><FirstPromptDialog roles onSubmit={async () => false} onClose={() => undefined} /></div>
  }
  if (mount === 'settings') {
    window.dm = new FakeDm()
    return <ToastProvider scheduler={browserScheduler}><div className="preview-settings"><NotificationSettings /></div></ToastProvider>
  }
  const clock: Clock = context.clock
  if (mount === 'chat' || mount === 'models') {
    const dm = new FakeDm()
    dm.agentChat = context.chatApi
    window.dm = dm
    return <ClockContext.Provider value={clock}><div className="preview-chat">
      <AgentChat folder={null} chatId="fixture-chat" agentLabel="Magos" agentChip="Magos · Skitarii" context="dark-mechanicus"
        api={context.chatApi} rail="toggle" chat={{ role: 'orchestrator', runId: 'rn_fixture' }} skitarii={mount === 'models'} />
    </div></ClockContext.Provider>
  }
  if (mount === 'mail') return mailChat(context)
  if (mount === 'composer') {
    const dm = new FakeDm()
    dm.agentChat = context.chatApi
    window.dm = dm
    const pane = (label: string, chatId: string, api: FakeAgentChat): JSX.Element => <div className="preview-chat" aria-label={label}>
      <AgentChat folder={null} chatId={chatId} agentLabel="Magos" agentChip="Magos · Skitarii" context="dark-mechanicus" api={api} />
    </div>
    return <ClockContext.Provider value={clock}><div className="preview-composer">
      {pane('Idle Magos', 'fixture-chat', context.chatApi)}
      {pane('Busy Magos', 'fixture-busy-chat', context.busyChatApi)}
    </div></ClockContext.Provider>
  }
  window.dm = context.backend
  return <ClockContext.Provider value={clock}><ViewMemoryContext.Provider value={createViewMemory()}>
    <AgentMailContext.Provider value={context.epicMail ? epicMailStore(context) : null}><div className="preview-epic-agent">
      <EpicWorkspace folder={context.folder} epicId="ep_1" refreshToken={0} onChanged={() => undefined} onOpenEpic={() => undefined}
        onDeleted={() => undefined} orchestration={fakeOrchestration({ chats: context.chats })}
        landing={context.landing} onLanded={() => undefined} />
    </div></AgentMailContext.Provider>
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
