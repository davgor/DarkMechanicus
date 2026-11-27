import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VIEWPORT,
  MIN_PNG_BYTES,
  OVERALL_LIMIT_MS,
  STATES,
  STATE_DEADLINE_MS,
  electronEnv,
  parseArgs,
  runFailures,
  validateCapture,
  validateObservations
} from './capture-agent-chat.mjs'

const HEADER = {
  crumb: 'darkmechanicus / In progress', crumbTitle: 'darkmechanicus / In progress', crumbTruncated: false, crumbOneLine: true,
  title: 'Planning vertical slice', titleTitle: 'Planning vertical slice', titleTruncated: false, besideView: true, sameRow: true,
  contained: true
}
const BASE = {
  viewButtons: ['Agent', 'Graph', 'List', 'Scorecard'], agentFontWeight: '700', header: HEADER,
  planGraph: false, planList: false, scorecard: false, agentChatRegion: true, railWidth: 280, railRightOfStage: true,
  treeRows: [], finishedExpandedAtStart: null, todosHeader: null, todoRows: 0, todoListScrolls: null,
  activeRowVisible: null, activityLine: null, changesHeader: null, cardHeading: null, cardArbitration: null, approvalRecord: null,
  needsYouHeader: null, badgedRows: 0, settingsControls: [], agentsPressed: null, errors: []
}
const row = (name, selected = false, level = 1) => ({ name, level, expanded: null, selected })
const ready = (state, patch = {}) => ({
  state, ready: true, empty: false, bytes: MIN_PNG_BYTES, viewport: { ...DEFAULT_VIEWPORT }, observations: { ...BASE, state, ...patch }
})
/** The shipped agent-tree rows in document order, with the Finished group expanded by the state's click. */
const TREE = [['Magos', 1], ['Acolyte:DM-2', 2], ['Inquisitor:DM-2', 3], ['Servitor-1', 2], ['Finished 1', 2], ['Acolyte:DM-1', 3]]
  .map(([name, level]) => row(name, false, level))

/** A passing record for every state, as a full capture of the preview would report it. */
function passing() {
  return {
    graph: ready('graph', { planGraph: true, agentChatRegion: false, railWidth: null, railRightOfStage: null }),
    'header-long': ready('header-long', {
      planGraph: true, agentChatRegion: false, railWidth: null, railRightOfStage: null,
      header: { ...HEADER, crumbTruncated: true, titleTruncated: true }
    }),
    'agent-empty': ready('agent-empty', { railWidth: null, railRightOfStage: null }),
    'agent-streaming': ready('agent-streaming'),
    'agent-tool': ready('agent-tool', { treeRows: [row('Magos', true), row('Acolyte:DM-785')] }),
    'agent-approval': ready('agent-approval', { cardHeading: 'The agent wants to run: Run tests?' }),
    'agent-worker': ready('agent-worker', { treeRows: [row('Magos'), row('Acolyte:DM-2', true)] }),
    'agent-tree': ready('agent-tree', { treeRows: TREE, finishedExpandedAtStart: false }),
    'rail-collapsed': ready('rail-collapsed', { railWidth: 40 }),
    'chat-rail': ready('chat-rail', {
      viewButtons: [], agentFontWeight: null, header: null, agentChatRegion: false, treeRows: [row('Inquisitor:DM-2', true)]
    }),
    'chat-rail-collapsed': ready('chat-rail-collapsed', {
      viewButtons: [], agentFontWeight: null, header: null, agentChatRegion: false, railWidth: null, railRightOfStage: null,
      agentsPressed: 'false'
    }),
    'agent-todos': ready('agent-todos', {
      todosHeader: 'To-dos 3/7', todoRows: 7, todoListScrolls: true, activeRowVisible: true, activityLine: 'Working 0s · Bash'
    }),
    'agent-todos-collapsed': ready('agent-todos-collapsed', { todosHeader: 'To-dos 3/7 Implementing the card', todoRows: 0 }),
    'agent-stalled': ready('agent-stalled', { activityLine: 'No activity for 31sStop' }),
    'agent-changes': ready('agent-changes', { changesHeader: 'Changes · 2 files' }),
    'agent-approval-named': ready('agent-approval-named', {
      cardHeading: 'Acolyte:DM-442 wants to run: npm test', cardArbitration: 'The Magos asks you: npm test is on your always-ask list.'
    }),
    'agent-magos-decided': ready('agent-magos-decided', {
      approvalRecord: 'Approval Denied by the Magos Run npm test Asked by Acolyte:DM-442 The Magos decided: docs only.'
    }),
    'agent-needs-you': ready('agent-needs-you', { needsYouHeader: '3 needs you · 4 working', badgedRows: 3 }),
    'agent-planners': ready('agent-planners', {
      treeRows: [row('Magos'), ...Array.from({ length: 9 }, (_, index) => row(index === 0 ? 'Lexmechanic' : `Lexmechanic-${index + 1}`, index === 1))]
    }),
    'settings-notifications': ready('settings-notifications', {
      viewButtons: [], agentFontWeight: null, header: null, agentChatRegion: false, railWidth: null, railRightOfStage: null,
      settingsControls: ['An approval needs you', 'Let the Magos arbitrate', 'Save']
    })
  }
}

