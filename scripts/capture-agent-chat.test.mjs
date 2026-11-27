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
  needsYouHeader: null, badgedRows: 0, ticketPanel: false, settingsControls: [], agentsPressed: null, sprintDeliveryRegion: false,
  deliveryLine: null, deliveryApproval: null, previousDelivery: false, firstFailedCheck: null, errors: []
}
const row = (name, selected = false, level = 1) => ({ name, level, expanded: null, selected })
const ready = (state, patch = {}) => ({
  state, ready: true, empty: false, bytes: MIN_PNG_BYTES, viewport: { ...DEFAULT_VIEWPORT }, observations: { ...BASE, state, ...patch }
})
/** The shipped agent-tree rows in document order, with the Finished group expanded by the state's click. */
const TREE = [['Magos', 1], ['Acolyte:DM-2', 2], ['Inquisitor:DM-2', 3], ['Servitor-1', 2], ['Finished 1', 2], ['Acolyte:DM-1', 3]]
  .map(([name, level]) => row(name, false, level))
const STALE_INSTALL = 'Installed app version: 0.49.0 is older than 0.50.0'
const HELD = 'Sprint 1 delivery to main: the latest check failed'
const PLAN = { agentChatRegion: false, railWidth: null, railRightOfStage: null }
/** The agent-glass state's computed glass, as Chromium reports the shipped tokens. */
const GLASS = {
  backdrop: 'radial-gradient(75% 85% at 85% 0%, rgba(214, 155, 74, 0.28), rgba(0, 0, 0, 0) 70%), '
    + 'radial-gradient(70% 85% at 0% 100%, rgba(181, 26, 31, 0.3), rgba(0, 0, 0, 0) 70%), none',
  rail: { background: 'rgba(33, 27, 24, 0.7)', backdropFilter: 'blur(16px) saturate(1.2)' },
  card: { background: 'rgba(33, 27, 24, 0.7)', backdropFilter: 'blur(16px) saturate(1.2)' },
  transcript: { background: 'rgba(21, 18, 17, 0.9)', backdropFilter: 'blur(16px) saturate(1.2)' }
}
const ROLE_CARD = { background: 'rgba(33, 27, 24, 0.7)', backdropFilter: 'blur(16px) saturate(1.2)', artWidth: 160, artHeight: 160, clipped: false }
/** The agent-role-picker state's two cards, Magos checked, as the preview measures them. */
const ROLE_CARDS = [
  { ...ROLE_CARD, name: 'Magos', checked: true, reason: null, art: 'Magos: a hooded tech-priest with a cog halo' },
  { ...ROLE_CARD, name: 'Lexmechanic', checked: false, reason: null, art: 'Lexmechanic: a scribe-priest with a data-slate, scrolls and a quill-servo arm' }
]
/** The agent-empty state's cards: its run is active, so Magos shows why it cannot start and Lexmechanic is checked. */
const ACTIVE_RUN_CARDS = [
  { ...ROLE_CARDS[0], checked: false, reason: 'A run is active; its Magos is in the list' },
  { ...ROLE_CARDS[1], checked: true }
]
/** The new-chat-picker state's dialog: its name, the picker above the First prompt field, and no scrolling. */
const NEW_CHAT = { title: 'Start a new chat', pickerAbovePrompt: true, scrolls: false }
const STANDALONE = { viewButtons: [], agentFontWeight: null, header: null, agentChatRegion: false, railWidth: null, railRightOfStage: null }
/** The agent-composer state's idle and busy composers, as Chromium reports the shipped styles. */
const COMPOSER = {
  radius: '18px', background: 'rgba(33, 27, 24, 0.7)', backdropFilter: 'blur(16px) saturate(1.2)', width: 480,
  placeholder: 'Reply to Magos…', chips: ['Magos · Skitarii', 'dark-mechanicus', '2 queued'], send: null, stop: null
}
const COMPOSERS = [
  { ...COMPOSER, lines: 2, send: { radius: '50%', width: 32, height: 32 } },
  { ...COMPOSER, lines: 1, stop: { radius: '8px', width: 32, height: 32 } }
]
/** An agent-composer record: a standalone chat page, so no epic header, View group or rail. */
const composerRecord = (composers) => ready('agent-composer', {
  viewButtons: [], agentFontWeight: null, header: null, agentChatRegion: false, railWidth: null, railRightOfStage: null, composers
})
/** An agent-images record: the standalone chat's one composer with four loaded chips, an enabled Send and the fifth refused. */
const IMAGES_COMPOSER = {
  ...COMPOSER, chips: ['Magos · Skitarii', 'dark-mechanicus'], lines: 1, send: { radius: '50%', width: 32, height: 32 }, sendEnabled: true,
  attach: { radius: '50%', width: 28, height: 28 },
  images: { chips: 4, loaded: 4, removable: 4, aboveText: true, alert: 'At most 4 images can go with one message.' }
}
const imagesRecord = (patch = {}) => ready('agent-images', {
  viewButtons: [], agentFontWeight: null, header: null, agentChatRegion: false, composers: [{ ...IMAGES_COMPOSER, ...patch }]
})

