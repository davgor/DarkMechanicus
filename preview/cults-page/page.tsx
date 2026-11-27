import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/jitlessZod'
import '../../src/renderer/src/styles.css'
import './preview.css'
import { xtermKit } from '../../src/renderer/src/agents/xtermKit'
import { browserScheduler } from '../../src/renderer/src/app/scheduler'
import { CultPage } from '../../src/renderer/src/cults/CultPage'
import { FakeCults, cultView, memberDetail, runDetail } from '../../src/renderer/src/__mocks__/fakeCults'
import { FakeDm } from '../../src/renderer/src/__mocks__/fakeDm'
import { FakeExpansion } from '../../src/renderer/src/__mocks__/fakeExpansion'
import { FakeTerminals } from '../../src/renderer/src/__mocks__/fakeTerminals'
import { agentView, chatRecord, folderView } from '../../src/renderer/src/__mocks__/fixtures'
import { Sidebar } from '../../src/renderer/src/sidebar/Sidebar'
import type { CultMemberDetail, CultRunDetail } from '../../src/shared/cults/cultApi'
import type { CultPetitionView } from '../../src/shared/cults/cult'

/**
 * The Cult page over the renderer fakes, with the real sidebar, chamber and xterm, for screenshots. `?state=` picks the
 * state; the page reaches it with real DOM clicks after mount, then sets `data-ready` on `#root`. The `shrine-*` states
 * show the run's Shrine in the viewscreen (DM-632): its content loads from `dm-shrine:`, which only a host serving that
 * scheme (an Electron capture over `src/main/cults/shrineProtocol.ts`) answers.
 */
const params = new URLSearchParams(window.location.search)
const state = params.get('state') ?? 'idle'
const WORK = '/home/u/code/alpha'
const alpha = folderView({ path: WORK, name: 'alpha', displayPath: '~/code/alpha' })
const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()

const ACOLYTES: [string, string, string, string | null, string | null][] = [
  ['Acolyte Ferrum-3', 'anthropic/claude-sonnet', 'normal', 'Needs deeper layout reasoning.', 'ui_ux'],
  ['Acolyte Cogitas-3', 'anthropic/claude-haiku', 'low', null, 'quality'],
  ['Acolyte Vox-4', 'openai/gpt-5', 'high', 'Security review of the IPC boundary.', 'security'],
  ['Acolyte Aurum-3', 'anthropic/claude-haiku', 'low', null, null]
]

function members(at: string): CultMemberDetail[] {
  const acolytes = ACOLYTES.map(([displayName, model, tier, tierReason, slot], index) => memberDetail({
    chatId: `a${index + 1}`, role: 'acolyte', displayName, model, tier, tierReason, joinedAt: new Date(Date.parse(at) + (index + 1) * 60_000).toISOString(),
    slotId: slot, workerType: slot as CultMemberDetail['workerType'], typeOrigin: slot === null ? 'magos_created' : 'definition_slot',
    runWorkerTypeId: slot === null ? 'dyn_1' : null, reported: index === 1
  }))
  const activity = (index: number): CultMemberDetail['activity'] => index === 0
    ? { working: true, tool: { name: 'edit', target: 'cults/CultPage.tsx' }, at }
    : index === 2 ? { working: true, tool: { name: 'bash', target: 'npm run typecheck' }, at } : { working: false, tool: { name: 'read', target: 'docs/design/cults.md' }, at }
  return [memberDetail({ joinedAt: at, activity: { working: false, tool: null, at } }), ...acolytes.map((member, index) => ({ ...member, activity: activity(index) }))]
}

function petition(patch: Partial<CultPetitionView>): CultPetitionView {
  return { id: 'pt', runId: 'run_1', kind: 'acolytes', additional: null, folderPath: null, reason: '', state: 'pending', granted: null, createdAt: minutesAgo(3), decidedAt: null, ...patch }
}

/** The published Shrine each `shrine-*` state shows; null for the empty viewscreen. */
function shrineOf(): CultRunDetail['shrine'] {
  const base = { publishedBy: 'Acolyte Ferrum-3', updatedAt: minutesAgo(1) }
  if (state === 'shrine-image') return { ...base, path: `${WORK}/gerry/gerry.png`, kind: 'image', revision: '4' }
  if (state === 'shrine-html' || state === 'shrine-enlarged') return { ...base, path: `${WORK}/gerry/index.html`, kind: 'html', revision: '7' }
  return null
}

function activeRun(): CultRunDetail {
  const at = minutesAgo(12)
  const paused = state === 'paused'
  const detail = runDetail({
    state: paused ? 'paused' : 'running', startedAt: at, runningSince: paused ? null : at, accumulatedRunningMs: paused ? 9 * 60_000 + 25_000 : 0,
    timeLimitMs: 90 * 60_000, workDir: WORK
  }, members(at))
  const petitions = state === 'petitions' ? [
    petition({ id: 'pt_a', kind: 'acolytes', additional: 3, reason: 'The schema review needs two more reviewers to finish before the window closes.', createdAt: minutesAgo(5) }),
    petition({ id: 'pt_f', kind: 'folder_access', folderPath: '/home/u/code/beta', reason: 'Read the shared IPC schema in beta.', createdAt: minutesAgo(4) }),
    petition({ id: 'pt_s', kind: 'allow_save', reason: 'Save the drafted shrine plan to the board.', createdAt: minutesAgo(2) })
  ] : []
  return {
    ...detail, petitions, shrine: shrineOf(),
    workerTypes: [{ id: 'dyn_1', displayName: 'Lore keeper', description: 'd', mission: 'm', rationale: 'Keeps the chronicle of decisions.', requiredForConclusion: false, creatorMemberId: 'chat_magos', createdAt: at, updatedAt: at, retiredAt: null, origin: 'magos_created', state: 'active', assignedChatIds: ['a4'], reportCount: 0 }]
  }
}