describe('capture-agent-chat: arguments and environment', () => {
  it('parses --out in both forms to an absolute directory', () => {
    expect(parseArgs(['--out', 'shots']).out).toMatch(/shots$/)
    expect(parseArgs(['--out=shots']).out).toBe(parseArgs(['--out', 'shots']).out)
  })

  it('takes 1280x800 by default and an explicit --viewport in both forms', () => {
    expect(parseArgs(['--out', 'x']).viewport).toEqual({ width: 1280, height: 800 })
    expect(parseArgs(['--out', 'x', '--viewport', '1024x768']).viewport).toEqual({ width: 1024, height: 768 })
    expect(parseArgs(['--viewport=1920x1080', '--out', 'x']).viewport).toEqual({ width: 1920, height: 1080 })
    expect(() => parseArgs(['--out', 'x', '--viewport', 'wide'])).toThrow(/WIDTHxHEIGHT/)
    expect(() => parseArgs(['--out', 'x', '--viewport'])).toThrow(/WIDTHxHEIGHT/)
  })

  it('refuses a missing or empty --out and any unknown argument', () => {
    expect(() => parseArgs([])).toThrow(/Usage/)
    expect(() => parseArgs(['--out'])).toThrow(/Usage/)
    expect(() => parseArgs(['--out='])).toThrow(/Usage/)
    expect(() => parseArgs(['--out', 'x', '--skip'])).toThrow(/Unknown argument: --skip/)
  })

  it('drops every ELECTRON_*, NODE_OPTIONS, DM_SESSION_TOKEN and DM_DESKTOP_PIPE and keeps the rest', () => {
    const env = electronEnv({
      ELECTRON_RUN_AS_NODE: '1', electron_enable_logging: '1', NODE_OPTIONS: '--inspect', DM_SESSION_TOKEN: 's', DM_DESKTOP_PIPE: 'p',
      PATH: '/bin', DM_SESSION_TOKEN_EXTRA: 'kept', TEMP: 't'
    })
    expect(env).toEqual({ PATH: '/bin', DM_SESSION_TOKEN_EXTRA: 'kept', TEMP: 't' })
  })
})

describe('capture-agent-chat: state list and bounds', () => {
  it('lists the 20 states once each, in capture order', () => {
    expect(STATES).toEqual([
      'graph', 'header-long', 'agent-empty', 'agent-streaming', 'agent-tool', 'agent-approval', 'agent-worker', 'agent-tree',
      'rail-collapsed', 'chat-rail', 'chat-rail-collapsed', 'agent-todos', 'agent-todos-collapsed', 'agent-stalled', 'agent-changes',
      'agent-approval-named', 'agent-magos-decided', 'agent-needs-you', 'agent-planners', 'settings-notifications'
    ])
    expect(new Set(STATES).size).toBe(20)
    expect(Object.isFrozen(STATES)).toBe(true)
  })

  it('declares 15 s per state within a 320 s overall bound that covers all 20', () => {
    expect(STATE_DEADLINE_MS).toBe(15_000)
    expect(OVERALL_LIMIT_MS).toBe(320_000)
    expect(OVERALL_LIMIT_MS).toBeGreaterThan(STATES.length * STATE_DEADLINE_MS)
  })
})