/** The agent-transcript state's layout, as Chromium reports the shipped styles at 1280×800. */
const TRANSCRIPT = {
  columnWidth: 760, columnOffset: 0,
  bubble: { radius: '18px', background: 'rgb(48, 40, 35)', rightGap: 0, leftGap: 280 },
  bubbleCopy: 'Copy', bubbleCopyFocused: true,
  reply: { background: 'rgba(0, 0, 0, 0)', border: '0px', width: 760 },
  replyActions: ['Copy'], codeCopy: 'Copy', codeCopyCorner: { top: 6, right: 6 }
}
const transcriptRecord = (patch = {}) => ready('agent-transcript', { ...STANDALONE, transcript: { ...TRANSCRIPT, ...patch } })

/** The mail-card state: the Magos chat with a received card and its sent answer between the ask and the reply. */
const MAIL = {
  rows: ['item', 'mail', 'mail', 'item'],
  cards: [
    { direction: 'received', head: '✉ Lexmechanic → Magos Received', reply: null, markup: false,
      body: 'Plan revision 14 is saved. DM-1050 now depends on DM-1049; start it only after DM-1049 is accepted.\n<b>Not markup</b>: shown as typed.' },
    { direction: 'sent', head: '✉ Magos → Lexmechanic Sent', reply: 'Reply to mm_plan14', markup: false,
      body: 'Understood. DM-1049 is in review; DM-1050 stays queued until it is accepted.' }
  ],
  seen: [[{ folder: '/home/u/code/darkmechanicus', chatId: 'fixture-magos', throughSeq: 1 }]]
}
const mailRecord = (patch = {}) => ready('mail-card', { ...STANDALONE, mail: { ...MAIL, ...patch } })
/** The image-result transcript's three thumbnails: the person's two (the second's file gone), then the tool's one. */
const THUMBS = [
  { under: 'you', name: 'Image from you, 1280x800', scheme: 'dm-chat-image:', lazy: true, loaded: true, width: 160 },
  { under: 'you', name: 'Image from you, 1024x768 (image missing)', scheme: null, lazy: false, loaded: false, width: 160 },
  { under: 'tool', name: 'Image from agent, 1440x900', scheme: 'dm-chat-image:', lazy: true, loaded: true, width: 160 }
]
const VIEWER = { name: 'Image from agent, 1440x900', scheme: 'dm-chat-image:', loaded: true, closeFocused: true }
const imageRecord = (state, thumbs = THUMBS, viewer = state === 'agent-image-viewer' ? VIEWER : null) =>
  ready(state, { ...STANDALONE, chatImages: { thumbs, viewer } })

/** Passing records for the delivery states: the acceptance node's editor, the held run bar and the checkpoint. */
function passingDeliveryStates() {
  return {
    'delivery-editor': ready('delivery-editor', {
      ...PLAN, planGraph: true, ticketPanel: true, sprintDeliveryRegion: true, deliveryLine: 'Sprint 1 delivery to main: waiting for the Magos to record it'
    }),
    'delivery-pending': ready('delivery-pending', { ...PLAN, planGraph: true, deliveryLine: HELD, firstFailedCheck: STALE_INSTALL }),
    'delivery-checkpoint': ready('delivery-checkpoint', {
      ...PLAN, deliveryLine: HELD, previousDelivery: true, firstFailedCheck: STALE_INSTALL,
      deliveryApproval: 'After approval, Sprint 3 claims wait for recorded delivery verification or a person-owned waiver. Under current Sprint standards …'
    })
  }
}

