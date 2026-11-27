import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const RENDERER_DIR = fileURLToPath(new URL('.', import.meta.url))

/** Every renderer stylesheet as text, keyed by its `./`-relative path from src/renderer/src. */
const SHEETS: Record<string, string> = Object.fromEntries(
  readdirSync(RENDERER_DIR, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.css'))
    .map((path) => [`./${path.split('\\').join('/')}`, readFileSync(join(RENDERER_DIR, path), 'utf8')])
)

const THEME_SHEET = './styles.css'
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/g
const ROOT_BLOCK = /:root\s*\{[^}]*\}/g

/** Blanks out the `:root { … }` blocks of a stylesheet but keeps its line numbers. */
function withoutTokenBlock(css: string): string {
  return css.replace(ROOT_BLOCK, (block) => block.replace(/[^\n]/g, ' '))
}

/** Hex colors a stylesheet hardcodes, as `path:line: literal`. Only the theme sheet may keep them in its :root block. */
function hardcodedHexColors(path: string, css: string): string[] {
  const scanned = path === THEME_SHEET ? withoutTokenBlock(css) : css
  return scanned.split('\n').flatMap((line, index) => (line.match(HEX_COLOR) ?? []).map((hex) => `${path}:${index + 1}: ${hex}`))
}

describe('hardcodedHexColors', () => {
  it('reports a hex color in a component stylesheet with its line', () => {
    expect(hardcodedHexColors('./graph/graph.css', '.pg {\n  color: var(--ink);\n  stroke: #8a8070;\n}\n')).toEqual([
      './graph/graph.css:3: #8a8070'
    ])
  })

  it('reports every literal, including short and alpha forms', () => {
    expect(hardcodedHexColors('./epic/epic.css', 'a { color: #fff; border-color: #11223344; }')).toEqual([
      './epic/epic.css:1: #fff',
      './epic/epic.css:1: #11223344'
    ])
  })

  it('allows hex colors inside the :root block of the theme sheet', () => {
    expect(hardcodedHexColors(THEME_SHEET, ':root {\n  --bg: #141310;\n  --ink: #ece6da;\n}\n')).toEqual([])
  })

  it('reports hex colors in the theme sheet outside its :root block', () => {
    const css = ':root {\n  --bg: #141310;\n}\n\na:hover {\n  color: #f0c27a;\n}\n'
    expect(hardcodedHexColors(THEME_SHEET, css)).toEqual(['./styles.css:6: #f0c27a'])
  })

  it('does not exempt a :root block in a component stylesheet', () => {
    expect(hardcodedHexColors('./ticket/ticket.css', ':root {\n  --edge: #8a8070;\n}\n')).toEqual([
      './ticket/ticket.css:2: #8a8070'
    ])
  })

  it('ignores id selectors, which are not colors', () => {
    expect(hardcodedHexColors('./home/home.css', '#root { height: 100%; }')).toEqual([])
  })
})

describe('renderer stylesheets', () => {
  it('scans the theme sheet and every component sheet', () => {
    expect(Object.keys(SHEETS)).toEqual(
      expect.arrayContaining([
        './styles.css',
        './graph/graph.css',
        './epic/tones.css',
        './epic/epic.css',
        './ticket/ticket.css',
        './checkpoint/checkpoint.css',
        './markdown/markdown.css'
      ])
    )
  })

  it('keeps the palette in one :root token block in styles.css', () => {
    const theme = SHEETS[THEME_SHEET] ?? ''
    expect(theme.match(ROOT_BLOCK)).toHaveLength(1)
    expect(theme.match(ROOT_BLOCK)?.[0].match(HEX_COLOR)?.length).toBeGreaterThan(20)
  })

  it('hardcodes no hex color outside that :root block', () => {
    const offenders = Object.entries(SHEETS)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([path, css]) => hardcodedHexColors(path, css))

    expect(offenders).toEqual([])
  })
})

/** The declarations of the rule that starts with exactly this selector at the beginning of a line. */
function declarationsOf(css: string, selector: string): string {
  const start = css.indexOf(`
${selector} {`)
  return start < 0 ? '' : css.slice(start, css.indexOf('}', start))
}

