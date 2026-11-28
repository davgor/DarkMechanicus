/**
 * Captures the epic Agent tab's states unattended: `node scripts/capture-agent-chat.mjs --out <dir>` builds
 * `preview/epic-agent` once with the repo's Vite, serves the built page, opens each `?state=` in the repo's own
 * Electron (hidden windows, one temporary profile) and writes `<state>.png` per state plus `observations.json`. Any
 * launch failure, missed deadline, page error, missing observation or empty/small capture fails the run with its
 * reason; nothing is reported as skipped. The preview server, the Electron process tree, the build and the temporary
 * profile never outlive the run.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PREVIEW = join(REPO, 'preview', 'epic-agent')
const ELECTRON_ENTRY = join(REPO, 'scripts', 'capture-agent-chat.electron.cjs')

/** Every state the preview page knows, in capture order. A `-1024` or `-1440` state is captured at that width. */
export const STATES = Object.freeze([
  'graph', 'header-long', 'agent-empty', 'agent-streaming', 'agent-tool', 'agent-approval', 'agent-worker', 'agent-legacy-thread',
  'agent-tree', 'rail-collapsed', 'landing-notification', 'landing-activity', 'chat-rail', 'chat-rail-collapsed', 'agent-todos',
  'agent-todos-collapsed', 'agent-stalled', 'agent-changes', 'agent-approval-named', 'agent-magos-decided', 'agent-needs-you',
  'agent-planners', 'chat-rail-legacy',
  'agent-glass-1024', 'agent-glass-1440', 'agent-glass-solid', 'epic-agent-glass-1024', 'epic-agent-glass-1440',
  'agent-composer-1024', 'agent-composer-1440', 'chat-images', 'agent-role-picker-1024', 'agent-role-picker-1440',
  'epic-agent-picker', 'new-chat-picker', 'question-multi', 'question-form-1024', 'question-form-1440', 'agent-transcript',
  'agent-worked-for', 'image-result', 'agent-image-viewer',
  'agent-image-evidence', 'mail-card', 'epic-agent-tabs-1024', 'epic-agent-tabs-1440', 'model-picker', 'model-picker-epic',
  'new-chat-model', 'start-run-model', 'lexmechanic-model',
  'settings-notifications', 'delivery-editor', 'delivery-pending', 'delivery-checkpoint',
  'browser-empty-1024', 'browser-empty-1440', 'browser-agent-1024', 'browser-agent-1440', 'browser-person-1024', 'browser-person-1440',
  'browser-stopped-1024', 'browser-stopped-1440', 'browser-private-1024', 'browser-private-1440'
])

/**
 * The Sprint 3 image and polish states every capture run must write, as the review asks for them. Sprint 3's
 * agent-glass (the epic stage's glass) is captured as epic-agent-glass-1440 since the folder chat took that name.
 */
export const S3_STATES = Object.freeze([
  'chat-images', 'image-result', 'epic-agent-glass-1440', 'agent-composer-1024', 'agent-composer-1440', 'agent-transcript',
  'agent-worked-for',
  'agent-role-picker-1024', 'agent-role-picker-1440', 'epic-agent-picker', 'new-chat-picker', 'question-multi', 'mail-card',
  'model-picker', 'epic-agent-tabs-1024', 'epic-agent-tabs-1440'
])

/** Per state, from loading its URL to `#observations[data-ready="1"]`. */
export const STATE_DEADLINE_MS = 15_000
/**
 * A declared bound for building the preview once, before the states' clock starts. A dev server transformed the page's
 * module graph on demand inside the first state's deadline, so that state's time depended on the machine's load; the
 * built page is one bundled script. The build took about 4 s on a quiet Windows host; the bound allows 15 times that.
 */
export const BUILD_LIMIT_MS = 60_000
/** A declared bound once the preview is built: 65 states at up to 15 s each, plus the preview server and Electron start. */
export const OVERALL_LIMIT_MS = 990_000
export const MIN_PNG_BYTES = 10 * 1024
/** Fewer distinct colours than this among a capture's sampled pixels is a blank page. */
export const MIN_COLORS = 16

/** The fixed window sizes of the `-1024` and `-1440` states. */
const SIZED = Object.freeze({ 1024: Object.freeze({ width: 1024, height: 768 }), 1440: Object.freeze({ width: 1440, height: 900 }) })
const SIZE_SUFFIX = /-(1024|1440)$/

/** The preview state a capture state shows: a sized state shows its unsized one. */
const baseState = (state) => state.replace(SIZE_SUFFIX, '')

/** The window size a state is captured at: its own for a sized state, else the run's. */
export function viewportOf(state, viewport = DEFAULT_VIEWPORT) {
  const match = SIZE_SUFFIX.exec(state)
  return match === null ? viewport : SIZED[match[1]]
}

/**
 * The CSS media features a state is captured under, for CDP `Emulation.setEmulatedMedia`: a `-solid` state emulates
 * reduced transparency, every other none.
 */
export function mediaOf(state) {
  return state.endsWith('-solid') ? [{ name: 'prefers-reduced-transparency', value: 'reduce' }] : []
}

/** Inherited variables that would change how Electron starts: `ELECTRON_RUN_AS_NODE=1` alone runs it as plain Node. */
const STRIPPED_ENV = /^(?:ELECTRON_.*|NODE_OPTIONS|DM_SESSION_TOKEN|DM_DESKTOP_PIPE|DM_BROWSER_PIPE)$/i

/** The window's content size when `--viewport` is not given: the ticket's 1280×800. */
export const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 800 })