/**
 * Passing records for the rail states: the tree, the collapsed rail, the landings that expand it on their own, and
 * the glass rail beside a docked approval card.
 */
function passingRailStates() {
  return {
    'agent-tree': ready('agent-tree', { treeRows: TREE, finishedExpandedAtStart: false }),
    'rail-collapsed': ready('rail-collapsed', { railWidth: 40 }),
    'landing-notification': ready('landing-notification', { treeRows: [row('Magos'), row('Acolyte:DM-2', true)] }),
    'landing-activity': ready('landing-activity', {
      treeRows: TREE.map((entry) => entry.name === 'Acolyte:DM-1' ? { ...entry, selected: true } : entry)
    }),
    'agent-glass': ready('agent-glass', { cardHeading: 'Acolyte:DM-442 wants to run: npm test', glass: GLASS })
  }
}

/** Passing records for the standalone chat pages: the chat's own Agents rail and the shared composers. */
function passingChatStates() {
  return {
    'chat-rail': ready('chat-rail', {
      viewButtons: [], agentFontWeight: null, header: null, agentChatRegion: false, treeRows: [row('Inquisitor:DM-2', true)]
    }),
    'chat-rail-collapsed': ready('chat-rail-collapsed', {
      viewButtons: [], agentFontWeight: null, header: null, agentChatRegion: false, railWidth: null, railRightOfStage: null,
      agentsPressed: 'false'
    }),
    'chat-rail-legacy': ready('chat-rail-legacy', {
      viewButtons: [], agentFontWeight: null, header: null, agentChatRegion: false,
      treeRows: [row('Magos'), row('Servitor-2', true), row('Servitor-3', false, 3), row('Servitor-1')]
    }),
    'agent-composer': composerRecord(COMPOSERS),
    'agent-images': imagesRecord(),
    'agent-transcript': transcriptRecord(),
    'agent-image-result': imageRecord('agent-image-result'),
    'agent-image-viewer': imageRecord('agent-image-viewer'),
    'mail-card': mailRecord()
  }
}

/** The question-multi state's docked card: the first of two questions, two options checked, Submit enabled. */
const QUESTION = {
  legend: 'Which checks should the worker run before it submits?', progress: 'Question 1 of 2', checkboxes: 4,
  checked: ['Lint', 'Unit tests'], count: '2 selected', submitEnabled: true
}