describe('size badge styles', () => {
  const graph = SHEETS['./graph/graph.css'] ?? ''

  it('fills the micro badge from a different theme token than the other sizes', () => {
    expect(declarationsOf(graph, '.pg-size')).toContain('background: var(--panel-3);')
    expect(declarationsOf(graph, '.pg-size.is-micro')).toContain('background: var(--accent);')
    expect(declarationsOf(graph, '.pg-size.is-micro')).toContain('color: var(--accent-ink);')
  })
})

const COMMENT = /\/\*[\s\S]*?\*\//g

/** The `:root` custom properties of the theme sheet, without comments, by name. */
function rootTokens(css: string): Record<string, string> {
  const block = /:root\s*\{([^}]*)\}/.exec(css.replace(COMMENT, ''))?.[1] ?? ''
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim().replace(/\s+/g, ' ')]))
}

/** The body of the first at-rule with exactly this prelude, braces balanced; '' when there is none. */
function atRuleBody(css: string, prelude: string): string {
  const start = css.indexOf(`${prelude} {`)
  if (start < 0) return ''
  const open = start + prelude.length + 1
  let depth = 0
  for (let index = open; index < css.length; index++) {
    depth += css[index] === '{' ? 1 : css[index] === '}' ? -1 : 0
    if (depth === 0) return css.slice(open + 1, index)
  }
  return ''
}

/** An at-rule block with flat rules inside (`@media`, `@supports`, `@keyframes`) or none (`@font-face`). */
const AT_RULE_BLOCK = /@[^{};]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g

/**
 * Every top-level rule of a stylesheet as selector -> declarations, skipping at-rule blocks (read those with
 * `atRuleBody`); a selector list contributes to each selector.
 */
function rulesOf(css: string): Map<string, Record<string, string>> {
  const rules = new Map<string, Record<string, string>>()
  const flat = css.replace(COMMENT, '').replace(AT_RULE_BLOCK, '')
  for (const [, selectors, body] of flat.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const declarations = Object.fromEntries(
      body.split(';').map((line) => line.split(/:(.*)/s).map((part) => part.trim())).filter(([name, value]) => name && value)
    )
    for (const selector of selectors.split(',').map((part) => part.trim())) rules.set(selector, { ...rules.get(selector), ...declarations })
  }
  return rules
}

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** `#rrggbb` or `rgb()`/`rgba()`; throws on anything else so a token this test cannot measure fails it. */
function parseColor(value: string | undefined): Rgba {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value ?? '')
  if (hex) return { r: parseInt(hex[1], 16), g: parseInt(hex[2], 16), b: parseInt(hex[3], 16), a: 1 }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value ?? '')
  if (rgba) return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: rgba[4] === undefined ? 1 : Number(rgba[4]) }
  throw new Error(`not a measurable color: ${value}`)
}

/** `top` painted over the opaque `bottom` (source-over in sRGB, as browsers blend). */
function over(top: Rgba, bottom: Rgba): Rgba {
  const blend = (t: number, b: number): number => t * top.a + b * (1 - top.a)
  return { r: blend(top.r, bottom.r), g: blend(top.g, bottom.g), b: blend(top.b, bottom.b), a: 1 }
}