describe('capture-agent-chat: observation validator', () => {
  it('passes a complete capture of every state', () => {
    expect(runFailures(passing())).toEqual([])
  })

  it('fails a state whose data-ready never appeared, with the reason', () => {
    expect(validateObservations('graph', { state: 'graph', ready: false, error: 'no observations within 15000 ms' }))
      .toEqual(['graph: #observations[data-ready="1"] never appeared (no observations within 15000 ms)'])
  })

  it('fails a missing observation field', () => {
    const record = passing()['agent-tool']
    delete record.observations.treeRows
    expect(validateObservations('agent-tool', record)).toEqual(['agent-tool: missing observation treeRows'])
  })

  it('fails on page errors', () => {
    expect(validateObservations('graph', ready('graph', { planGraph: true, agentChatRegion: false, errors: ['boom'] })))
      .toEqual(['graph: page error: boom'])
  })

  it('fails a state that Electron never reported', () => {
    const records = passing()
    delete records['agent-needs-you']
    expect(runFailures(records)).toEqual(['agent-needs-you: Electron reported nothing for this state'])
  })

  it('fails a wrong view order, a non-bold Agent label and leftover plan nodes', () => {
    expect(validateObservations('agent-streaming', ready('agent-streaming', { viewButtons: ['Graph', 'Agent'] })))
      .toEqual(['agent-streaming: expected the View buttons are Agent, Graph, List, Scorecard in order'])
    expect(validateObservations('agent-streaming', ready('agent-streaming', { agentFontWeight: '400' })))
      .toEqual(['agent-streaming: expected a bold Agent label'])
    expect(validateObservations('agent-streaming', ready('agent-streaming', { planList: true })))
      .toEqual(['agent-streaming: expected no plan graph, list or scorecard node'])
  })

  it('fails a breadcrumb that wraps, sits off the View row or spills, and a long name that does not truncate', () => {
    const header = (patch) => ready('agent-streaming', { header: { ...HEADER, ...patch } })
    const expected = ['agent-streaming: expected a one-line breadcrumb beside the View group, the heading holding its content, both names titled']
    expect(validateObservations('agent-streaming', header({ crumbOneLine: false }))).toEqual(expected)
    expect(validateObservations('agent-streaming', header({ besideView: false }))).toEqual(expected)
    expect(validateObservations('agent-streaming', header({ contained: false }))).toEqual(expected)
    expect(validateObservations('agent-streaming', header({ crumbTitle: '' }))).toEqual(expected)
    expect(validateObservations('header-long', ready('header-long', { planGraph: true, agentChatRegion: false })))
      .toEqual(['header-long: expected the long breadcrumb and title truncate'])
  })
})

describe('capture-agent-chat: agent-tree levels', () => {
  it('fails agent-tree when Acolyte:DM-1 sits at the wrong level, naming where the capture placed it', () => {
    const shallow = TREE.map((entry) => entry.name === 'Acolyte:DM-1' ? { ...entry, level: 2 } : entry)
    expect(validateObservations('agent-tree', ready('agent-tree', { treeRows: shallow, finishedExpandedAtStart: false })))
      .toEqual(['agent-tree: expected Acolyte:DM-1 at level 3 under Finished 1; got level 2 under Magos'])
  })

  it('fails agent-tree when a node keeps its level but moves under another parent, or is missing', () => {
    const moved = [TREE[0], TREE[1], TREE[3], TREE[2], TREE[4], TREE[5]]
    expect(validateObservations('agent-tree', ready('agent-tree', { treeRows: moved, finishedExpandedAtStart: false })))
      .toEqual(['agent-tree: expected Inquisitor:DM-2 at level 3 under Acolyte:DM-2; got level 3 under Servitor-1'])
    expect(validateObservations('agent-tree', ready('agent-tree', { treeRows: TREE.slice(0, 5), finishedExpandedAtStart: false })))
      .toEqual(['agent-tree: expected Acolyte:DM-1 at level 3 under Finished 1; got no such row'])
  })

  it('fails agent-tree unless the Finished group was collapsed before the state expanded it', () => {
    for (const finishedExpandedAtStart of [true, null]) {
      expect(validateObservations('agent-tree', ready('agent-tree', { treeRows: TREE, finishedExpandedAtStart })))
        .toEqual(['agent-tree: expected the Finished 1 group is collapsed by default'])
    }
  })
})

