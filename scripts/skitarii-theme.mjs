// Generates resources/skitarii/theme.json, the Skitarii theme for OMP (docs/reports/omp-cli.md, 8 and 10), from the
// `:root` tokens of src/renderer/src/styles.css (the Mechanicus palette, docs/design/palette.md):
//   node scripts/skitarii-theme.mjs          write the file
//   node scripts/skitarii-theme.mjs --check  fail when the file is not what the tokens produce
// Every color is one app token, chosen by role: crimson for accent and selection, brass for highlights and links,
// bone for headings, gunmetal for surfaces and lines, lens green for running and success, signal rose for errors.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const STYLES_PATH = join(ROOT, 'src', 'renderer', 'src', 'styles.css')
export const THEME_PATH = join(ROOT, 'resources', 'skitarii', 'theme.json')

/** OMP color key -> the app token it takes its value from. All 68 keys of OMP's theme schema. */
export const COLOR_TOKENS = {
  accent: '--ring',
  border: '--line-strong',
  borderAccent: '--ring',
  borderMuted: '--line',
  success: '--st-running',
  error: '--st-failed',
  warning: '--st-blocked',
  muted: '--muted',
  dim: '--faint',
  text: '--ink',
  assistantMessageText: '--ink',
  thinkingText: '--muted',
  selectedBg: '--primary',
  userMessageBg: '--panel-2',
  userMessageText: '--ink',
  customMessageBg: '--panel-3',
  customMessageText: '--ink',
  customMessageLabel: '--accent',
  toolPendingBg: '--panel',
  toolSuccessBg: '--diff-add-bg',
  toolErrorBg: '--diff-del-bg',
  toolTitle: '--ink-display',
  toolOutput: '--ink-2',
  mdHeading: '--ink-display',
  mdLink: '--accent',
  mdLinkUrl: '--muted',
  mdCode: '--accent',
  mdCodeBlock: '--ink-2',
  mdCodeBlockBorder: '--line',
  mdQuote: '--muted',
  mdQuoteBorder: '--line-strong',
  mdHr: '--line-strong',
  mdListBullet: '--accent',
  toolDiffAdded: '--diff-add-ink',
  toolDiffRemoved: '--diff-del-ink',
  toolDiffContext: '--muted',
  syntaxComment: '--muted',
  syntaxKeyword: '--term-magenta',
  syntaxFunction: '--accent',
  syntaxVariable: '--ink',
  syntaxString: '--st-accepted',
  syntaxNumber: '--tone-edited',
  syntaxType: '--term-blue',
  syntaxOperator: '--ink-2',
  syntaxPunctuation: '--muted',
  thinkingOff: '--faint',
  thinkingMinimal: '--muted',
  thinkingLow: '--ink-soft',
  thinkingMedium: '--accent',
  thinkingHigh: '--accent-hover',
  thinkingXhigh: '--ring',
  thinkingMax: '--ink-display',
  bashMode: '--accent',
  pythonMode: '--st-review',
  statusLineBg: '--sidebar',
  statusLineSep: '--line-strong',
  statusLineModel: '--ink-display',
  statusLinePath: '--accent',
  statusLineGitClean: '--st-running',
  statusLineGitDirty: '--st-blocked',
  statusLineContext: '--ink-soft',
  statusLineSpend: '--tone-edited',
  statusLineStaged: '--st-accepted',
  statusLineDirty: '--st-blocked',
  statusLineUntracked: '--muted',
  statusLineOutput: '--ink-2',
  statusLineCost: '--tone-edited',
  statusLineSubagents: '--attention'
}

/** The terminal block (the pane's own painting, `src/main/desktop/ompTheme.ts`): its background, text and 16 ANSI colors. */
export const TERMINAL_TOKENS = {
  background: '--code-bg',
  foreground: '--ink',
  ansi: [
    '--term-black', '--term-red', '--term-green', '--term-yellow', '--term-blue', '--term-magenta', '--term-cyan', '--term-white',
    '--term-bright-black', '--term-bright-red', '--term-bright-green', '--term-bright-yellow',
    '--term-bright-blue', '--term-bright-magenta', '--term-bright-cyan', '--term-bright-white'
  ]
}

/** Mechanicus spinner glyphs (cog and gear); `status` drives the loader, `activity` the progress spinner. */
const SPINNER_FRAMES = { status: ['\u2699', '\u26ED'], activity: ['\u2699', '\u26ED'] }

/** The custom properties declared in the `:root` block of a stylesheet. */
export function rootTokens(css) {
  const block = /:root\s*\{([^}]*)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1] ?? ''
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim().toLowerCase()]))
}

function hexOf(tokens, name) {
  const value = tokens[name]
  if (!/^#[0-9a-f]{6}$/.test(value ?? '')) throw new Error(`${name} is not a #rrggbb token`)
  return value
}

/** The theme object for a set of `:root` tokens. */
export function buildTheme(tokens) {
  const colors = Object.fromEntries(Object.entries(COLOR_TOKENS).map(([key, token]) => [key, hexOf(tokens, token)]))
  return {
    name: 'skitarii',
    colors,
    terminal: {
      background: hexOf(tokens, TERMINAL_TOKENS.background),
      foreground: hexOf(tokens, TERMINAL_TOKENS.foreground),
      ansi: TERMINAL_TOKENS.ansi.map((token) => hexOf(tokens, token))
    },
    symbols: { spinnerFrames: SPINNER_FRAMES }
  }
}

export const themeText = (theme) => `${JSON.stringify(theme, null, 2)}\n`

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = themeText(buildTheme(rootTokens(readFileSync(STYLES_PATH, 'utf8'))))
  if (process.argv.includes('--check')) {
    if (readFileSync(THEME_PATH, 'utf8').replace(/\r\n/g, '\n') !== text) {
      console.error('resources/skitarii/theme.json is out of step with styles.css: run node scripts/skitarii-theme.mjs')
      process.exit(1)
    }
  } else {
    writeFileSync(THEME_PATH, text)
  }
}