function parseViewport(value) {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(value ?? '')
  if (match === null) throw new Error(`--viewport takes WIDTHxHEIGHT, such as 1024x768; got ${value}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

export function parseArgs(argv) {
  let out = null
  let viewport = DEFAULT_VIEWPORT
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg.startsWith('--out=')) out = arg.slice('--out='.length)
    else if (arg === '--out') out = argv[++index] ?? null
    else if (arg.startsWith('--viewport=')) viewport = parseViewport(arg.slice('--viewport='.length))
    else if (arg === '--viewport') viewport = parseViewport(argv[++index])
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (out === null || out.trim() === '') throw new Error('Usage: node scripts/capture-agent-chat.mjs --out <dir>')
  return { out: resolve(out), viewport }
}

/** A copy of `env` without the variables that would redirect Electron or hand it the app's session. */
export function electronEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !STRIPPED_ENV.test(key)))
}

const BASE_FIELDS = [
  'viewButtons', 'agentFontWeight', 'header', 'planGraph', 'planList', 'scorecard', 'agentChatRegion', 'railWidth', 'railRightOfStage',
  'treeRows', 'finishedExpandedAtStart', 'todosHeader', 'todoRows', 'todoListScrolls', 'activeRowVisible', 'activityLine',
  'changesHeader', 'cardHeading', 'needsYouHeader', 'badgedRows', 'ticketPanel', 'settingsControls', 'agentsPressed',
  'sprintDeliveryRegion', 'deliveryLine', 'deliveryApproval', 'previousDelivery', 'firstFailedCheck',
  'imageChips', 'thumbnails', 'composerHeights', 'copyButtons', 'workedForRows', 'roleNames', 'checkedCount', 'browserPanel', 'errors'
]
const VIEW_BUTTONS = ['Agent', 'Graph', 'List', 'Scorecard']
/** States outside the epic workspace: the standalone chats, the settings form, the role picker and the New chat dialog. */
const CHAT_STATES = new Set([
  'chat-rail', 'chat-rail-collapsed', 'chat-rail-legacy', 'agent-composer', 'chat-images', 'agent-transcript', 'agent-worked-for',
  'image-result', 'agent-image-viewer', 'mail-card', 'settings-notifications', 'agent-role-picker', 'new-chat-picker', 'model-picker',
  'new-chat-model', 'agent-glass', 'agent-glass-solid'
])
const EPIC_STATES = new Set(STATES.filter((state) => !CHAT_STATES.has(baseState(state))))
/** Epic states over the plan, the draft editor or the checkpoint rather than the Agent tab. */
const PLAN_STATES = new Set(['graph', 'header-long', 'delivery-editor', 'delivery-pending', 'delivery-checkpoint'])
const AGENT_STATES = new Set([...EPIC_STATES].filter((state) => !PLAN_STATES.has(state)))
/** The seeded Sprint 1 delivery check's failure, as the delivery states report their first failed check. */
const STALE_INSTALL = 'Installed app version: 0.49.0 is older than 0.50.0'

const near = (value, target) => typeof value === 'number' && Math.abs(value - target) <= 1
const rowNamed = (o, name) => Array.isArray(o.treeRows) && o.treeRows.find((row) => row.name === name)
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value)
/** The alpha of a computed `rgb()`/`rgba()` color; null for anything else. */
const alphaOf = (color) => {
  const match = /^rgba?\([^,]+,[^,]+,[^,)]+(?:,\s*([\d.]+))?\)$/.exec(typeof color === 'string' ? color : '')
  return match === null ? null : match[1] === undefined ? 1 : Number(match[1])
}
/** A frosted surface: a translucent background (at most 0.72 alpha) under a backdrop blur. */
const frosted = (surface) => matches(surface?.backdropFilter, /blur\(\d+px\)/) && alphaOf(surface?.background) > 0
  && alphaOf(surface?.background) <= 0.72
/** A solid surface, as the glass fallbacks paint it: an opaque background and no backdrop filter. */
const solid = (surface) => alphaOf(surface?.background) === 1 && surface?.backdropFilter === 'none'
/** The panes every glass state measures, by their key in the glass observations. */
const GLASS_PANES = [['header', 'the chat header'], ['rail', 'the agent rail'], ['transcript', 'the transcript pane']]
/** A pane's surface carries the alpha the page read off its computed background. */
const reportsAlpha = (surface) => typeof surface?.alpha === 'number' && surface.alpha === alphaOf(surface.background)
/** The backdrop glows behind the glass, with transparency as the person left it. */
const GLASS_STAGE_CHECKS = [
  ['the stage paints the brass and crimson radial glows', (o) => matches(o.glass?.backdrop, /radial-gradient.*radial-gradient/), (o) => o.glass?.backdrop],
  ['transparency is not reduced', (o) => o.glass?.reducedTransparency === false, (o) => JSON.stringify(o.glass?.reducedTransparency)],
  ['the rail is open at 280 px right of the chat', (o) => near(o.railWidth, 280) && o.railRightOfStage === true,
    (o) => JSON.stringify([o.railWidth, o.railRightOfStage])],
  ...GLASS_PANES.map(([key, name]) => [`${name} is frosted glass (a blur, alpha 0.72 or less) and reports its alpha`,
    (o) => frosted(o.glass?.[key]) && reportsAlpha(o.glass[key]), (o) => JSON.stringify(o.glass?.[key])])
]
/** A role-picker state's cards as the page measured them; empty when it reported none. */
const roleCards = (o) => Array.isArray(o.rolePicker?.cards) ? o.rolePicker.cards : []
/** Each role card as [name, checked, disabled reason], for the epic Agent tab's picker states. */
const cardStates = (o) => JSON.stringify(roleCards(o).map((card) => [card.name, card.checked, card.reason ?? null]))
/** What every shown role picker must hold: two labelled illustrations, frosted cards and no clipped text. */
const ROLE_CARD_CHECKS = [
  ['each card holds its own labelled illustration, at least 96 px square', (o) => roleCards(o).length === 2
    && new Set(roleCards(o).map((card) => card.art)).size === 2
    && roleCards(o).every((card) => matches(card.art, new RegExp(`^${card.name}: \\S`)) && card.artWidth >= 96 && card.artHeight >= 96),
  (o) => JSON.stringify(roleCards(o).map((card) => [card.art, card.artWidth, card.artHeight]))],
  ['both cards are frosted glass', (o) => roleCards(o).length === 2 && roleCards(o).every(frosted)],
  ['no card clips its text or leaves the window', (o) => roleCards(o).length === 2 && roleCards(o).every((card) => card.clipped === false)],
  ['the role names read Magos then Lexmechanic', (o) => JSON.stringify(o.roleNames) === '["Magos","Lexmechanic"]', (o) => JSON.stringify(o.roleNames)]
]
/** The agent-composer state's composers, or none. */
const composersOf = (o) => Array.isArray(o.composers) ? o.composers : []
/** Which of Send and Stop a composer shows: `send`, `stop`, `both` or `none`. */
const composerButtons = (card) => card?.send && card?.stop ? 'both' : card?.send ? 'send' : card?.stop ? 'stop' : 'none'
const round = (button) => button?.radius === '50%' && near(button.width, 32) && near(button.height, 32)
const square = (button) => button?.radius === '8px' && near(button.width, 32) && near(button.height, 32)
/** The image-result transcript's thumbnails as the page measured them; empty when it reported none. */
const thumbsOf = (o) => Array.isArray(o.chatImages?.thumbs) ? o.chatImages.thumbs : []
/** Each thumbnail as [under whose item, name, loaded]: the person's two (the second's file gone), then the tool's one. */
const IMAGE_THUMBS = [
  ['you', 'Image from you, 1280x800', true], ['you', 'Image from you, 1024x768 (image missing)', false],
  ['tool', 'Image from agent, 1440x900', true]
]
/**
 * What both image-result states show: thumbnails under the bubble and the tool card, lazy dm-chat-image: pictures, ≤160 px,
 * and, in a chat outside any epic, no Attach as evidence.
 */
const IMAGE_RESULT_CHECKS = [
  ['two thumbnails under the person’s bubble, the gone one a placeholder, and one under the tool card',
    (o) => JSON.stringify(thumbsOf(o).map((thumb) => [thumb.under, thumb.name, thumb.loaded])) === JSON.stringify(IMAGE_THUMBS),
    (o) => JSON.stringify(thumbsOf(o).map((thumb) => [thumb.under, thumb.name, thumb.loaded]))],
  ['every loaded thumbnail is a lazy dm-chat-image: picture', (o) => thumbsOf(o).length === 3
    && thumbsOf(o).filter((thumb) => thumb.loaded).every((thumb) => thumb.scheme === 'dm-chat-image:' && thumb.lazy === true),
  (o) => JSON.stringify(thumbsOf(o).map((thumb) => [thumb.scheme, thumb.lazy]))],
  ['every thumbnail at most 160 px wide', (o) => thumbsOf(o).length === 3 && thumbsOf(o).every((thumb) => thumb.width > 0 && thumb.width <= 160),
    (o) => JSON.stringify(thumbsOf(o).map((thumb) => thumb.width))],
  ['no Attach as evidence outside an epic', (o) => Array.isArray(o.chatImages?.evidence) && o.chatImages.evidence.length === 0,
    (o) => JSON.stringify(o.chatImages?.evidence)]
]
/** The question-form state's questions as the card heads them: the checkbox group and the text field are optional. */
const FORM_LEGENDS = ['Which databases? (optional)', 'Which region?', 'Anything else? (optional)']
/** At 1440 the form shows every question and checked default without scrolling. */
const formAllInView = (card) => JSON.stringify(card?.legendsInView) === JSON.stringify(FORM_LEGENDS) && card.fieldsScroll === false
  && JSON.stringify(card.checkedInView) === '["SQLite","Postgres","US"]'
/** At 1024 the fields scroll inside the card, the first question and its two defaults in view. */
const formScrollsInCard = (card) => card?.legendsInView?.[0] === FORM_LEGENDS[0] && card.fieldsScroll === true
  && JSON.stringify(card.checkedInView?.slice(0, 2)) === '["SQLite","Postgres"]'

/**
 * The agent-tree state's shipped tree in document order, as [name, level, parent]: the Magos root, its live workers
 * (Acolyte:DM-2 with its own Inquisitor:DM-2, then Servitor-1) and last the Finished group, which holds Acolyte:DM-1.
 */
const AGENT_TREE_LEVELS = [
  ['Magos', 1, null], ['Acolyte:DM-2', 2, 'Magos'], ['Inquisitor:DM-2', 3, 'Acolyte:DM-2'], ['Servitor-1', 2, 'Magos'],
  ['Finished 1', 2, 'Magos'], ['Acolyte:DM-1', 3, 'Finished 1']
]

/** Where a tree row sits: its aria-level and its parent, the nearest row before it one level up (rows are in document order). */
function placement(o, name) {
  const rows = Array.isArray(o.treeRows) ? o.treeRows : []
  const index = rows.findIndex((row) => row.name === name)
  if (index < 0) return null
  const { level } = rows[index]
  const parent = rows.slice(0, index).findLast((row) => row.level === level - 1)
  return { level, parent: level === 1 ? null : parent?.name ?? null }
}

const describePlacement = (where) => where === null ? 'no such row' : `level ${where.level} under ${where.parent ?? 'no parent'}`

/** One check per agent-tree node: its tree level and parent, reporting where the capture placed it on a mismatch. */
const treeLevelChecks = AGENT_TREE_LEVELS.map(([name, level, parent]) => [
  `${name} at level ${level} under ${parent ?? 'no parent'}`,
  (o) => { const where = placement(o, name); return where !== null && where.level === level && where.parent === parent },
  (o) => describePlacement(placement(o, name))
])

/** What the role picker shows wherever it is captured: Magos checked first, both illustrated glass cards, nothing clipped. */
const ROLE_PICKER_CHECKS = [
  ['the radios are Magos (checked) then Lexmechanic', (o) => JSON.stringify(roleCards(o).map((card) => [card.name, card.checked]))
    === '[["Magos",true],["Lexmechanic",false]]', (o) => JSON.stringify(roleCards(o).map((card) => [card.name, card.checked]))],
  ...ROLE_CARD_CHECKS
]

/** Both model-picker states: the chip on Opus 5.5 · High before Send, an upward glass menu nothing clips, Effort Low to Max. */
const MODEL_PICKER_CHECKS = [
  ['the chip reads Opus 5.5 · High just left of Send', (o) => o.modelPicker?.chip === 'Opus 5.5 · High' && o.modelPicker?.beforeSend === true,
    (o) => JSON.stringify([o.modelPicker?.chip, o.modelPicker?.beforeSend])],
  ['the menu opens upward from the chip, inside the window and below the top of whatever clips it',
    (o) => o.modelPicker?.upward === true && o.modelPicker?.inWindow === true && o.modelPicker?.unclipped === true,
    (o) => JSON.stringify([o.modelPicker?.upward, o.modelPicker?.inWindow, o.modelPicker?.unclipped])],
  ['the Effort control lists Low to Max with High checked', (o) => JSON.stringify(o.modelPicker?.efforts)
    === JSON.stringify(['Low', 'Medium', 'High', 'XHigh', 'Max'].map((label) => ({ label, checked: label === 'High' }))),
  (o) => JSON.stringify(o.modelPicker?.efforts)],
  ['the menu is blurred glass', (o) => matches(o.modelPicker?.surface?.backdropFilter, /blur\(\d+px\)/) && alphaOf(o.modelPicker?.surface?.background) > 0,
    (o) => JSON.stringify(o.modelPicker?.surface)]
]
const LATEST_MODELS = [
  { label: 'Claude', models: ['Fable 5.2', 'Haiku 5.5', 'Mythos 5.2', 'Opus 5.5', 'Sonnet 5.5'] },
  { label: 'Codex', models: ['GPT-6 Astra', 'GPT-6 Luna', 'GPT-6.1 Sol', 'GPT-6.1 Terra'] }
]
const EFFORTS = ['Low', 'Medium', 'High', 'XHigh', 'Max']

/**
 * A start surface's Model field (New chat, Start run, the Lexmechanic card) after `model` at `effort` was chosen and the
 * chip opened again: the field and chip, an upward glass menu nothing clips, Default above the latest of each line,
 * and the choice checked.
 */
function startModelChecks(label, dialog, model, effort) {
  const chip = `${model} · ${effort}`
  return [
    [`the ${label} field ${dialog === null ? 'under the role cards' : `in the ${dialog} dialog`} reads ${chip}`,
      (o) => o.modelChoice?.label === label && o.modelChoice.dialog === dialog && o.modelPicker?.chip === chip,
      (o) => JSON.stringify([o.modelChoice, o.modelPicker?.chip])],
    MODEL_PICKER_CHECKS[1],
    MODEL_PICKER_CHECKS[3],
    ['Default leads the latest Claude and Codex groups', (o) => JSON.stringify(o.modelPicker?.groups?.slice(0, 3))
      === JSON.stringify([{ label: 'Default', models: ['Default'] }, ...LATEST_MODELS]), (o) => JSON.stringify(o.modelPicker?.groups)],
    [`${model} is checked, with Effort ${effort} of Low to Max`, (o) => JSON.stringify(o.modelPicker?.checked) === JSON.stringify([model])
      && JSON.stringify(o.modelPicker?.efforts) === JSON.stringify(EFFORTS.map((level) => ({ label: level, checked: level === effort }))),
    (o) => JSON.stringify([o.modelPicker?.checked, o.modelPicker?.efforts])]
  ]
}

/** The agent tab's fixture page title, and the private tab's label (red-team Fix 55) beside it. */
const BROWSER_TAB = 'Getting started · Fixture docs'
const PRIVATE_TAB = "Private tab (agents can't see this; sign-ins here don't carry over)"
/**
 * What every Browser state shows: the rail widened to max(420 px, 45% of the stage), the ownership badge, Stop agent
 * enabled only while an agent drives, and the toggle reading Take control or Hand back.
 */
function browserChecks(badge, { stop, toggle, tabs = [BROWSER_TAB] }) {
  const panel = (o) => o.browserPanel ?? {}
  return [
    ['the rail is open at max(420 px, 45% of the stage)', (o) => typeof panel(o).stageWidth === 'number'
      && near(o.railWidth, Math.max(420, 0.45 * panel(o).stageWidth)), (o) => JSON.stringify([o.railWidth, panel(o).stageWidth])],
    [`the badge reads ${badge}`, (o) => panel(o).badge === badge, (o) => JSON.stringify(panel(o).badge)],
    [`Stop agent is ${stop ? 'enabled' : 'disabled'}`, (o) => panel(o).stopEnabled === stop, (o) => JSON.stringify(panel(o).stopEnabled)],
    [`the toggle reads ${toggle}`, (o) => panel(o).toggle === toggle, (o) => JSON.stringify(panel(o).toggle)],
    [`the tab strip reads ${JSON.stringify(tabs)}`, (o) => JSON.stringify(panel(o).tabs) === JSON.stringify(tabs), (o) => JSON.stringify(panel(o).tabs)]
  ]
}

/** What each state must show, beyond the fields every state reports: [description, check, observed?]. */
const STATE_CHECKS = {
  graph: [['the Plan graph is present', (o) => o.planGraph === true], ['no Agent chat region', (o) => o.agentChatRegion === false]],
  'header-long': [
    ['the Plan graph is present', (o) => o.planGraph === true],
    ['the long breadcrumb and title truncate', (o) => o.header?.crumbTruncated === true && o.header?.titleTruncated === true]
  ],
  'agent-empty': [
    ['no plan graph, list or scorecard', (o) => !o.planGraph && !o.planList && !o.scorecard],
    ['the Magos card shows the active run’s reason and Lexmechanic is checked', (o) => cardStates(o)
      === '[["Magos",false,"A run is active; its Magos is in the list"],["Lexmechanic",true,null]]', cardStates]
  ],
  'epic-agent-picker': [
    ['the empty Agent tab’s radios are Magos (checked) then Lexmechanic, both enabled', (o) => cardStates(o)
      === '[["Magos",true,null],["Lexmechanic",false,null]]', cardStates],
    ...ROLE_CARD_CHECKS
  ],
  'agent-tool': [['the tree lists Magos and the subagent Acolyte:DM-785', (o) => rowNamed(o, 'Magos') && rowNamed(o, 'Acolyte:DM-785')]],
  'agent-approval': [['a docked card heading', (o) => matches(o.cardHeading, /wants to run/)]],
  'agent-worker': [['Acolyte:DM-2 is selected', (o) => rowNamed(o, 'Acolyte:DM-2')?.selected === true]],
  'agent-legacy-thread': [
    ['the legacy parent Servitor-2 is selected beside its nested Servitor-3 and the stamped Servitor-1, each named once',
      (o) => rowNamed(o, 'Servitor-2')?.selected === true && rowNamed(o, 'Servitor-3') && rowNamed(o, 'Servitor-1')
        && new Set(o.treeRows.map((row) => row.name)).size === o.treeRows.length]
  ],
  'agent-tree': [
    ['railWidth is 280±1', (o) => near(o.railWidth, 280)],
    ['the Finished 1 group is collapsed by default', (o) => o.finishedExpandedAtStart === false],
    ...treeLevelChecks
  ],
  'rail-collapsed': [['railWidth is 40±1', (o) => near(o.railWidth, 40)]],
  'landing-notification': [
    ['railWidth is 280±1 with no Expand click', (o) => near(o.railWidth, 280)],
    ['Acolyte:DM-2 is selected', (o) => rowNamed(o, 'Acolyte:DM-2')?.selected === true]
  ],
  'landing-activity': [
    ['railWidth is 280±1 with no Expand click', (o) => near(o.railWidth, 280)],
    ['no ticket panel over the rail', (o) => o.ticketPanel === false],
    ['Acolyte:DM-1 is selected inside the opened Finished 1 group',
      (o) => rowNamed(o, 'Acolyte:DM-1')?.selected === true && placement(o, 'Acolyte:DM-1')?.parent === 'Finished 1',
      (o) => describePlacement(placement(o, 'Acolyte:DM-1'))]
  ],
  'chat-rail': [
    ['the Chat agents rail is right of the chat', (o) => o.railRightOfStage === true],
    ['Inquisitor:DM-2 is selected', (o) => rowNamed(o, 'Inquisitor:DM-2')?.selected === true]
  ],
  'chat-rail-collapsed': [
    ['no Chat agents rail', (o) => o.railWidth === null],
    ['the Agents toggle reads collapsed', (o) => o.agentsPressed === 'false']
  ],
  'chat-rail-legacy': [
    ['the Chat agents rail is right of the chat', (o) => o.railRightOfStage === true],
    ['the legacy and stamped helpers are Servitor-2 (selected) and Servitor-1, each named once',
      (o) => rowNamed(o, 'Servitor-2')?.selected === true && rowNamed(o, 'Servitor-1')
        && new Set(o.treeRows.map((row) => row.name)).size === o.treeRows.length]
  ],
  'agent-todos': [
    ['a To-dos header', (o) => matches(o.todosHeader, /To-dos/)],
    ['task rows', (o) => o.todoRows > 5],
    ['the task list scrolls', (o) => o.todoListScrolls === true],
    ['the active row is inside the list', (o) => o.activeRowVisible === true],
    ['the activity line reads Working … · Bash', (o) => matches(o.activityLine, /^Working .* · Bash$/)]
  ],
  'agent-todos-collapsed': [
    ['the collapsed header shows the active task', (o) => matches(o.todosHeader, /Implementing the card/)],
    ['no task rows', (o) => o.todoRows === 0]
  ],
  'agent-stalled': [['the activity line reads No activity for 31s', (o) => matches(o.activityLine, /^No activity for 31s(?!\d)/)]],
  'agent-changes': [['the Changes header lists 2 files', (o) => o.changesHeader === 'Changes · 2 files']],
  'agent-approval-named': [
    ['the card is headed Acolyte:DM-442 wants to run: npm test', (o) => o.cardHeading === 'Acolyte:DM-442 wants to run: npm test'],
    ['the card says The Magos asks you', (o) => matches(o.cardArbitration, /^The Magos asks you: \S/)]
  ],
  'agent-glass': GLASS_STAGE_CHECKS,
  'epic-agent-glass': [
    ...GLASS_STAGE_CHECKS,
    ['the Magos tab is selected and joined to the glass header', (o) => matches(o.agentTabs?.tabs?.find((tab) => tab.selected)?.name, /^Magos(?:,|$)/)
      && o.agentTabs.activeJoined === true, (o) => JSON.stringify(o.agentTabs)],
    ['the docked approval card is frosted glass', (o) => matches(o.cardHeading, /wants to run/) && frosted(o.glass?.card),
      (o) => JSON.stringify(o.glass?.card)]
  ],
  'agent-glass-solid': [
    ['the page matches reduced transparency', (o) => o.glass?.reducedTransparency === true, (o) => JSON.stringify(o.glass?.reducedTransparency)],
    ['the rail is open at 280 px right of the chat', (o) => near(o.railWidth, 280) && o.railRightOfStage === true,
      (o) => JSON.stringify([o.railWidth, o.railRightOfStage])],
    ...GLASS_PANES.map(([key, name]) => [`${name} is a solid panel (alpha 1, no backdrop filter) and reports its alpha`,
      (o) => solid(o.glass?.[key]) && reportsAlpha(o.glass[key]), (o) => JSON.stringify(o.glass?.[key])])
  ],
  'agent-role-picker': ROLE_PICKER_CHECKS,
  'new-chat-picker': [
    ['the Start a new chat dialog shows the role picker above the First prompt field',
      (o) => o.newChat?.title === 'Start a new chat' && o.newChat.pickerAbovePrompt === true, (o) => JSON.stringify(o.newChat)],
    ['the dialog shows Start without scrolling', (o) => o.newChat?.scrolls === false],
    ...ROLE_PICKER_CHECKS
  ],
  'agent-magos-decided': [
    ['the record reads Asked by Acolyte:DM-442 and Denied by the Magos with its reason',
      (o) => matches(o.approvalRecord, /Asked by Acolyte:DM-442/) && matches(o.approvalRecord, /Denied by the Magos/)
        && matches(o.approvalRecord, /The Magos decided: \S/)]
  ],
  'agent-needs-you': [
    ['the header reads 4 needs you, the Magos’s browser site among them', (o) => matches(o.needsYouHeader, /^4 needs you/)],
    ['four badged rows, the unwatched planner’s and the Magos’s among them', (o) => o.badgedRows === 4]
  ],
  'agent-composer': [
    ['two composers: the idle one with Send and no Stop, the busy one with Stop and no Send',
      (o) => Array.isArray(o.composers) && o.composers.length === 2 && composerButtons(o.composers[0]) === 'send'
        && composerButtons(o.composers[1]) === 'stop',
      (o) => JSON.stringify(o.composers?.map(composerButtons))],
    ['each composer is a frosted glass card rounded 16 px or more, at most 760 px wide',
      (o) => composersOf(o).every((card) => frosted(card) && parseFloat(card.radius) >= 16 && card.width <= 760),
      (o) => JSON.stringify(composersOf(o).map(({ radius, background, backdropFilter, width }) => ({ radius, background, backdropFilter, width })))],
    ['a round 32 px Send and a square 32 px Stop', (o) => round(composersOf(o)[0]?.send) && square(composersOf(o)[1]?.stop),
      (o) => JSON.stringify([composersOf(o)[0]?.send, composersOf(o)[1]?.stop])],
    ['both composers chip the agent, the context and 2 queued', (o) => composersOf(o).length === 2 && composersOf(o).every((card) =>
      JSON.stringify(card.chips) === JSON.stringify(['Magos · Skitarii', 'dark-mechanicus', '2 queued'])),
      (o) => JSON.stringify(composersOf(o).map((card) => card.chips))],
    ['the idle draft grew to two lines and the empty busy composer holds one', (o) => composersOf(o)[0]?.lines === 2
      && composersOf(o)[1]?.lines === 1, (o) => JSON.stringify(composersOf(o).map((card) => card.lines))],
    ['both placeholders reply to the Magos', (o) => composersOf(o).every((card) => card.placeholder === 'Reply to Magos…')],
    ['the idle composer stands taller than the busy one', (o) => o.composerHeights?.busy > 0 && o.composerHeights.idle > o.composerHeights.busy,
      (o) => JSON.stringify(o.composerHeights)]
  ],
  'chat-images': [
    ['four image chips and no transcript thumbnail', (o) => o.imageChips === 4 && o.thumbnails === 0,
      (o) => JSON.stringify([o.imageChips, o.thumbnails])],
    ['one composer holding four loaded image thumbnails, each removable', (o) => composersOf(o).length === 1
      && composersOf(o)[0].images?.chips === 4 && composersOf(o)[0].images?.loaded === 4 && composersOf(o)[0].images?.removable === 4,
      (o) => JSON.stringify(composersOf(o).map((card) => card.images))],
    ['the chips sit inside the card above the text area', (o) => composersOf(o)[0]?.images?.aboveText === true],
    ['a round "+" attach button leads the row', (o) => composersOf(o)[0]?.attach?.radius === '50%',
      (o) => JSON.stringify(composersOf(o)[0]?.attach)],
    ['Send is enabled with the images', (o) => composerButtons(composersOf(o)[0]) === 'send' && composersOf(o)[0]?.sendEnabled === true],
    ['the fifth image is refused inline', (o) => composersOf(o)[0]?.images?.alert === 'At most 4 images can go with one message.',
      (o) => JSON.stringify(composersOf(o)[0]?.images?.alert)]
  ],
  'question-multi': [
    ['a docked multi-select question with its legend and no step counter', (o) => o.questionCard?.progress === null
      && matches(o.questionCard?.legend, /\S/), (o) => JSON.stringify(o.questionCard)],
    ['Lint and Unit tests checked among the checkboxes, reading 2 selected', (o) => o.questionCard?.checkboxes >= 2
      && JSON.stringify(o.questionCard?.checked) === '["Lint","Unit tests"]' && o.questionCard?.count === '2 selected',
    (o) => JSON.stringify(o.questionCard)],
    ['an enabled Submit', (o) => o.questionCard?.submitEnabled === true, (o) => JSON.stringify(o.questionCard)],
    ['two options checked', (o) => o.checkedCount === 2, (o) => JSON.stringify(o.checkedCount)],
    ['both checked options in view in the option list', (o) => JSON.stringify(o.questionCard?.checkedInView) === '["Lint","Unit tests"]',
      (o) => JSON.stringify(o.questionCard)],
    ['Submit in view', (o) => o.questionCard?.submitInView === true, (o) => JSON.stringify(o.questionCard)],
    ['the transcript keeps at least its declared minimum height beside the card', (o) => o.questionCard?.transcriptMin > 0
      && o.questionCard?.transcriptHeight >= o.questionCard?.transcriptMin, (o) => JSON.stringify(o.questionCard)]
  ],
  'question-form': [
    ['one docked glass-strong card headed Answer 3 questions', (o) => o.formCard?.cards === 1 && o.formCard.glassStrong === true
      && o.formCard.heading === 'Answer 3 questions', (o) => JSON.stringify(o.formCard)],
    ['every question at once: a checkbox group, a radio group and a text field under their legends', (o) =>
      JSON.stringify(o.formCard?.legends) === JSON.stringify(FORM_LEGENDS) && JSON.stringify(o.formCard?.kinds) === '["checkbox","radio","text"]',
    (o) => JSON.stringify([o.formCard?.legends, o.formCard?.kinds])],
    ['the defaults checked: SQLite and Postgres, and US', (o) => JSON.stringify(o.formCard?.checked) === '[["SQLite","Postgres"],["US"],[]]',
      (o) => JSON.stringify(o.formCard?.checked)],
    ['one enabled Submit, reading 3 of 3 answered', (o) => o.formCard?.submits === 1 && o.formCard.submitEnabled === true
      && o.formCard.count === '3 of 3 answered', (o) => JSON.stringify(o.formCard)],
    ['at 1440 every question and checked default in view without scrolling; at 1024 the fields scroll inside the card with the first question and its defaults in view',
      (o) => o.state?.endsWith('-1440') ? formAllInView(o.formCard) : formScrollsInCard(o.formCard),
      (o) => JSON.stringify([o.formCard?.legendsInView, o.formCard?.fieldsScroll, o.formCard?.checkedInView])],
    ['Submit in view', (o) => o.formCard?.submitInView === true, (o) => JSON.stringify(o.formCard)],
    ['the transcript keeps at least its declared minimum height beside the card', (o) => o.formCard?.transcriptMin > 0
      && o.formCard?.transcriptHeight >= o.formCard?.transcriptMin, (o) => JSON.stringify(o.formCard)]
  ],
  'model-picker': [
    ...MODEL_PICKER_CHECKS,
    ['Claude and Codex groups list the latest of each line', (o) => JSON.stringify(o.modelPicker?.groups) === JSON.stringify(LATEST_MODELS),
      (o) => JSON.stringify(o.modelPicker?.groups)],
    ['Opus 5.5 is checked and a collapsed More models expander follows the groups', (o) => JSON.stringify(o.modelPicker?.checked) === '["Opus 5.5"]'
      && o.modelPicker?.more?.name === 'More models' && o.modelPicker?.more?.expanded === 'false',
    (o) => JSON.stringify([o.modelPicker?.checked, o.modelPicker?.more])]
  ],
  'model-picker-epic': [
    ...MODEL_PICKER_CHECKS,
    ['the latest Claude and Codex groups, then More Claude and More Codex', (o) => JSON.stringify(o.modelPicker?.groups?.slice(0, 2))
      === JSON.stringify(LATEST_MODELS) && JSON.stringify(o.modelPicker?.groups?.slice(2).map((group) => group.label)) === '["More Claude","More Codex"]',
    (o) => JSON.stringify(o.modelPicker?.groups?.map((group) => group.label))],
    ['Opus 5.5 is checked and More models is expanded', (o) => JSON.stringify(o.modelPicker?.checked) === '["Opus 5.5"]'
      && o.modelPicker?.more?.expanded === 'true', (o) => JSON.stringify([o.modelPicker?.checked, o.modelPicker?.more])]
  ],
  'new-chat-model': [...startModelChecks('Model', 'Start a new chat', 'Sonnet 5.5', 'Low'), ...ROLE_PICKER_CHECKS],
  'start-run-model': startModelChecks('Model', 'Start run', 'GPT-6 Astra', 'High'),
  'lexmechanic-model': startModelChecks('Lexmechanic model', null, 'Opus 5.5', 'Max'),
  'epic-agent-tabs': [
    ['the tab strip reads Magos (selected, no ✕) then Lexmechanic (unread dot, ✕), above the chat', (o) => JSON.stringify(o.agentTabs?.tabs)
      === '[{"name":"Magos","selected":true,"unread":false,"closable":false},{"name":"Lexmechanic, 2 unread messages","selected":false,"unread":true,"closable":true}]'
      && o.agentTabs?.aboveChat === true, (o) => JSON.stringify(o.agentTabs)],
    ['the active tab is joined to the chat header: the same surface, rounded top corners', (o) => o.agentTabs?.activeJoined === true
      && o.agentTabs?.roundedTop === true, (o) => JSON.stringify(o.agentTabs)]
  ],
  'mail-card': [
    ['a received card then a sent card between the person’s message and the reply', (o) => JSON.stringify(o.mail?.rows)
      === '["item","mail","mail","item"]' && JSON.stringify(o.mail?.cards?.map((card) => card.direction)) === '["received","sent"]',
    (o) => JSON.stringify(o.mail)],
    ['headers read ✉ Lexmechanic → Magos and ✉ Magos → Lexmechanic', (o) => JSON.stringify(o.mail?.cards?.map((card) => card.head))
      === '["✉ Lexmechanic → Magos Received","✉ Magos → Lexmechanic Sent"]', (o) => JSON.stringify(o.mail?.cards?.map((card) => card.head))],
    ['the sent card names the message it answers', (o) => o.mail?.cards?.[1]?.reply === 'Reply to mm_plan14', (o) => JSON.stringify(o.mail?.cards?.[1])],
    ['bodies are plain text: <b> shows as typed and renders no element', (o) => o.mail?.cards?.every((card) => card.markup === false)
      && o.mail.cards[0].body.includes('<b>Not markup</b>'), (o) => JSON.stringify(o.mail?.cards)],
    ['showing the received card marks it seen once', (o) => Array.isArray(o.mail?.seen) && o.mail.seen.length === 1
      && o.mail.seen[0][0]?.chatId === 'fixture-magos' && o.mail.seen[0][0]?.throughSeq === 1, (o) => JSON.stringify(o.mail?.seen)]
  ],
  'agent-transcript': [
    ['a centred reading column at most 760 px wide', (o) => o.transcript?.columnWidth <= 760 && o.transcript.columnWidth >= 600
      && o.transcript.columnOffset <= 1, (o) => JSON.stringify([o.transcript?.columnWidth, o.transcript?.columnOffset])],
    ['the person’s message is a rounded bubble against the column’s right edge', (o) => parseFloat(o.transcript?.bubble?.radius) >= 12
      && alphaOf(o.transcript.bubble.background) > 0 && near(o.transcript.bubble.rightGap, 0) && o.transcript.bubble.leftGap > 40,
    (o) => JSON.stringify(o.transcript?.bubble)],
    ['the reply is plain text across the column, with no bubble', (o) => alphaOf(o.transcript?.reply?.background) === 0
      && o.transcript.reply.border === '0px' && near(o.transcript.reply.width, o.transcript.columnWidth), (o) => JSON.stringify(o.transcript?.reply)],
    ['the reply’s action row holds Copy', (o) => JSON.stringify(o.transcript?.replyActions) === '["Copy"]',
      (o) => JSON.stringify(o.transcript?.replyActions)],
    ['the bubble’s Copy shows under keyboard focus', (o) => o.transcript?.bubbleCopy === 'Copy' && o.transcript.bubbleCopyFocused === true,
      (o) => JSON.stringify([o.transcript?.bubbleCopy, o.transcript?.bubbleCopyFocused])],
    ['the code block’s Copy sits in its top-right corner', (o) => o.transcript?.codeCopy === 'Copy'
      && o.transcript.codeCopyCorner?.top <= 12 && o.transcript.codeCopyCorner.right <= 12,
    (o) => JSON.stringify([o.transcript?.codeCopy, o.transcript?.codeCopyCorner])],
    ['three Copy buttons: the bubble’s, the reply’s and the code block’s', (o) => o.copyButtons === 3, (o) => JSON.stringify(o.copyButtons)]
  ],
  'agent-worked-for': [
    ['a folded “Worked for 28m 51s” turn, then an opened “Worked for 4m 05s” turn',
      (o) => JSON.stringify(o.workedFor?.toggles) === '[["Worked for 28m 51s",false],["Worked for 4m 05s",true]]',
      (o) => JSON.stringify(o.workedFor?.toggles)],
    ['the folded row is followed by its final reply', (o) => o.workedFor?.afterFolded === 'Assistant', (o) => JSON.stringify(o.workedFor?.afterFolded)],
    ['the opened turn lists its tool cards in order, and no tool card shows outside it',
      (o) => JSON.stringify(o.workedFor?.openedTools) === '["Tool call: Read","Tool call: Edit","Tool call: Bash"]' && o.workedFor.toolsOutside === 0,
      (o) => JSON.stringify([o.workedFor?.openedTools, o.workedFor?.toolsOutside])],
    ['the Worked for rows read 28m 51s then 4m 05s', (o) => JSON.stringify(o.workedForRows) === '["Worked for 28m 51s","Worked for 4m 05s"]',
      (o) => JSON.stringify(o.workedForRows)]
  ],
  'image-result': [
    ...IMAGE_RESULT_CHECKS,
    ['three transcript thumbnails and no composer chip', (o) => o.thumbnails === 3 && o.imageChips === 0,
      (o) => JSON.stringify([o.thumbnails, o.imageChips])],
    ['no lightbox open', (o) => o.chatImages?.viewer === null]
  ],
  'agent-image-viewer': [
    ...IMAGE_RESULT_CHECKS,
    ['the lightbox shows the agent’s image loaded from dm-chat-image:, its Close focused', (o) => o.chatImages?.viewer?.name === 'Image from agent, 1440x900'
      && o.chatImages.viewer.scheme === 'dm-chat-image:' && o.chatImages.viewer.loaded === true && o.chatImages.viewer.closeFocused === true,
    (o) => JSON.stringify(o.chatImages?.viewer)]
  ],
  'agent-image-evidence': [
    ['the person’s image offers the epic and the DM-1 thread’s capture its ticket', (o) => JSON.stringify(o.chatImages?.evidence) === JSON.stringify([
      'Attach Image from you, 1440x900 as evidence to the epic', 'Attach Image from agent, 1280x800 as evidence to DM-1'
    ]), (o) => JSON.stringify(o.chatImages?.evidence)],
    ['the click asks main once for the capture on DM-1', (o) => Array.isArray(o.evidence?.requests) && o.evidence.requests.length === 1
      && o.evidence.requests[0]?.[0]?.imageId === 'ci_01m8e000000000000000000032' && o.evidence.requests[0][0].epicId === 'ep_1'
      && o.evidence.requests[0][0].ticketId === 'tk_1', (o) => JSON.stringify(o.evidence?.requests)],
    ['a toast confirms with the ticket key', (o) => o.evidence?.toast === 'Attached the image to DM-1 as evidence.', (o) => JSON.stringify(o.evidence?.toast)]
  ],
  'agent-planners': [
    ['the tree names the Magos and nine planners apart, Lexmechanic-2 selected', (o) => rowNamed(o, 'Magos')
      && rowNamed(o, 'Lexmechanic') && rowNamed(o, 'Lexmechanic-2')?.selected === true && rowNamed(o, 'Lexmechanic-9')
      && new Set(o.treeRows.map((row) => row.name)).size === o.treeRows.length]
  ],
  'settings-notifications': [['the controls have accessible names', (o) => Array.isArray(o.settingsControls)
    && o.settingsControls.length > 0 && o.settingsControls.every((name) => typeof name === 'string' && name.trim() !== '')]],
  'delivery-editor': [
    ['the acceptance node editor shows the Sprint delivery region', (o) => o.sprintDeliveryRegion === true]
  ],
  'delivery-pending': [
    ['the run bar reads Sprint 1 delivery to main: the latest check failed',
      (o) => o.deliveryLine === 'Sprint 1 delivery to main: the latest check failed', (o) => JSON.stringify(o.deliveryLine)],
    [`the first failed check reads ${STALE_INSTALL}`, (o) => o.firstFailedCheck === STALE_INSTALL, (o) => JSON.stringify(o.firstFailedCheck)]
  ],
  'delivery-checkpoint': [
    ['the gate’s Delivery on approval note holds Sprint 3', (o) => matches(o.deliveryApproval, /^After approval, Sprint 3 claims wait /)],
    ['the Previous sprint delivery region', (o) => o.previousDelivery === true],
    [`the first failed check reads ${STALE_INSTALL}`, (o) => o.firstFailedCheck === STALE_INSTALL, (o) => JSON.stringify(o.firstFailedCheck)]
  ],
  'browser-empty': [
    ...browserChecks('Idle', { stop: false, toggle: 'Take control', tabs: ['Agent tab'] }),
    ['agents are not let use the browser and the page area shows the empty state',
      (o) => o.browserPanel?.enabled === false && o.browserPanel.page === 'Agents open pages here. You will be asked before any new site loads.',
      (o) => JSON.stringify([o.browserPanel?.enabled, o.browserPanel?.page])]
  ],
  'browser-agent': browserChecks('Driven by: Acolyte:DM-442', { stop: true, toggle: 'Take control' }),
  'browser-person': browserChecks('You have control', { stop: false, toggle: 'Hand back' }),
  'browser-stopped': browserChecks('Stopped', { stop: false, toggle: 'Hand back' }),
  'browser-private': [
    ...browserChecks('Idle', { stop: false, toggle: 'Take control', tabs: [BROWSER_TAB, PRIVATE_TAB] }),
    ['Private tab’s inline address field holds the typed address', (o) => o.browserPanel?.privateAddress === 'https://accounts.example.com/login',
      (o) => JSON.stringify(o.browserPanel?.privateAddress)]
  ]
}

/** What every epic state must show, and the agent states besides: [description, applies, check]. */
const EPIC_CHECKS = [
  ['the View buttons are Agent, Graph, List, Scorecard in order', () => true,
    (o) => JSON.stringify(o.viewButtons) === JSON.stringify(VIEW_BUTTONS)],
  ['a bold Agent label', () => true, (o) => Number(o.agentFontWeight) >= 600],
  ['a one-line breadcrumb beside the View group, the heading holding its content, both names titled', () => true,
    (o) => o.header?.crumbOneLine === true && o.header.besideView === true && o.header.sameRow === true && o.header.contained === true
      && o.header.crumbTitle === o.header.crumb && o.header.titleTitle === o.header.title],
  ['an Agent chat region', (state) => AGENT_STATES.has(state), (o) => o.agentChatRegion === true],
  ['no plan graph, list or scorecard node', (state) => AGENT_STATES.has(state), (o) => !o.planGraph && !o.planList && !o.scorecard],
  ['the rail right of the stage', (state) => AGENT_STATES.has(state), (o) => o.railRightOfStage !== false]
]

function stateChecks(state) {
  const epic = EPIC_STATES.has(state) ? EPIC_CHECKS.filter(([, applies]) => applies(state)) : []
  return [...epic.map(([description, , check]) => [description, check]), ...STATE_CHECKS[baseState(state)] ?? []]
}

const failure = (o) => ([description, , observed]) => observed ? `expected ${description}; got ${observed(o)}` : `expected ${description}`

/** A record's own shape: data-ready, every observation field, the right state and no page errors. */
function shapeProblems(state, record) {
  if (!record || record.ready !== true) return [`#observations[data-ready="1"] never appeared${record?.error ? ` (${record.error})` : ''}`]
  const o = record.observations
  if (o === null || typeof o !== 'object') return ['the observations are not an object']
  const problems = BASE_FIELDS.filter((field) => !(field in o)).map((field) => `missing observation ${field}`)
  if (o.state !== state) problems.push(`observations are for "${o.state}"`)
  if (!Array.isArray(o.errors)) return [...problems, 'errors is not a list']
  return [...problems, ...o.errors.map((error) => `page error: ${error}`)]
}

/**
 * The reasons one state's capture record fails, empty when it passes: no `data-ready`, a missing observation, a
 * page error, or what the state must show.
 */
export function validateObservations(state, record) {
  const shape = shapeProblems(state, record)
  const problems = shape.length > 0
    ? shape
    : stateChecks(state).filter(([, check]) => !check(record.observations)).map(failure(record.observations))
  return problems.map((problem) => `${state}: ${problem}`)
}

function sameSize(page, viewport) {
  return page?.width === viewport.width && page?.height === viewport.height
}

/**
 * The reasons a captured image fails: an empty image, a PNG under 10 KB, a blank page (fewer than 16 distinct colours
 * among its sampled pixels), or a page whose CSS viewport (read from the fresh page itself) is not the requested size.
 */
export function validateCapture(state, record, viewport = DEFAULT_VIEWPORT) {
  if (!record || record.ready !== true) return []
  if (record.empty) return [`${state}: capturePage() returned an empty image`]
  const problems = []
  if (!(record.bytes >= MIN_PNG_BYTES)) problems.push(`${state}: the PNG is ${record.bytes} bytes, under ${MIN_PNG_BYTES}`)
  if (!(record.colors >= MIN_COLORS)) problems.push(`${state}: the capture is blank (${record.colors} distinct colours, under ${MIN_COLORS})`)
  if (!sameSize(record.viewport, viewport)) {
    problems.push(`${state}: the page viewport was ${record.viewport?.width}x${record.viewport?.height}, not ${viewport.width}x${viewport.height}`)
  }
  return problems
}

/**
 * Every reason the run fails, across all states; a state Electron never reported is a failure too. A sized state is
 * judged at its own size, every other one at the run's.
 */
export function runFailures(records, viewport = DEFAULT_VIEWPORT) {
  return STATES.flatMap((state) => {
    const record = records[state]
    if (record === undefined) return [`${state}: Electron reported nothing for this state`]
    return [...validateObservations(state, record), ...validateCapture(state, record, viewportOf(state, viewport))]
  })
}

function freePort() {
  const { promise, resolve: done, reject } = Promise.withResolvers()
  const server = createNetServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => done(port))
  })
  return promise
}