/** WCAG 2.x contrast ratio of two opaque colors. */
function contrastRatio(a: Rgba, b: Rgba): number {
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const luminance = ({ r, g, b }: Rgba): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

/**
 * The brightest point of `--agent-backdrop`: its base layer (the last) with every glow it names composited on top at
 * full strength, bottom layer first, as where the glows overlap.
 */
function brightestBackdrop(tokens: Record<string, string>): Rgba {
  const backdrop = tokens['--agent-backdrop'] ?? ''
  const layers = [...backdrop.matchAll(/var\((--[\w-]+)\)/g)].map(([, name]) => name)
  const base = layers.at(-1) ?? ''
  return layers.slice(0, -1).reverse().reduce((below, glow) => over(parseColor(tokens[glow]), below), parseColor(tokens[base]))
}

const GLASS = ['.glass', '.glass-strong']

describe('glass tokens and utilities', () => {
  const theme = SHEETS[THEME_SHEET] ?? ''
  const tokens = rootTokens(theme)

  it('declares the glass tokens: a translucent --panel tint, a near-solid tint, an edge, a 12-20 px blur and a shadow', () => {
    const glass = parseColor(tokens['--glass-bg'])
    const panel = parseColor(tokens['--panel'])
    expect({ ...glass, a: 1 }).toEqual(panel)
    expect(glass.a).toBeGreaterThan(0)
    expect(glass.a).toBeLessThanOrEqual(0.72)
    expect(parseColor(tokens['--glass-bg-strong']).a).toBeGreaterThanOrEqual(0.9)
    expect(parseColor(tokens['--glass-bg-strong']).a).toBeLessThan(1)
    expect(parseColor(tokens['--glass-edge']).a).toBeLessThan(1)
    const blur = /^(\d+)px$/.exec(tokens['--glass-blur'] ?? '')
    expect(Number(blur?.[1])).toBeGreaterThanOrEqual(12)
    expect(Number(blur?.[1])).toBeLessThanOrEqual(20)
    expect(tokens['--glass-shadow']).toMatch(/^0 \d+px \d+px rgba\(/)
  })

  it('gives .glass and .glass-strong their surface, edge, radius, shadow and backdrop blur', () => {
    const rules = rulesOf(theme)
    for (const selector of GLASS) {
      expect(rules.get(selector)).toMatchObject({
        border: '1px solid var(--glass-edge)',
        'border-radius': 'var(--radius)',
        'box-shadow': 'var(--glass-shadow)',
        'backdrop-filter': 'blur(var(--glass-blur)) saturate(1.2)'
      })
    }
    expect(rules.get('.glass')?.background).toBe('var(--glass-bg)')
    expect(rules.get('.glass-strong')?.background).toBe('var(--glass-bg-strong)')
  })

  it.each(['@supports not (backdrop-filter: blur(1px))', '@media (prefers-reduced-transparency: reduce)'])(
    'switches every glass surface to an opaque panel under %s',
    (prelude) => {
      const rules = rulesOf(atRuleBody(theme, prelude))
      for (const selector of GLASS) {
        const background = rules.get(selector)?.background
        expect(background, `${selector} background`).toBe('var(--panel-2)')
        expect(parseColor(tokens['--panel-2']).a).toBe(1)
      }
    }
  )

  it('drops the blur when the person prefers reduced transparency', () => {
    const rules = rulesOf(atRuleBody(theme, '@media (prefers-reduced-transparency: reduce)'))
    for (const selector of GLASS) expect(rules.get(selector)?.['backdrop-filter']).toBe('none')
  })
})

describe('the Agent backdrop, glass contrast and placement', () => {
  const tokens = rootTokens(SHEETS[THEME_SHEET] ?? '')

  it('builds the backdrop from --bg with low-alpha brass and crimson glows, and no image asset', () => {
    const backdrop = tokens['--agent-backdrop'] ?? ''
    expect(backdrop).toMatch(/gradient\(.*var\(--glow-brass\)/)
    expect(backdrop).toMatch(/gradient\(.*var\(--glow-crimson\)/)
    expect(backdrop).toMatch(/var\(--bg\)$/)
    expect(backdrop).not.toMatch(/url\(/)
    const brass = parseColor(tokens['--glow-brass'])
    const crimson = parseColor(tokens['--glow-crimson'])
    expect({ ...brass, a: 1 }).toEqual(parseColor(tokens['--accent']))
    expect({ ...crimson, a: 1 }).toEqual(parseColor(tokens['--primary']))
    expect(Math.max(brass.a, crimson.a)).toBeLessThanOrEqual(0.3)
  })

  // --ink is the body text; --muted is the quietest text the rail and transcript keep at body contrast.
  it.each([
    ['--ink', '--glass-bg-strong'],
    ['--ink', '--glass-bg'],
    ['--muted', '--glass-bg-strong'],
    ['--muted', '--glass-bg']
  ])('keeps %s on %s at 4.5:1 or more over the brightest backdrop glow', (text, surface) => {
    const ground = over(parseColor(tokens[surface]), brightestBackdrop(tokens))
    expect(contrastRatio(parseColor(tokens[text]), ground)).toBeGreaterThanOrEqual(4.5)
  })

  it('fails the contrast rule for a glass tint that lets a bright glow through', () => {
    const glaring: Record<string, string> = { ...tokens, '--glow-brass': 'rgba(242, 215, 174, 0.95)', '--glass-bg-strong': 'rgba(21, 18, 17, 0.1)' }
    const ground = over(parseColor(glaring['--glass-bg-strong']), brightestBackdrop(glaring))
    expect(contrastRatio(parseColor(glaring['--ink']), ground)).toBeLessThan(4.5)
  })

  it('lays the backdrop under the Agent stage and glass on its rail, prompt cards, composer and transcript', () => {
    const rule = (sheet: string, selector: string): Record<string, string> | undefined => rulesOf(SHEETS[sheet] ?? '').get(selector)
    expect(rule('./agentChat/agentChat.css', '.agent-chat')?.background).toBe('var(--agent-backdrop)')
    expect(rule('./epic/epicAgentPanel.css', '.eap')?.background).toBe('var(--agent-backdrop)')
    // The glass classes bring their own surface; a component background or border here would cover them.
    for (const [sheet, selector] of [
      ['./components/rightRail.css', '.rr'],
      ['./agentChat/pendingPrompt.css', '.agent-prompt'],
      ['./agentChat/chatComposer.css', '.chat-composer'],
      ['./agentChat/agentChat.css', '.agent-chat-scroll']
    ] as const) {
      expect(Object.keys(rule(sheet, selector) ?? {}).filter((name) => /^(background|border)/.test(name)), `${sheet} ${selector}`).toEqual([])
    }
  })
})

describe('the chat composer card', () => {
  it('rounds the composer card to 16 px or more and centres it in the 760 px reading column', () => {
    const rules = rulesOf(SHEETS['./agentChat/chatComposer.css'] ?? '')
    expect(parseFloat(rules.get('.chat-composer.glass')?.['border-radius'] ?? '0')).toBeGreaterThanOrEqual(16)
    expect(rules.get('.chat-composer')?.['max-width']).toBe('760px')
    expect(rules.get('.chat-composer')?.margin).toMatch(/^\S+ auto\b/)
    expect(rules.get('.chat-composer-send')?.['border-radius']).toBe('50%')
    expect(rules.get('.chat-composer-stop')?.['border-radius']).toBe('8px')
  })

  it('draws one focus ring: the card edge, with the field\'s own :focus-visible outline beating the global ring', () => {
    const rules = rulesOf(SHEETS['./agentChat/chatComposer.css'] ?? '')
    expect(rules.get('.chat-composer.glass:focus-within')?.['border-color']).toBe('var(--ring)')
    // The global `:focus-visible` ring loads after this sheet; only a selector at least as specific as
    // `.chat-composer-input:focus-visible` removes it from the field.
    expect(rules.get('.chat-composer-input:focus-visible')?.outline).toBe('none')
    expect(rules.get('.chat-composer-input')?.outline).toBeUndefined()
  })
})

describe('the docked multi-select card beside the transcript', () => {
  it('keeps the transcript at its declared minimum and the options to one line each', () => {
    const chat = rulesOf(SHEETS['./agentChat/agentChat.css'] ?? '')
    expect(chat.get('.agent-chat')?.['--agent-transcript-min']).toBe('96px')
    expect(chat.get('.agent-chat-scroll')?.['min-height']).toBe('var(--agent-transcript-min)')
    const prompt = rulesOf(SHEETS['./agentChat/pendingPrompt.css'] ?? '')
    expect(prompt.get('.agent-prompt-check-description')).toMatchObject({ 'white-space': 'nowrap', 'text-overflow': 'ellipsis' })
    expect(prompt.get('.agent-prompt-check-text')?.display).toBe('flex')
  })
})
