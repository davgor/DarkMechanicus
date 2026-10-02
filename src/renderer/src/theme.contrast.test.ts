import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const RENDERER_DIR = fileURLToPath(new URL('.', import.meta.url))
const STYLES = readFileSync(join(RENDERER_DIR, 'styles.css'), 'utf8')
const PALETTE_DOC = readFileSync(join(RENDERER_DIR, '..', '..', '..', 'docs', 'design', 'palette.md'), 'utf8')

/** An sRGB color: 0–255 channels, 0–1 alpha. */
interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const COMMENT = /\/\*[\s\S]*?\*\//g
const DECLARATION = /(--[\w-]+)\s*:\s*([^;]+);/g
const COLOR_VALUE = /^(#|(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\()/i
const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
const RGBA = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i
const DOC_TOKEN_ROW = /^\|\s*`(--[\w-]+)`[^|]*\|[^|]*\|\s*`([^`]+)`/

/** The custom properties declared in the `:root` block of a stylesheet, by name. */
function rootTokens(css: string): Record<string, string> {
  const block = /:root\s*\{([^}]*)\}/.exec(css.replace(COMMENT, ''))?.[1] ?? ''
  return Object.fromEntries([...block.matchAll(DECLARATION)].map(([, name, value]) => [name, value.trim()]))
}

/** Lower case, with one space after each comma, so `rgba(1,2,3,0.5)` and `rgba(1, 2, 3, 0.5)` compare equal. */
function normalizeColor(value: string): string {
  return value.trim().toLowerCase().replace(/\s*,\s*/g, ', ')
}

/** The `:root` tokens of a stylesheet whose value is a color, normalized. */
function colorTokens(css: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(rootTokens(css))
      .filter(([, value]) => COLOR_VALUE.test(value))
      .map(([name, value]) => [name, normalizeColor(value)])
  )
}

/** The "Proposed" value of every token in the token tables (section 3) of the palette doc, normalized. */
function paletteDocTokens(markdown: string): Record<string, string> {
  const start = markdown.search(/^## 3\. /m)
  const end = markdown.search(/^## 4\. /m)
  if (start < 0 || end < start) throw new Error('the palette doc has no section 3 token table')
  const rows = markdown
    .slice(start, end)
    .split('\n')
    .map((line) => DOC_TOKEN_ROW.exec(line))
    .filter((row): row is RegExpExecArray => row !== null)
  return Object.fromEntries(rows.map(([, name, value]) => [name, normalizeColor(value)]))
}

/** `#rrggbb`, `rgb()` or `rgba()`; anything else, including `var()`, is not a color this guard can measure. */
function parseColor(value: string | undefined): Rgba | undefined {
  const hex = HEX.exec(value?.trim() ?? '')
  if (hex) return { r: parseInt(hex[1], 16), g: parseInt(hex[2], 16), b: parseInt(hex[3], 16), a: 1 }
  const rgba = RGBA.exec(value?.trim() ?? '')
  if (rgba) return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: rgba[4] === undefined ? 1 : Number(rgba[4]) }
  return undefined
}

/** `top` painted over the opaque color `bottom` (source-over, in sRGB as browsers blend). */
function over(top: Rgba, bottom: Rgba): Rgba {
  const blend = (t: number, b: number): number => t * top.a + b * (1 - top.a)
  return { r: blend(top.r, bottom.r), g: blend(top.g, bottom.g), b: blend(top.b, bottom.b), a: 1 }
}

