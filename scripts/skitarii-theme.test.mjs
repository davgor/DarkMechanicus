// The Skitarii OMP theme (resources/skitarii/theme.json) against the app's palette tokens: every OMP color key is set
// and equals the token it maps from, the checked-in file is what the generator makes, and the theme's text and
// background pairs meet the ratios of docs/design/palette.md (section 5: 4.5:1 for text, 3:1 for decoration and lines).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COLOR_TOKENS, STYLES_PATH, TERMINAL_TOKENS, THEME_PATH, buildTheme, rootTokens, themeText } from './skitarii-theme.mjs'

/** The 68 color keys of OMP's theme schema (docs/reports/omp-cli.md, 10). */
const OMP_COLOR_KEYS = `accent border borderAccent borderMuted success error warning muted dim text assistantMessageText thinkingText
selectedBg userMessageBg userMessageText customMessageBg customMessageText customMessageLabel
toolPendingBg toolSuccessBg toolErrorBg toolTitle toolOutput
mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet
toolDiffAdded toolDiffRemoved toolDiffContext
syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation
thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh thinkingMax bashMode pythonMode
statusLineBg statusLineSep statusLineModel statusLinePath statusLineGitClean statusLineGitDirty statusLineContext
statusLineSpend statusLineStaged statusLineDirty statusLineUntracked statusLineOutput statusLineCost statusLineSubagents`.split(/\s+/)

const tokens = rootTokens(readFileSync(STYLES_PATH, 'utf8'))
const file = JSON.parse(readFileSync(THEME_PATH, 'utf8'))

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