const CHRONICLE = 'Day 1: the council met. <script>alert("x")</script> <b>Not bold</b> **not markdown**\nThe shrine plan was drafted; Vox raised two IPC risks and Ferrum fixed the layout.'

function pastRuns(): CultRunDetail[] {
  return [
    runDetail({ id: 'run_0', state: 'ended', endReason: 'completed', startedAt: '2026-11-26T09:00:00.000Z', endedAt: '2026-11-26T10:32:15.000Z', runningSince: null, chronicle: CHRONICLE }),
    runDetail({ id: 'run_m', state: 'ended', endReason: 'killed', startedAt: '2026-11-25T14:00:00.000Z', endedAt: '2026-11-25T14:03:40.000Z', runningSince: null })
  ]
}

const SCREEN = (name: string): string => [
  `\x1b[1;38;5;179m${name}\x1b[0m  \x1b[2m· omp · cult member\x1b[0m`, '',
  '\x1b[38;5;108m●\x1b[0m Reading docs/design/cults.md (section 6)',
  '\x1b[38;5;108m●\x1b[0m edit src/renderer/src/cults/CultPage.tsx',
  '  \x1b[32m+ <RosterStrip run={run} roster={roster} … />\x1b[0m',
  '\x1b[38;5;108m●\x1b[0m bash npm run typecheck', '  \x1b[2mtsc --noEmit -p tsconfig.web.json\x1b[0m', '  \x1b[32m✓ no errors\x1b[0m', '',
  '\x1b[38;5;179m❯\x1b[0m '
].join('\r\n')

const dm = new FakeDm()
const cults = new FakeCults()
const terminals = new FakeTerminals()
dm.cults = cults
dm.terminals = terminals
dm.folders = [alpha]
window.dm = dm
cults.cults = [cultView({ name: 'Shrine Builders', archetype: 'research_creative', charter: 'Build the Gerry Shrine: a plan, its tickets and the review of each, before the window closes.' })]
cults.runsByCult = { cult_1: state === 'idle' ? pastRuns() : [activeRun(), ...pastRuns()] }
const names = ['Magos Vettius', ...ACOLYTES.map(([name]) => name)]
dm.chats.chats = ['chat_magos', 'a1', 'a2', 'a3', 'a4'].map((id, index) => chatRecord({ id, folder: WORK, agent: 'omp', role: index === 0 ? 'orchestrator' : 'worker', title: names[index], cultRunId: 'run_1', cultRole: index === 0 ? 'magos' : 'acolyte' }))
for (const [index, id] of ['chat_magos', 'a1', 'a2', 'a3', 'a4'].entries()) terminals.screens[id] = SCREEN(names[index])

const click = (element: Element | null | undefined): void => (element as HTMLElement | null)?.click()
const byLabel = (label: string): Element | null => document.querySelector(`[aria-label="${label}"]`)
const buttonNamed = (text: string): Element | undefined => [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === text)
// The preview's ES2022 lib predates Promise.withResolvers, so the executor form stays here.
function tick(ms = 200): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Real DOM clicks to reach the state. */
async function drive(): Promise<void> {
  await tick(600)
  click(byLabel('Runs of Shrine Builders'))
  if (state === 'idle') click(document.querySelector('.cult-overrides > summary'))
  if (state === 'inspector' || state === 'watch') {
    click(document.querySelector('.cult-chip[data-member-id="a1"]'))
    await tick()
  }
  if (state === 'watch') {
    click(buttonNamed('Watch terminal'))
    await tick(500)
    click(byLabel('Close inspector'))
  }
  if (state === 'past') click(buttonNamed('Past runs'))
  if (state === 'shrine-enlarged') click(document.querySelector('.cc-viewscreen-window .shrine-enlarge'))
  await document.fonts.ready
  // The chamber's join beams fade before the capture.
  await tick(4000)
  document.getElementById('root')?.setAttribute('data-ready', state)
}

const noop = (): void => undefined
createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="app-shell">
    <Sidebar version="0.87.0" folders={[alpha]} lists={{ [alpha.path]: { status: 'ready', epics: [], error: null } }}
      selection={{ folderPath: alpha.path, epicId: null, agentPane: { kind: 'cult', cultId: 'cult_1' } }} agents={[agentView({ kind: 'omp' })]}
      agentStatuses={{}} expansion={new FakeExpansion({ collapsedFolders: [alpha.path] })} footer={null}
      chats={{ lists: {}, onNew: noop, onOpen: noop, onRename: async () => true, onDelete: async () => true }}
      agentChats={{ list: { status: 'ready', chats: [] }, onOpen: noop, onRename: async () => true, onDelete: async () => true, onSummon: noop }}
      onTrack={noop} onClone={noop} onAddAgent={noop} onSelectAgent={noop} onSelectCult={noop} onOpenCultMember={noop} onAgentStatus={noop}
      onSelectFolder={noop} onSelectEpic={noop} kanbanCounts={{}} onSelectKanban={noop} onRequestUntrack={noop} />
    <main className="app-main" aria-label="Workspace">
      <CultPage cultId="cult_1" agentName="OMP" kit={xtermKit} scheduler={browserScheduler} />
    </main>
  </div>
)
void drive()