/** WCAG 2.x relative luminance. */
function luminance({ r, g, b }: Rgba): number {
  const linear = (channel: number): number => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** WCAG 2.x contrast ratio of two opaque colors, from 1 to 21. */
function contrastRatio(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

/** One pair from the palette doc's contrast tables. */
interface ContrastCheck {
  /** The text or indicator token. */
  fg: string
  /** What it sits on, bottom layer first. The first is an opaque surface; translucent tokens above it are composited. */
  bg: string[]
  /** The foreground's own tint at this opacity, laid over `bg` first, as inside a state pill. */
  tint?: number
  min: number
}

function describeCheck({ fg, bg, tint }: ContrastCheck): string {
  const below = [...bg].reverse().join(' over ')
  return tint === undefined ? `${fg} on ${below}` : `${fg} in its ${Math.round(tint * 100)}% tint over ${below}`
}

/** Measures one check against the tokens; returns why it fails, or undefined when it passes. */
function checkFailure(tokens: Record<string, string>, check: ContrastCheck): string | undefined {
  const name = describeCheck(check)
  const missing = [check.fg, ...check.bg].find((token) => parseColor(tokens[token]) === undefined)
  if (missing) return `${name}: ${missing} is not a color token`
  const [surface, ...layers] = check.bg.map((token) => parseColor(tokens[token]) as Rgba)
  if (surface.a !== 1) return `${name}: ${check.bg[0]} is translucent; name the surface under it`
  const fg = parseColor(tokens[check.fg]) as Rgba
  const ground = layers.reduce((below, layer) => over(layer, below), surface)
  const tinted = check.tint === undefined ? ground : over({ ...fg, a: check.tint }, ground)
  const ratio = contrastRatio(over(fg, tinted), tinted)
  return ratio >= check.min ? undefined : `${name}: ${ratio.toFixed(2)} (needs ${check.min})`
}

/** Every check the tokens fail, in order. */
function contrastFailures(tokens: Record<string, string>, checks: ContrastCheck[]): string[] {
  return checks.map((check) => checkFailure(tokens, check)).filter((failure): failure is string => failure !== undefined)
}

const TEXT_SURFACES = ['--bg', '--panel', '--panel-2', '--sidebar']
const TEXT_TOKENS = ['--ink', '--ink-2', '--muted', '--ink-soft', '--ink-display', '--accent']
const STATE_TOKENS = [
  '--st-accepted',
  '--st-review',
  '--st-running',
  '--st-ready',
  '--st-waiting',
  '--st-failed',
  '--st-blocked',
  '--attention'
]
const RING_SURFACES = ['--bg', '--panel', '--panel-2', '--panel-3', '--sidebar', '--node-bg']
const BODY = 4.5
const NON_TEXT = 3

/** Every pair and threshold in sections 5.1 to 5.5 of docs/design/palette.md. The 5.6 checks are advisory. */
const PALETTE_CHECKS: ContrastCheck[] = [
  // 5.1 Text on surfaces; --faint is decorative.
  ...TEXT_TOKENS.flatMap((fg) => TEXT_SURFACES.map((surface) => ({ fg, bg: [surface], min: BODY }))),
  ...TEXT_SURFACES.map((surface) => ({ fg: '--faint', bg: [surface], min: NON_TEXT })),
  // 5.2 State labels: on a panel, on a graph node card, and inside the pill's 12% tint over a panel.
  ...STATE_TOKENS.flatMap((fg) => [
    { fg, bg: ['--panel'], min: BODY },
    { fg, bg: ['--node-bg'], min: BODY },
    { fg, bg: ['--panel'], tint: 0.12, min: BODY }
  ]),
  // 5.3 Text on fills.
  { fg: '--accent-ink', bg: ['--accent'], min: BODY },
  { fg: '--danger-ink', bg: ['--danger'], min: BODY },
  { fg: '--primary-ink', bg: ['--primary'], min: BODY },
  { fg: '--primary-ink', bg: ['--primary-hover'], min: BODY },
  { fg: '--accent-ink', bg: ['--btn-primary-hover'], min: BODY },
  { fg: '--danger-ink', bg: ['--btn-danger-hover'], min: BODY },
  { fg: '--ink', bg: ['--sidebar', '--primary-soft'], min: BODY },
  { fg: '--ink', bg: ['--panel', '--primary-soft'], min: BODY },
  // 5.4 The crimson ring is a non-text indicator.
  ...RING_SURFACES.map((surface) => ({ fg: '--ring', bg: [surface], min: NON_TEXT })),
  // 5.5 Other tones.
  { fg: '--tone-edited', bg: ['--panel'], min: BODY },
  { fg: '--tone-ok', bg: ['--panel'], min: BODY },
  { fg: '--accent', bg: ['--panel', '--accent-soft'], min: BODY },
  { fg: '--lens', bg: ['--sidebar'], min: BODY }
]

const color = (value: string): Rgba => parseColor(value) as Rgba

describe('contrast helpers', () => {
  it('reads #rrggbb, rgb() and rgba() values and nothing else', () => {
    expect(parseColor('#B51A1F')).toEqual({ r: 181, g: 26, b: 31, a: 1 })
    expect(parseColor('rgb(9, 7, 6)')).toEqual({ r: 9, g: 7, b: 6, a: 1 })
    expect(parseColor('rgba(181,26,31,0.24)')).toEqual({ r: 181, g: 26, b: 31, a: 0.24 })
    expect(parseColor('var(--primary)')).toBeUndefined()
    expect(parseColor('#fff')).toBeUndefined()
    expect(parseColor(undefined)).toBeUndefined()
  })

  it('measures the WCAG extremes: black on white is 21:1 and a color on itself is 1:1', () => {
    expect(contrastRatio(color('#000000'), color('#ffffff'))).toBeCloseTo(21, 6)
    expect(contrastRatio(color('#ffffff'), color('#000000'))).toBeCloseTo(21, 6)
    expect(contrastRatio(color('#b51a1f'), color('#b51a1f'))).toBe(1)
  })

  it('reproduces the palette doc ratios for opaque pairs', () => {
    expect(contrastRatio(color('#fbe9c8'), color('#b51a1f'))).toBeCloseTo(5.616, 3)
    expect(contrastRatio(color('#9c9284'), color('#28211d'))).toBeCloseTo(5.174, 3)
    expect(contrastRatio(color('#ea4134'), color('#302823'))).toBeCloseTo(3.649, 3)
  })

  it('composites translucent colors over the surface below before measuring', () => {
    expect(over(color('rgba(181, 26, 31, 0.5)'), color('#000000'))).toEqual({ r: 90.5, g: 13, b: 15.5, a: 1 })
    const activeRow = over(color('rgba(181, 26, 31, 0.24)'), color('#1c1816'))
    expect(contrastRatio(color('#ece6da'), activeRow)).toBeCloseTo(12.327, 3)
  })
})

describe('reading tokens', () => {
  it('reads the custom properties of the :root block only, without comments', () => {
    const css = '/* --x: #000000; */\n:root {\n  color-scheme: dark;\n  /* Surfaces */\n  --bg: #151211;\n  --overlay: rgba(9, 7, 6, 0.72);\n}\n.a { --bg: #000000; }\n'
    expect(rootTokens(css)).toEqual({ '--bg': '#151211', '--overlay': 'rgba(9, 7, 6, 0.72)' })
  })

  it('keeps only the color tokens, normalized', () => {
    const css = ':root {\n  --bg: #151211;\n  --soft: RGBA(214,155,74,0.14);\n  --font-sans: "IBM Plex Sans", sans-serif;\n  --radius: 8px;\n}\n'
    expect(colorTokens(css)).toEqual({ '--bg': '#151211', '--soft': 'rgba(214, 155, 74, 0.14)' })
  })

  it('reads the Proposed column of the palette doc token tables', () => {
    const doc = [
      '## 3. Token table',
      '| Token | Today | Proposed | Role |',
      '|---|---|---|---|',
      '| `--ink` | `#ece6da` | `#ece6da` (unchanged) | Body text |',
      '| `--primary` (new) | — (role held by `--accent`) | `#b51a1f` | Primary button fill |',
      '| `--primary-soft` (new) | — | `rgba(181, 26, 31, 0.24)` | Selection |',
      '`rgba(236, 230, 218, 0.04)` is not a token.',
      '## 4. Collision rules',
      '| `--st-failed` | `#e06a5a` | `#ef6b8f` | not in section 3 |'
    ].join('\n')
    expect(paletteDocTokens(doc)).toEqual({ '--ink': '#ece6da', '--primary': '#b51a1f', '--primary-soft': 'rgba(181, 26, 31, 0.24)' })
    expect(() => paletteDocTokens('# no tables')).toThrow('no section 3 token table')
  })
})

describe('the Mechanicus palette in styles.css', () => {
  it('gives every :root color token the value the approved palette doc proposes', () => {
    const doc = paletteDocTokens(PALETTE_DOC)
    expect(Object.keys(doc)).toEqual(expect.arrayContaining(['--bg', '--primary', '--ring', '--lens', '--node-bg']))
    expect(colorTokens(STYLES)).toEqual(doc)
  })

  it('meets every contrast pair and threshold in sections 5.1 to 5.5 of the palette doc', () => {
    expect(contrastFailures(rootTokens(STYLES), PALETTE_CHECKS)).toEqual([])
  })
})

describe('the contrast guard', () => {
  const tokens = rootTokens(STYLES)

  it('fails a text token darkened below 4.5:1, on every surface it misses', () => {
    expect(contrastFailures({ ...tokens, '--muted': '#6b6458' }, PALETTE_CHECKS)).toEqual([
      '--muted on --bg: 3.19 (needs 4.5)',
      '--muted on --panel: 2.91 (needs 4.5)',
      '--muted on --panel-2: 2.71 (needs 4.5)',
      '--muted on --sidebar: 3.01 (needs 4.5)'
    ])
  })

  it('fails a state label that only loses contrast inside its tinted pill', () => {
    expect(contrastFailures({ ...tokens, '--st-failed': '#e06a5a' }, PALETTE_CHECKS)).toEqual([
      '--st-failed in its 12% tint over --panel: 4.41 (needs 4.5)'
    ])
  })

  it('fails a focus ring below 3:1 and a translucent fill that drowns the text on it', () => {
    expect(contrastFailures({ ...tokens, '--ring': '#b51a1f' }, PALETTE_CHECKS)).toEqual([
      '--ring on --bg: 2.78 (needs 3)',
      '--ring on --panel: 2.54 (needs 3)',
      '--ring on --panel-2: 2.36 (needs 3)',
      '--ring on --panel-3: 2.16 (needs 3)',
      '--ring on --sidebar: 2.63 (needs 3)',
      '--ring on --node-bg: 2.60 (needs 3)'
    ])
    expect(contrastFailures({ ...tokens, '--primary-soft': 'rgba(236, 230, 218, 0.8)' }, PALETTE_CHECKS)).toEqual([
      '--ink on --primary-soft over --sidebar: 1.51 (needs 4.5)',
      '--ink on --primary-soft over --panel: 1.50 (needs 4.5)'
    ])
  })

  it('fails closed on a missing token, a token it cannot read and a translucent base surface', () => {
    const withoutLens = Object.fromEntries(Object.entries(tokens).filter(([name]) => name !== '--lens'))
    expect(contrastFailures(withoutLens, PALETTE_CHECKS)).toEqual(['--lens on --sidebar: --lens is not a color token'])
    expect(contrastFailures({ ...tokens, '--tone-ok': 'var(--st-accepted)' }, PALETTE_CHECKS)).toEqual([
      '--tone-ok on --panel: --tone-ok is not a color token'
    ])
    expect(contrastFailures({ ...tokens, '--sidebar': 'rgba(28, 24, 22, 0.5)' }, PALETTE_CHECKS)).toContain(
      '--lens on --sidebar: --sidebar is translucent; name the surface under it'
    )
  })
})