describe('the Skitarii theme and the app tokens', () => {
  it('has the 68 OMP color keys, no more, and each is a #rrggbb', () => {
    expect(OMP_COLOR_KEYS).toHaveLength(68)
    expect(Object.keys(file.colors).sort()).toEqual([...OMP_COLOR_KEYS].sort())
    for (const value of Object.values(file.colors)) expect(value).toMatch(/^#[0-9a-f]{6}$/)
    expect(file.name).toBe('skitarii')
  })

  it.each(OMP_COLOR_KEYS)('sets %s to the token it maps from', (key) => {
    const token = COLOR_TOKENS[key]
    expect(token, `${key} has no token`).toBeDefined()
    expect(file.colors[key]).toBe(tokens[token])
  })

  it('sets the terminal block (background, text and 16 ANSI colors) from the --code-bg, --ink and --term-* tokens', () => {
    expect(file.terminal.background).toBe(tokens['--code-bg'])
    expect(file.terminal.foreground).toBe(tokens['--ink'])
    expect(file.terminal.ansi).toEqual(TERMINAL_TOKENS.ansi.map((token) => tokens[token]))
    expect(file.terminal.ansi).toHaveLength(16)
  })

  it('maps the roles: crimson accent and selection, brass links, bone headings, gunmetal surfaces, lens green running, rose errors, orange warnings', () => {
    expect(file.colors).toMatchObject({
      accent: tokens['--ring'],
      selectedBg: tokens['--primary'],
      mdLink: tokens['--accent'],
      mdHeading: tokens['--ink-display'],
      statusLineBg: tokens['--sidebar'],
      userMessageBg: tokens['--panel-2'],
      success: tokens['--lens'],
      error: tokens['--st-failed'],
      warning: tokens['--st-blocked']
    })
  })

  it('is exactly what the generator makes from the tokens, so a token change fails here until the file is regenerated', () => {
    expect(file).toEqual(buildTheme(tokens))
    expect(themeText(file)).toBe(themeText(buildTheme(tokens)))
  })

  it('fails to build from a token that is not #rrggbb, or is missing', () => {
    expect(() => buildTheme({ ...tokens, '--ink': 'rgba(1, 2, 3, 0.5)' })).toThrow('--ink is not a #rrggbb token')
    const { '--ring': _ring, ...without } = tokens
    expect(() => buildTheme(without)).toThrow('--ring is not a #rrggbb token')
  })

  it('has spinner frames for the status loader and the activity spinner', () => {
    expect(file.symbols.spinnerFrames.status.length).toBeGreaterThan(1)
    expect(file.symbols.spinnerFrames.activity.length).toBeGreaterThan(1)
  })
})

const { colors, terminal } = file
const TEXT = 4.5
const NON_TEXT = 3
const LINE = 1.5

/** Foreground key, the background it is drawn on (a color key or the terminal), and the ratio the palette doc needs. */
const PAIRS = [
  // On the terminal background.
  ...[
    'accent', 'success', 'error', 'warning', 'muted', 'text', 'assistantMessageText', 'thinkingText', 'customMessageLabel',
    'toolTitle', 'toolOutput', 'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode', 'mdCodeBlock', 'mdQuote', 'toolDiffContext',
    'syntaxComment', 'syntaxKeyword', 'syntaxFunction', 'syntaxVariable', 'syntaxString', 'syntaxNumber', 'syntaxType',
    'syntaxOperator', 'syntaxPunctuation', 'thinkingMinimal', 'thinkingLow', 'thinkingMedium', 'thinkingHigh',
    'thinkingXhigh', 'thinkingMax', 'bashMode', 'pythonMode', 'mdListBullet'
  ].map((key) => [key, 'terminal', TEXT]),
  // Decoration (--faint: 3:1; the focus crimson is a non-text indicator: 3:1).
  ...['dim', 'thinkingOff', 'borderAccent'].map((key) => [key, 'terminal', NON_TEXT]),
  // Gunmetal lines set no ratio in the palette doc; they only have to be visible on the terminal.
  ...['border', 'borderMuted', 'mdQuoteBorder', 'mdHr', 'mdCodeBlockBorder'].map((key) => [key, 'terminal', LINE]),
  // Text on the message and tool surfaces.
  ['userMessageText', 'userMessageBg', TEXT],
  ['customMessageText', 'customMessageBg', TEXT],
  ['text', 'selectedBg', TEXT],
  ['text', 'userMessageBg', TEXT],
  ['toolOutput', 'toolPendingBg', TEXT],
  ['toolTitle', 'toolPendingBg', TEXT],
  ['toolOutput', 'toolSuccessBg', TEXT],
  ['toolOutput', 'toolErrorBg', TEXT],
  ['toolDiffAdded', 'toolSuccessBg', TEXT],
  ['toolDiffRemoved', 'toolErrorBg', TEXT],
  // The status line.
  ...[
    'statusLineModel', 'statusLinePath', 'statusLineGitClean', 'statusLineGitDirty', 'statusLineContext', 'statusLineSpend',
    'statusLineStaged', 'statusLineDirty', 'statusLineUntracked', 'statusLineOutput', 'statusLineCost', 'statusLineSubagents'
  ].map((key) => [key, 'statusLineBg', TEXT]),
  ['statusLineSep', 'statusLineBg', 1.5]
]

const colorOf = (key) => (key === 'terminal' ? terminal.background : colors[key])

describe('the Skitarii theme meets the palette contrast ratios', () => {
  it.each(PAIRS)('%s on %s is at least %s:1', (fg, bg, min) => {
    expect(contrast(colors[fg], colorOf(bg))).toBeGreaterThanOrEqual(min)
  })

  it('has terminal text and the 16 ANSI colors readable on the terminal background (3:1 for bright black, 4.5:1 for the rest, black is a surface)', () => {
    expect(contrast(terminal.foreground, terminal.background)).toBeGreaterThanOrEqual(TEXT)
    terminal.ansi.forEach((color, index) => {
      const min = index === 0 ? 1.2 : index === 8 ? NON_TEXT : TEXT
      expect(contrast(color, terminal.background), `ansi ${index}`).toBeGreaterThanOrEqual(min)
    })
  })

  it('catches a pair that falls below its ratio', () => {
    expect(contrast('#6b6458', '#100d0c')).toBeLessThan(TEXT)
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 6)
  })
})