/** A passing record for every state, as a full capture of the preview would report it. */
function passing() {
  return {
    ...passingRailStates(),
    ...passingChatStates(),
    ...passingDeliveryStates(),
    graph: ready('graph', { planGraph: true, agentChatRegion: false, railWidth: null, railRightOfStage: null }),
    'header-long': ready('header-long', {
      planGraph: true, agentChatRegion: false, railWidth: null, railRightOfStage: null,
      header: { ...HEADER, crumbTruncated: true, titleTruncated: true }
    }),
    'agent-empty': ready('agent-empty', { railWidth: null, railRightOfStage: null, rolePicker: { cards: ACTIVE_RUN_CARDS } }),
    'epic-agent-picker': ready('epic-agent-picker', { railWidth: null, railRightOfStage: null, rolePicker: { cards: ROLE_CARDS } }),
    'agent-streaming': ready('agent-streaming'),
    'agent-tool': ready('agent-tool', { treeRows: [row('Magos', true), row('Acolyte:DM-785')] }),
    'agent-approval': ready('agent-approval', { cardHeading: 'The agent wants to run: Run tests?' }),
    'agent-worker': ready('agent-worker', { treeRows: [row('Magos'), row('Acolyte:DM-2', true)] }),
    'agent-legacy-thread': ready('agent-legacy-thread', {
      treeRows: [row('Magos'), row('Servitor-2', true), row('Servitor-3', false, 3), row('Servitor-1')]
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
      ...STANDALONE, settingsControls: ['An approval needs you', 'Let the Magos arbitrate', 'Save']
    }),
    'agent-role-picker': ready('agent-role-picker', { ...STANDALONE, rolePicker: { cards: ROLE_CARDS } }),
    'new-chat-picker': ready('new-chat-picker', { ...STANDALONE, rolePicker: { cards: ROLE_CARDS }, newChat: NEW_CHAT }),
    'question-multi': ready('question-multi', { questionCard: QUESTION })
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
  it('lists the 38 states once each, in capture order', () => {
    expect(STATES).toEqual([
      'graph', 'header-long', 'agent-empty', 'agent-streaming', 'agent-tool', 'agent-approval', 'agent-worker', 'agent-legacy-thread',
      'agent-tree', 'rail-collapsed', 'landing-notification', 'landing-activity', 'chat-rail', 'chat-rail-collapsed', 'agent-todos',
      'agent-todos-collapsed', 'agent-stalled', 'agent-changes', 'agent-approval-named', 'agent-magos-decided', 'agent-needs-you',
      'agent-planners', 'chat-rail-legacy', 'agent-glass', 'agent-composer', 'agent-images', 'agent-role-picker', 'epic-agent-picker',
      'new-chat-picker', 'question-multi', 'agent-transcript', 'agent-image-result', 'agent-image-viewer', 'mail-card', 'settings-notifications',
      'delivery-editor', 'delivery-pending', 'delivery-checkpoint'
    ])
    expect(new Set(STATES).size).toBe(38)
    expect(Object.isFrozen(STATES)).toBe(true)
  })

  it('declares 15 s per state within a 585 s overall bound: 38 states at 15 s plus 15 s to start', () => {
    expect(STATE_DEADLINE_MS).toBe(15_000)
    expect(OVERALL_LIMIT_MS).toBe(585_000)
    expect(OVERALL_LIMIT_MS).toBe(STATES.length * STATE_DEADLINE_MS + 15_000)
  })
})

describe('capture-agent-chat: mail-card', () => {
  it('passes a received then a sent card, headed by callsigns, inert, the received one marked seen once', () => {
    expect(validateObservations('mail-card', mailRecord())).toEqual([])
  })

  it('fails cards out of place, a rendered body element and a second seen mark', () => {
    expect(validateObservations('mail-card', mailRecord({ rows: ['item', 'item', 'mail', 'mail'] }))).toEqual([
      expect.stringContaining('mail-card: expected a received card then a sent card between the person’s message and the reply')
    ])
    expect(validateObservations('mail-card', mailRecord({ cards: [{ ...MAIL.cards[0], markup: true }, MAIL.cards[1]] }))).toEqual([
      expect.stringContaining('mail-card: expected bodies are plain text')
    ])
    expect(validateObservations('mail-card', mailRecord({ seen: [...MAIL.seen, ...MAIL.seen] }))).toEqual([
      expect.stringContaining('mail-card: expected showing the received card marks it seen once')
    ])
  })
})

describe('capture-agent-chat: agent-image-result and agent-image-viewer', () => {
  it('passes the thumbnails under the bubble and the tool card, and the viewer open on the tool image', () => {
    expect(validateObservations('agent-image-result', imageRecord('agent-image-result'))).toEqual([])
    expect(validateObservations('agent-image-viewer', imageRecord('agent-image-viewer'))).toEqual([])
  })

  it('fails a gone image shown as loaded, a non-lazy or wide thumbnail, a stray viewer and an unfocused one', () => {
    const loadedGone = THUMBS.map((thumb, index) => index === 1 ? { ...thumb, name: 'Image from you, 1024x768', loaded: true } : thumb)
    expect(validateObservations('agent-image-result', imageRecord('agent-image-result', loadedGone))).toEqual([
      expect.stringMatching(/^agent-image-result: expected two thumbnails under the person’s bubble, the gone one a placeholder/),
      expect.stringMatching(/^agent-image-result: expected every loaded thumbnail is a lazy dm-chat-image: picture; got /)
    ])
    expect(validateObservations('agent-image-result', imageRecord('agent-image-result', THUMBS.map((thumb) => ({ ...thumb, width: 240 })))))
      .toEqual(['agent-image-result: expected every thumbnail at most 160 px wide; got [240,240,240]'])
    expect(validateObservations('agent-image-result', imageRecord('agent-image-result', THUMBS, VIEWER)))
      .toEqual(['agent-image-result: expected no lightbox open'])
    expect(validateObservations('agent-image-viewer', imageRecord('agent-image-viewer', THUMBS, { ...VIEWER, closeFocused: false })))
      .toEqual([expect.stringMatching(/^agent-image-viewer: expected the lightbox shows the agent’s image loaded from dm-chat-image:, its Close focused; got /)])
  })
})