describe('capture-agent-chat: per-state observations', () => {
  it('fails agent-tree unless the rail is 280±1 wide and rail-collapsed unless it is 40±1', () => {
    const records = passing()
    expect(validateObservations('agent-tree', { ...records['agent-tree'], observations: { ...records['agent-tree'].observations, railWidth: 281 } })).toEqual([])
    expect(validateObservations('agent-tree', { ...records['agent-tree'], observations: { ...records['agent-tree'].observations, railWidth: 240 } }))
      .toEqual(['agent-tree: expected railWidth is 280±1'])
    expect(validateObservations('rail-collapsed', ready('rail-collapsed', { railWidth: 280 }))).toEqual(['rail-collapsed: expected railWidth is 40±1'])
  })

  it('fails agent-tool unless the tree lists the subagent Acolyte:DM-785, not just any second row', () => {
    expect(validateObservations('agent-tool', ready('agent-tool', { treeRows: [row('Magos', true), row('Finished 1')] })))
      .toEqual(['agent-tool: expected the tree lists Magos and the subagent Acolyte:DM-785'])
  })

  it('fails any agent state whose rail is not right of the stage', () => {
    expect(validateObservations('agent-worker', ready('agent-worker', { railRightOfStage: false, treeRows: [row('Acolyte:DM-2', true)] })))
      .toEqual(['agent-worker: expected the rail right of the stage'])
  })

  it('requires the to-do list to scroll with the active row visible and the busy activity line', () => {
    const todos = passing()['agent-todos'].observations
    expect(validateObservations('agent-todos', ready('agent-todos', { ...todos, todoListScrolls: false })))
      .toEqual(['agent-todos: expected the task list scrolls'])
    expect(validateObservations('agent-todos', ready('agent-todos', { ...todos, activeRowVisible: false })))
      .toEqual(['agent-todos: expected the active row is inside the list'])
    expect(validateObservations('agent-todos', ready('agent-todos', { ...todos, activityLine: null })))
      .toEqual(['agent-todos: expected the activity line reads Working … · Bash'])
  })

  it('requires the stalled line, the Changes header, the named card, the needs-you count and the settings names', () => {
    expect(validateObservations('agent-stalled', ready('agent-stalled'))).toEqual(['agent-stalled: expected the activity line reads No activity for 31s'])
    expect(validateObservations('agent-changes', ready('agent-changes'))).toEqual(['agent-changes: expected the Changes header lists 2 files'])
    expect(validateObservations('agent-approval-named', ready('agent-approval-named'))).toHaveLength(2)
    expect(validateObservations('agent-needs-you', ready('agent-needs-you', { needsYouHeader: '1 needs you', badgedRows: 1 }))).toHaveLength(2)
    const settings = passing()['settings-notifications']
    expect(validateObservations('settings-notifications', { ...settings, observations: { ...settings.observations, settingsControls: ['Save', ''] } }))
      .toEqual(['settings-notifications: expected the controls have accessible names'])
  })
})

describe('capture-agent-chat: capture validator', () => {
  const page = { ...DEFAULT_VIEWPORT }
  it('fails an empty image and a PNG under 10 KB', () => {
    expect(validateCapture('graph', { ready: true, empty: true, bytes: 0, viewport: page })).toEqual(['graph: capturePage() returned an empty image'])
    expect(validateCapture('graph', { ready: true, empty: false, bytes: MIN_PNG_BYTES - 1, viewport: page }))
      .toEqual([`graph: the PNG is ${MIN_PNG_BYTES - 1} bytes, under ${MIN_PNG_BYTES}`])
    expect(validateCapture('graph', { ready: true, empty: false, bytes: MIN_PNG_BYTES, viewport: page })).toEqual([])
  })

  it('fails a page whose viewport is not the requested size', () => {
    const small = { width: 1024, height: 768 }
    expect(validateCapture('graph', { ready: true, empty: false, bytes: MIN_PNG_BYTES, viewport: small }, small)).toEqual([])
    expect(validateCapture('graph', { ready: true, empty: false, bytes: MIN_PNG_BYTES, viewport: page }, small))
      .toEqual(['graph: the page viewport was 1280x800, not 1024x768'])
    expect(validateCapture('graph', { ready: true, empty: false, bytes: MIN_PNG_BYTES }))
      .toEqual(['graph: the page viewport was undefinedxundefined, not 1280x800'])
  })
})
