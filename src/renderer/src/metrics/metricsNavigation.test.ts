import { describe, expect, it } from 'vitest'
import type { AgentId } from '../../../shared/desktop/api'
import { folderView } from '../__mocks__/fixtures'
import { chooseView } from '../app/chooseView'
import type { Landing } from '../app/landing'
import { resolveSelection, type Selection } from '../app/selection'
import { createShellActions, type ShellActions } from '../app/shellActions'
import { landingActions } from '../epic/landingActions'
import type { WorkspaceData } from '../epic/workspaceState'

const PATH = '/code/alpha'
const folder = folderView({ path: PATH })

interface Shell {
  actions: ShellActions
  selections: Selection[]
  landings: (Landing | null)[]
}

function shell(): Shell {
  const selections: Selection[] = []
  const landings: (Landing | null)[] = []
  const actions = createShellActions({
    toasts: { push: () => undefined, reportError: () => undefined },
    folders: { pick: () => Promise.reject(new Error('unused')), untrack: () => Promise.resolve(), reload: () => Promise.resolve() },
    select: (selection) => selections.push(selection),
    land: (landing) => landings.push(landing),
    reveal: () => undefined,
    revealAgents: () => undefined,
    chats: { create: () => Promise.resolve(null) },
    bucketOf: () => null,
    refresh: () => undefined,
    setBusy: () => undefined,
    selectedPath: PATH
  })
  return { actions, selections, landings }
}

/** The view the main area shows for a selection, as App derives it. */
function viewOf(selection: Selection | undefined): string {
  return chooseView({
    loaded: true,
    folder,
    epicId: selection?.epicId ?? null,
    metrics: selection?.metrics,
    kanban: selection?.kanban,
    agentPane: selection?.agentPane,
    chatId: selection?.chatId ?? null,
    chats: [],
    agents: []
  }).kind
}

describe('DM-267 c3: leaving and reopening the dashboard', () => {
  it('the Metrics action selects the folder dashboard', () => {
    const { actions, selections } = shell()
    actions.selectMetrics(PATH)
    expect(selections).toEqual([{ folderPath: PATH, epicId: null, metrics: true }])
    expect(viewOf(selections[0])).toBe('metrics')
  })

  it.each<[string, (actions: ShellActions) => void, string]>([
    ['an epic', (actions) => actions.selectEpic(PATH, 'ep_1'), 'epic'],
    ['a chat', (actions) => actions.selectChat(PATH, 'chat_1'), 'folder'],
    ['an agent', (actions) => actions.openAgent('claude-code' as AgentId), 'folder'],
    ['the add-agent screen', (actions) => actions.openAddAgent(), 'add-agent'],
    ['the Kanban board', (actions) => actions.selectKanban(PATH), 'kanban']
  ])('choosing %s leaves the dashboard', (_what, act, view) => {
    const { actions, selections } = shell()
    actions.selectMetrics(PATH)
    act(actions)
    expect(selections.at(-1)?.metrics).toBeUndefined()
    expect(viewOf(selections.at(-1))).toBe(view)
  })

  it('a restored selection reopens the dashboard', () => {
    const { actions, selections } = shell()
    actions.selectMetrics(PATH)
    const stored = JSON.parse(JSON.stringify(selections[0])) as Selection
    expect(viewOf(resolveSelection(stored, [folder], true))).toBe('metrics')
  })
})

describe('DM-267 c3: drill-down lands on the Scorecard tab', () => {
  it('an epic row opens the epic and lands on its Scorecard', () => {
    const { actions, selections, landings } = shell()
    actions.openEpicScorecard(PATH, 'ep_1')
    expect(selections.at(-1)).toEqual({ folderPath: PATH, epicId: 'ep_1' })
    expect(landings.at(-1)).toEqual({ kind: 'epicScorecard', epicId: 'ep_1' })
  })

  it('a gap opens the epic and lands on the ticket Scorecard tab of its run', () => {
    const { actions, selections, landings } = shell()
    actions.openTicketScorecard(PATH, { epicId: 'ep_1', ticketId: 'tk_2', runId: 'rn_3', ticketKey: 'DM-2' })
    expect(selections.at(-1)?.epicId).toBe('ep_1')
    expect(landings.at(-1)).toEqual({ kind: 'ticketScorecard', epicId: 'ep_1', ticketId: 'tk_2', runId: 'rn_3', ticketKey: 'DM-2' })
  })

  it('a ticket the saved plan no longer holds opens the epic Scorecard with a message', () => {
    const plan = { bundle: { tickets: [{ id: 'tk_2' }] } }
    const data = { saved: plan, draft: plan, epic: { draftChanged: false } } as unknown as WorkspaceData
    const steps = landingActions({ kind: 'ticketScorecard', epicId: 'ep_1', ticketId: 'tk_404', runId: null, ticketKey: 'DM-404' }, data, 'saved')
    expect(steps).toEqual([
      { type: 'open_scorecard' },
      { type: 'banner', text: "DM-404 is not in this epic's saved plan any more, so its Scorecard tab cannot open; the epic's Scorecard is shown instead." }
    ])
  })
})