describe('capture-agent-chat: agent-images', () => {
  it('passes four loaded chips above the text, a leading round attach button, an enabled Send and the fifth refused', () => {
    expect(validateObservations('agent-images', imagesRecord())).toEqual([])
  })

  it('fails a broken thumbnail, chips under the text, a missing attach button and a disabled Send', () => {
    expect(validateObservations('agent-images', imagesRecord({ images: { ...IMAGES_COMPOSER.images, loaded: 3 } })))
      .toEqual([expect.stringMatching(/^agent-images: expected one composer holding four loaded image thumbnails, each removable; got /)])
    expect(validateObservations('agent-images', imagesRecord({ images: { ...IMAGES_COMPOSER.images, aboveText: false } })))
      .toEqual(['agent-images: expected the chips sit inside the card above the text area'])
    expect(validateObservations('agent-images', imagesRecord({ attach: null })))
      .toEqual(['agent-images: expected a round "+" attach button leads the row; got null'])
    expect(validateObservations('agent-images', imagesRecord({ sendEnabled: false })))
      .toEqual(['agent-images: expected Send is enabled with the images'])
    expect(validateObservations('agent-images', imagesRecord({ images: { ...IMAGES_COMPOSER.images, alert: null } })))
      .toEqual(['agent-images: expected the fifth image is refused inline; got null'])
  })
})

describe('capture-agent-chat: agent-transcript', () => {
  it('passes a centred column, a right-hand bubble, a plain reply and every Copy in place', () => {
    expect(validateObservations('agent-transcript', transcriptRecord())).toEqual([])
  })

  it('fails a column wider than 760 px, a reply in a bubble and a bubble on the left', () => {
    expect(validateObservations('agent-transcript', transcriptRecord({ columnWidth: 860 })))
      .toEqual([expect.stringMatching(/^agent-transcript: expected a centred reading column at most 760 px wide/),
        expect.stringMatching(/^agent-transcript: expected the reply is plain text across the column/)])
    expect(validateObservations('agent-transcript', transcriptRecord({ reply: { ...TRANSCRIPT.reply, background: 'rgb(33, 27, 24)' } })))
      .toEqual([expect.stringMatching(/^agent-transcript: expected the reply is plain text across the column, with no bubble; got /)])
    expect(validateObservations('agent-transcript', transcriptRecord({ bubble: { ...TRANSCRIPT.bubble, rightGap: 280, leftGap: 0 } })))
      .toEqual([expect.stringMatching(/^agent-transcript: expected the person’s message is a rounded bubble against the column’s right edge/)])
  })

  it('fails a missing action row, a bubble Copy hidden under focus and a code Copy outside the corner', () => {
    expect(validateObservations('agent-transcript', transcriptRecord({ replyActions: [] })))
      .toEqual(['agent-transcript: expected the reply’s action row holds Copy; got []'])
    expect(validateObservations('agent-transcript', transcriptRecord({ bubbleCopy: null })))
      .toEqual(['agent-transcript: expected the bubble’s Copy shows under keyboard focus; got [null,true]'])
    expect(validateObservations('agent-transcript', transcriptRecord({ codeCopyCorner: { top: 40, right: 6 } })))
      .toEqual(['agent-transcript: expected the code block’s Copy sits in its top-right corner; got ["Copy",{"top":40,"right":6}]'])
  })
})

