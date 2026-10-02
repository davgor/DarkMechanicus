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
