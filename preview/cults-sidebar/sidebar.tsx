import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/jitlessZod'
import '../../src/renderer/src/styles.css'
import './preview.css'
import { FakeCults, cultView, memberDetail, runDetail } from '../../src/renderer/src/__mocks__/fakeCults'
import { FakeDm } from '../../src/renderer/src/__mocks__/fakeDm'
import { FakeExpansion } from '../../src/renderer/src/__mocks__/fakeExpansion'
import { agentView, epicSummary, folderView } from '../../src/renderer/src/__mocks__/fixtures'
import { Sidebar } from '../../src/renderer/src/sidebar/Sidebar'
import type { CultRunDetail } from '../../src/shared/cults/cultApi'

/**
 * The CULTS sidebar section and the Found-a-cult dialog over the renderer fakes, for screenshots. `?state=` picks the
 * state; the page reaches it with real DOM clicks after mount, then sets `data-ready` on `#root`.
 */
const params = new URLSearchParams(window.location.search)
const state = params.get('state') ?? 'empty'
const alpha = folderView({ path: '/home/u/code/alpha', name: 'alpha', displayPath: '~/code/alpha' })
const beta = folderView({ path: '/home/u/code/beta', name: 'beta', displayPath: '~/code/beta' })
const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()

function runningRun(): CultRunDetail {
  const at = minutesAgo(12)
  const detail = runDetail({ runningSince: at, startedAt: at, timeLimitMs: 90 * 60_000 }, [
    memberDetail({ joinedAt: at }),
    memberDetail({ chatId: 'a1', role: 'acolyte', displayName: 'Acolyte Ferrum-3', model: 'anthropic/claude-sonnet', tier: 'normal', tierReason: 'Needs deeper layout reasoning.', slotId: 'ui_ux', workerType: 'ui_ux', typeOrigin: 'definition_slot' }),
    memberDetail({ chatId: 'a2', role: 'acolyte', displayName: 'Acolyte Cogitas-3', model: 'anthropic/claude-haiku', tier: 'low', slotId: 'quality', workerType: 'quality', typeOrigin: 'definition_slot' }),
    memberDetail({ chatId: 'a3', role: 'acolyte', displayName: 'Acolyte Vox-4', model: 'openai/gpt-5', tier: 'high', tierReason: 'Security review of the IPC boundary.', slotId: 'security', workerType: 'security', typeOrigin: 'definition_slot' }),
    memberDetail({ chatId: 'a4', role: 'acolyte', displayName: 'Acolyte Aurum-3', model: 'anthropic/claude-haiku', tier: 'low', runWorkerTypeId: 'dyn_1', typeOrigin: 'magos_created' })
  ])
  const working = new Set(['a1', 'a3'])
  return {
    ...detail,
    members: detail.members.map((member) => ({ ...member, activity: working.has(member.chatId) ? { working: true, tool: null, at } : null })),
    workerTypes: [{ id: 'dyn_1', displayName: 'Lore keeper', description: 'd', mission: 'm', rationale: 'r', requiredForConclusion: false, creatorMemberId: 'chat_magos', createdAt: at, updatedAt: at, retiredAt: null, origin: 'magos_created', state: 'active', assignedChatIds: ['a4'], reportCount: 0 }]
  }
}

function seed(dm: FakeDm, cults: FakeCults): void {
  dm.responses.listEpics = [epicSummary({ id: 'ep_1', title: 'Gerry Shrine plan' }), epicSummary({ id: 'ep_2', title: 'Sidebar rework' })]
  if (state === 'empty' || state.startsWith('dialog')) return
  cults.cults = [
    cultView({ name: 'Shrine Builders', archetype: 'research_creative' }),
    cultView({ id: 'cult_2', name: 'Plan Council', archetype: 'plan_forge', targetEpicId: 'ep_1' })
  ]
  if (state === 'running') {
    cults.runsByCult = {
      cult_1: [runningRun(), runDetail({ id: 'run_0', state: 'ended', endReason: 'expired', startedAt: '2026-11-26T09:00:00.000Z', runningSince: null })]
    }
  }
  if (state === 'signedout') cults.modelsView = { options: [], reason: 'OMP is signed out. Sign in to OMP to choose a model.' }
}

const click = (element: Element | null | undefined): void => (element as HTMLElement | null)?.click()
const byLabel = (label: string): Element | null => document.querySelector(`[aria-label="${label}"]`)
// The preview's ES2022 lib predates Promise.withResolvers, so the executor form stays here.
function tick(ms = 150): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Opens the running cult's row and its past runs. */
async function openRunning(): Promise<void> {
  click(byLabel('Runs of Shrine Builders'))
  await tick()
  click(Array.from(document.querySelectorAll('.cult-past-toggle')).at(0))
}

/** Opens the Found a cult dialog and brings the state's part of it into view. */
async function openDialog(): Promise<void> {
  click(byLabel('Found a cult'))
  await tick(300)
  if (state === 'dialog-advanced') {
    click(document.querySelector('.cult-advanced > summary'))
    await tick()
    document.querySelector('.cult-advanced')?.scrollIntoView({ block: 'end' })
  }
  if (state === 'signedout') document.querySelector('.cult-model-line')?.scrollIntoView({ block: 'center' })
  if (state.startsWith('dialog-planforge')) await choosePlanForge()
}

async function choosePlanForge(): Promise<void> {
  click(document.querySelector('input[value="plan_forge"]'))
  await tick(300)
  if (state === 'dialog-planforge-target') document.querySelector('.cult-roster ~ .field select')?.closest('.field')?.scrollIntoView({ block: 'center' })
}

/** Real DOM clicks to reach the state. */
async function drive(): Promise<void> {
  await tick(300)
  if (state === 'running') await openRunning()
  if (state.startsWith('dialog') || state === 'signedout') await openDialog()
  await document.fonts.ready
  await tick()
  document.getElementById('root')?.setAttribute('data-ready', state)
}

const dm = new FakeDm()
const cults = new FakeCults()
dm.cults = cults
dm.folders = [alpha, beta]
window.dm = dm
seed(dm, cults)

const noop = (): void => undefined
createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="app-shell">
    <Sidebar version="0.87.0" folders={[alpha, beta]} lists={{ [alpha.path]: { status: 'ready', epics: [], error: null }, [beta.path]: { status: 'ready', epics: [], error: null } }}
      selection={{ folderPath: alpha.path, epicId: null }} agents={[agentView({ kind: 'claude' }), agentView({ kind: 'codex', version: '0.9.1' })]}
      agentStatuses={{}} expansion={new FakeExpansion({ collapsedFolders: [alpha.path, beta.path] })} footer={null}
      chats={{ lists: {}, onNew: noop, onOpen: noop, onRename: async () => true, onDelete: async () => true }}
      agentChats={{ list: { status: 'ready', chats: [] }, onOpen: noop, onRename: async () => true, onDelete: async () => true, onSummon: noop }}
      onTrack={noop} onClone={noop} onAddAgent={noop} onSelectAgent={noop} onSelectCult={noop} onOpenCultMember={noop} onAgentStatus={noop}
      onSelectFolder={noop} onSelectEpic={noop} kanbanCounts={{}} onSelectKanban={noop} onRequestUntrack={noop} />
    <main className="app-main" />
  </div>
)
void drive()