describe('capture-agent-chat: agent-composer', () => {
  const composer = (patch) => composerRecord(COMPOSERS.map((card, index) => ({ ...card, ...patch(index) })))

  it('passes the idle and busy glass composers', () => {
    expect(validateObservations('agent-composer', composer(() => ({})))).toEqual([])
  })

  it('fails a busy composer that still shows Send, a square Send and a round Stop', () => {
    expect(validateObservations('agent-composer', composer((index) => index === 1 ? { send: COMPOSERS[0].send } : {})))
      .toEqual(['agent-composer: expected two composers: the idle one with Send and no Stop, the busy one with Stop and no Send; got ["send","both"]'])
    expect(validateObservations('agent-composer', composer((index) => index === 0
      ? { send: { ...COMPOSERS[0].send, radius: '8px' } }
      : { stop: { ...COMPOSERS[1].stop, radius: '50%' } })))
      .toEqual([expect.stringMatching(/^agent-composer: expected a round 32 px Send and a square 32 px Stop; got /)])
  })

  it('fails a card rounded under 16 px, a missing queue chip and a draft that did not grow', () => {
    expect(validateObservations('agent-composer', composer(() => ({ radius: '8px' }))))
      .toEqual([expect.stringMatching(/^agent-composer: expected each composer is a frosted glass card rounded 16 px or more/)])
    expect(validateObservations('agent-composer', composer(() => ({ chips: ['Magos · Skitarii', 'dark-mechanicus'] }))))
      .toEqual([expect.stringMatching(/^agent-composer: expected both composers chip the agent, the context and 2 queued/)])
    expect(validateObservations('agent-composer', composer(() => ({ lines: 1 }))))
      .toEqual(['agent-composer: expected the idle draft grew to two lines and the empty busy composer holds one; got [1,1]'])
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

describe('capture-agent-chat: landing observations', () => {
  it('fails a landing whose rail stayed collapsed, whose ticket panel stayed open or whose agent is not shown', () => {
    const records = passing()
    expect(validateObservations('landing-notification', { ...records['landing-notification'],
      observations: { ...records['landing-notification'].observations, railWidth: 40, treeRows: [] } }))
      .toEqual(['landing-notification: expected railWidth is 280±1 with no Expand click', 'landing-notification: expected Acolyte:DM-2 is selected'])
    const activity = records['landing-activity'].observations
    expect(validateObservations('landing-activity', { ...records['landing-activity'], observations: { ...activity, ticketPanel: true } }))
      .toEqual(['landing-activity: expected no ticket panel over the rail'])
    const hidden = TREE.filter((entry) => entry.name !== 'Acolyte:DM-1')
    expect(validateObservations('landing-activity', { ...records['landing-activity'], observations: { ...activity, treeRows: hidden } }))
      .toEqual(['landing-activity: expected Acolyte:DM-1 is selected inside the opened Finished 1 group; got no such row'])
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

  it('fails chat-rail-legacy when the legacy helper repeats a stamped Servitor callsign', () => {
    const base = { viewButtons: [], agentFontWeight: null, agentChatRegion: false }
    expect(validateObservations('chat-rail-legacy', ready('chat-rail-legacy', {
      ...base, treeRows: [row('Magos'), row('Servitor-1', true), row('Servitor-1')]
    }))).toEqual(['chat-rail-legacy: expected the legacy and stamped helpers are Servitor-2 (selected) and Servitor-1, each named once'])
  })

  it('fails agent-legacy-thread when the nested legacy helper repeats a stamped Servitor callsign', () => {
    expect(validateObservations('agent-legacy-thread', ready('agent-legacy-thread', {
      treeRows: [row('Magos'), row('Servitor-2', true), row('Servitor-1', false, 3), row('Servitor-1')]
    }))).toEqual([
      'agent-legacy-thread: expected the legacy parent Servitor-2 is selected beside its nested Servitor-3 and the stamped Servitor-1, each named once'
    ])
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

describe('capture-agent-chat: agent-glass observations', () => {
  it('requires agent-glass to show the glows, a frosted rail and card, and a near-solid transcript', () => {
    const glass = (patch) => validateObservations('agent-glass', ready('agent-glass', {
      cardHeading: 'Acolyte:DM-442 wants to run: npm test', glass: { ...GLASS, ...patch }
    }))
    expect(glass({ backdrop: 'none' })).toEqual(['agent-glass: expected the stage paints the brass and crimson radial glows; got none'])
    expect(glass({ rail: { background: 'rgb(40, 33, 29)', backdropFilter: 'none' } }))
      .toEqual(['agent-glass: expected the open rail is frosted glass; got {"background":"rgb(40, 33, 29)","backdropFilter":"none"}'])
    expect(glass({ card: { background: 'rgba(33, 27, 24, 0.95)', backdropFilter: 'blur(16px) saturate(1.2)' } })).toHaveLength(1)
    expect(glass({ transcript: { background: 'rgba(21, 18, 17, 0.5)', backdropFilter: 'none' } })).toHaveLength(1)
    expect(validateObservations('agent-glass', ready('agent-glass'))).toHaveLength(4)
  })
})

describe('capture-agent-chat: agent-role-picker observations', () => {
  const picker = (cards) => validateObservations('agent-role-picker', ready('agent-role-picker', { ...STANDALONE, rolePicker: { cards } }))

  it('passes two glass cards, Magos checked, each with its own labelled art of 96 px or more and nothing clipped', () => {
    expect(picker(ROLE_CARDS)).toEqual([])
    expect(picker(ROLE_CARDS.map((card) => ({ ...card, artWidth: 96, artHeight: 96 })))).toEqual([])
  })

  it('fails a wrong check order, missing or shared or small art, a solid card and clipped text', () => {
    const [magos, lex] = ROLE_CARDS
    expect(picker([{ ...magos, checked: false }, { ...lex, checked: true }])).toEqual([
      'agent-role-picker: expected the radios are Magos (checked) then Lexmechanic; got [["Magos",false],["Lexmechanic",true]]'
    ])
    expect(picker([magos, { ...lex, art: magos.art }])).toHaveLength(1)
    expect(picker([magos, { ...lex, art: null }])).toHaveLength(1)
    expect(picker([magos, { ...lex, artWidth: 80 }])).toHaveLength(1)
    expect(picker([magos, { ...lex, background: 'rgb(40, 33, 29)', backdropFilter: 'none' }])).toEqual(['agent-role-picker: expected both cards are frosted glass'])
    expect(picker([magos, { ...lex, clipped: true }])).toEqual(['agent-role-picker: expected no card clips its text or leaves the window'])
    expect(validateObservations('agent-role-picker', ready('agent-role-picker', STANDALONE))).toHaveLength(4)
  })
})

describe('capture-agent-chat: epic Agent tab pickers', () => {
  const epicPicker = (state, cards) => validateObservations(state, ready(state, { railWidth: null, railRightOfStage: null, rolePicker: { cards } }))

  it('passes the empty Agent tab’s enabled cards and the active run’s disabled Magos', () => {
    expect(epicPicker('epic-agent-picker', ROLE_CARDS)).toEqual([])
    expect(epicPicker('agent-empty', ACTIVE_RUN_CARDS)).toEqual([])
  })

  it('fails a disabled Magos on the empty tab, a missing reason with a run, no cards and clipped text', () => {
    expect(epicPicker('epic-agent-picker', ACTIVE_RUN_CARDS)).toEqual([
      'epic-agent-picker: expected the empty Agent tab’s radios are Magos (checked) then Lexmechanic, both enabled; '
        + 'got [["Magos",false,"A run is active; its Magos is in the list"],["Lexmechanic",true,null]]'
    ])
    expect(epicPicker('agent-empty', ROLE_CARDS)).toHaveLength(1)
    expect(epicPicker('epic-agent-picker', [])).toHaveLength(4)
    expect(epicPicker('epic-agent-picker', [ROLE_CARDS[0], { ...ROLE_CARDS[1], clipped: true }]))
      .toEqual(['epic-agent-picker: expected no card clips its text or leaves the window'])
  })
})

describe('capture-agent-chat: new-chat-picker observations', () => {
  const dialog = (patch) => validateObservations('new-chat-picker',
    ready('new-chat-picker', { ...STANDALONE, rolePicker: { cards: ROLE_CARDS }, newChat: NEW_CHAT, ...patch }))

  it('passes the New chat dialog with both role cards above the prompt', () => {
    expect(dialog({})).toEqual([])
  })

  it('fails a picker below the prompt, a scrolling dialog, a missing dialog and the role picker checks', () => {
    expect(dialog({ newChat: { ...NEW_CHAT, pickerAbovePrompt: false } })).toEqual([
      'new-chat-picker: expected the Start a new chat dialog shows the role picker above the First prompt field; '
        + 'got {"title":"Start a new chat","pickerAbovePrompt":false,"scrolls":false}'
    ])
    expect(dialog({ newChat: { ...NEW_CHAT, scrolls: true } })).toEqual(['new-chat-picker: expected the dialog shows Start without scrolling'])
    expect(dialog({ newChat: null })).toHaveLength(2)
    expect(dialog({ rolePicker: { cards: [{ ...ROLE_CARDS[0], clipped: true }, ROLE_CARDS[1]] } })).toEqual([
      'new-chat-picker: expected no card clips its text or leaves the window'
    ])
  })
})

describe('capture-agent-chat: question-multi observations', () => {
  const question = (patch) => validateObservations('question-multi', ready('question-multi', { questionCard: { ...QUESTION, ...patch } }))

  it('passes Question 1 of 2 with Lint and Unit tests checked, 2 selected and Submit enabled', () => {
    expect(question({})).toEqual([])
  })

  it('fails missing progress, another selection, a wrong count, a disabled Submit and no card', () => {
    expect(question({ progress: null })).toEqual([expect.stringMatching(/^question-multi: expected a docked multi-select question headed Question 1 of 2/)])
    expect(question({ checked: ['Lint'] })).toEqual([expect.stringMatching(/^question-multi: expected Lint and Unit tests checked/)])
    expect(question({ count: '1 selected' })).toHaveLength(1)
    expect(question({ submitEnabled: false })).toEqual([expect.stringMatching(/^question-multi: expected an enabled Submit/)])
    expect(validateObservations('question-multi', ready('question-multi'))).toHaveLength(3)
  })
})

describe('capture-agent-chat: delivery observations', () => {
  const records = passingDeliveryStates()
  const without = (state, patch) => validateObservations(state, { ...records[state], observations: { ...records[state].observations, ...patch } })

  it('passes the delivery states and requires their observation fields', () => {
    for (const state of ['delivery-editor', 'delivery-pending', 'delivery-checkpoint']) expect(validateObservations(state, records[state])).toEqual([])
    for (const field of ['sprintDeliveryRegion', 'deliveryLine', 'deliveryApproval', 'previousDelivery', 'firstFailedCheck']) {
      const record = passingDeliveryStates()['delivery-checkpoint']
      delete record.observations[field]
      expect(validateObservations('delivery-checkpoint', record)).toEqual([`delivery-checkpoint: missing observation ${field}`])
    }
  })

  it('fails delivery-editor without the Sprint delivery region', () => {
    expect(without('delivery-editor', { sprintDeliveryRegion: false }))
      .toEqual(['delivery-editor: expected the acceptance node editor shows the Sprint delivery region'])
  })

  it('fails delivery-pending without the held line or with another first failed check', () => {
    expect(without('delivery-pending', { deliveryLine: null })).toEqual([
      `delivery-pending: expected the run bar reads ${HELD}; got null`
    ])
    expect(without('delivery-pending', { firstFailedCheck: 'Release contains it: missing' })).toEqual([
      `delivery-pending: expected the first failed check reads ${STALE_INSTALL}; got "Release contains it: missing"`
    ])
  })

  it('fails delivery-checkpoint without the approval note or the Previous sprint delivery region', () => {
    expect(without('delivery-checkpoint', { deliveryApproval: null }))
      .toEqual(['delivery-checkpoint: expected the gate’s Delivery on approval note holds Sprint 3'])
    expect(without('delivery-checkpoint', { previousDelivery: false, firstFailedCheck: null })).toEqual([
      'delivery-checkpoint: expected the Previous sprint delivery region',
      `delivery-checkpoint: expected the first failed check reads ${STALE_INSTALL}; got null`
    ])
  })

  it('holds the delivery states to the epic header and keeps them off the Agent tab checks', () => {
    expect(without('delivery-pending', { viewButtons: ['Graph'] }))
      .toEqual(['delivery-pending: expected the View buttons are Agent, Graph, List, Scorecard in order'])
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