function killTree(child) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  else child.kill('SIGKILL')
}

/** The preview's own Vite config, building `agent.html` into `outDir` outside the repo. */
export function previewBuildConfig(outDir) {
  return {
    configFile: join(PREVIEW, 'vite.config.ts'), root: PREVIEW, logLevel: 'error', clearScreen: false,
    build: { outDir, emptyOutDir: true, rollupOptions: { input: join(PREVIEW, 'agent.html') } }
  }
}

async function buildPreview(outDir) {
  const { build } = await import('vite')
  await build(previewBuildConfig(outDir))
}

async function servePreview(outDir) {
  const { preview } = await import('vite')
  const port = await freePort()
  const server = await preview({ ...previewBuildConfig(outDir), preview: { host: '127.0.0.1', port, strictPort: true } })
  return { server, base: `http://127.0.0.1:${port}/agent.html` }
}

/**
 * Runs the Electron entry over every state and resolves with its per-state records once it exits 0; rejects when it
 * cannot start, exits otherwise, or outlives the overall limit (its process tree is killed then).
 */
function runElectron({ base, out, userData, session, viewport }) {
  const { promise, resolve: done, reject } = Promise.withResolvers()
  const states = STATES.map((state) => ({ state, viewport: viewportOf(state, viewport), media: mediaOf(state) }))
  const config = Buffer.from(JSON.stringify({ base, states, out, deadlineMs: STATE_DEADLINE_MS })).toString('base64')
  const electron = createRequire(import.meta.url)('electron')
  const child = spawn(electron, [ELECTRON_ENTRY, `--user-data-dir=${userData}`, `--capture-config=${config}`],
    { cwd: REPO, env: electronEnv(process.env), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
  session.child = child
  const records = {}
  let started = false
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
  child.stdout.resume()
  child.on('message', (message) => {
    if (message?.type === 'started') started = true
    if (message?.type === 'state') records[message.record.state] = message.record
    if (message?.type === 'fatal') stderr = `${stderr}\n${message.error}`
  })
  child.once('error', (error) => reject(new Error(`Electron failed to start: ${error.message}`)))
  child.once('exit', (code, signal) => {
    if (!started) reject(new Error(`Electron failed to start (exit ${code ?? signal}): ${stderr.trim() || 'no output'}`))
    else if (code !== 0) reject(new Error(`Electron exited with ${code ?? signal}: ${stderr.trim() || 'no output'}`))
    else done(records)
  })
  return promise
}

/** Rejects with `message` once `ms` pass, killing Electron's process tree; replaces any earlier phase's limit. */
function phaseLimit(session, ms, message) {
  const { promise, reject } = Promise.withResolvers()
  clearTimeout(session.timer)
  session.timer = setTimeout(() => {
    killTree(session.child)
    reject(new Error(message))
  }, ms)
  return promise
}

function report(out, records, failures) {
  const states = Object.fromEntries(STATES.map((state) => [state, records[state] ?? null]))
  writeFileSync(join(out, 'observations.json'), `${JSON.stringify({ states, failures }, null, 2)}\n`)
}

async function main() {
  const { out, viewport } = parseArgs(process.argv.slice(2))
  mkdirSync(out, { recursive: true })
  const userData = mkdtempSync(join(tmpdir(), 'dm-capture-agent-chat-'))
  const built = mkdtempSync(join(tmpdir(), 'dm-capture-agent-chat-build-'))
  const session = { child: null, timer: null, server: null }
  let records = {}
  let failures
  try {
    const buildStarted = Date.now()
    await Promise.race([buildPreview(built),
      phaseLimit(session, BUILD_LIMIT_MS, `Building the preview exceeded its ${BUILD_LIMIT_MS / 1_000} s limit`)])
    console.log(`Built the preview in ${Date.now() - buildStarted} ms`)
    const capture = (async () => {
      const served = await servePreview(built)
      session.server = served.server
      return runElectron({ base: served.base, out, userData, session, viewport })
    })()
    records = await Promise.race([capture,
      phaseLimit(session, OVERALL_LIMIT_MS, `The capture exceeded its ${OVERALL_LIMIT_MS / 1_000} s overall limit`)])
    failures = runFailures(records, viewport)
  } catch (error) {
    failures = [error instanceof Error ? error.message : String(error)]
  } finally {
    clearTimeout(session.timer)
    killTree(session.child)
    await session.server?.close()
    rmSync(userData, { recursive: true, force: true })
    rmSync(built, { recursive: true, force: true })
  }
  report(out, records, failures)
  if (failures.length > 0) {
    console.error(`Capture failed (${failures.length}):\n${failures.map((line) => `- ${line}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`Captured ${STATES.length} states into ${out}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main()
}
