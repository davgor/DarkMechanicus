import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXECUTION_TONES, RUN_STATE_TONES } from './graph/ticketStates'

/** The epic workspace stylesheets hold to the roles in docs/design/palette.md (sections 2, 4 and 6). */
const RENDERER_DIR = fileURLToPath(new URL('.', import.meta.url))
const COMMENT = /\/\*[\s\S]*?\*\//g
const RULE = /([^{}]+)\{([^{}]*)\}/g

function sheet(path: string): string {
  return readFileSync(join(RENDERER_DIR, path), 'utf8').replace(COMMENT, '')
}

const SHEETS = {
  graph: sheet('graph/graph.css'),
  tones: sheet('epic/tones.css'),
  epic: sheet('epic/epic.css'),
  ticket: sheet('ticket/ticket.css'),
  checkpoint: sheet('checkpoint/checkpoint.css'),
  markdown: sheet('markdown/markdown.css')
}

const collapse = (text: string): string => text.trim().replace(/\s+/g, ' ')

/** Every rule of a stylesheet as selector -> declarations; a selector list contributes to each of its selectors. */
function rules(css: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>()
  for (const [, selectors, body] of css.matchAll(RULE)) {
    const declarations: Record<string, string> = {}
    for (const line of body.split(';')) {
      const colon = line.indexOf(':')
      if (colon > 0) declarations[line.slice(0, colon).trim()] = collapse(line.slice(colon + 1))
    }
    for (const selector of selectors.split(',').map(collapse)) out.set(selector, { ...out.get(selector), ...declarations })
  }
  return out
}

function rule(css: string, selector: string): Record<string, string> {
  const found = rules(css).get(selector)
  if (!found) throw new Error(`no rule for ${selector}`)
  return found
}

/** The `:root` color tokens of the theme sheet, by name. */
const ROOT_TOKENS: Record<string, string> = Object.fromEntries(
  [...(/:root\s*\{([^}]*)\}/.exec(sheet('styles.css'))?.[1] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(
    ([, name, value]) => [name, value.trim().toLowerCase()]
  )
)

/** The layers of a box-shadow, split on the commas that are not inside a function. */
function shadowLayers(value: string): string[] {
  const layers: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    depth += char === '(' ? 1 : char === ')' ? -1 : 0
    if (char === ',' && depth === 0) {
      layers.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  return [...layers, current.trim()]
}

/** One shadow layer: its lengths in px (x, y, blur, spread) and its color. */
function parseLayer(layer: string): { lengths: number[]; color: string } {
  const parts = layer.split(' ')
  const lengths: number[] = []
  while (parts.length > 0 && /^-?\d+(\.\d+)?(px)?$/.test(parts[0] ?? '')) lengths.push(Number.parseFloat(parts.shift() ?? ''))
  return { lengths, color: parts.join(' ') }
}

/** The tone token a `.ew-tone-<tone>` class sets, e.g. `--st-running`. */
function toneToken(tone: string): string | undefined {
  return /^var\((--[\w-]+)\)$/.exec(rules(SHEETS.tones).get(`.ew-tone-${tone}`)?.['--tone'] ?? '')?.[1]
}

const CRIMSON = /var\(--(primary|primary-hover|primary-soft|ring)\)/

describe('crimson marks focus and selection in the epic workspace', () => {
  it('rings the focused and the selected graph node with --ring', () => {
    expect(rule(SHEETS.graph, '.pg .react-flow__node:focus-visible').outline).toBe('2px solid var(--ring)')
    expect(shadowLayers(rule(SHEETS.graph, '.pg-card.is-active')['box-shadow'] ?? '')).toContain('0 0 0 2px var(--ring)')
  })

  it('draws the selected edge and a new connection with --ring', () => {
    const flow = rule(SHEETS.graph, '.pg .react-flow')
    expect([flow['--xy-edge-stroke-selected'], flow['--xy-connectionline-stroke']]).toEqual(['var(--ring)', 'var(--ring)'])
    expect(rule(SHEETS.graph, '.pg-edge.selected .react-flow__edge-path').stroke).toBe('var(--ring)')
    expect(rule(SHEETS.graph, '.pg-edge:focus-visible .react-flow__edge-path').stroke).toBe('var(--ring)')
  })

  it('underlines the selected ticket tab with --ring', () => {
    expect(rule(SHEETS.ticket, ".tp-tabs button[aria-selected='true']")['box-shadow']).toBe('inset 0 -2px 0 var(--ring)')
  })

  it('fills the selected list row with --primary-soft', () => {
    expect(rule(SHEETS.epic, '.ew-table tr.is-selected td').background).toBe('var(--primary-soft)')
  })

  it('never colors text or a state tone crimson', () => {
    const offenders = Object.entries(SHEETS).flatMap(([name, css]) =>
      [...rules(css)].flatMap(([selector, declarations]) =>
        ['color', '--tone']
          .filter((property) => CRIMSON.test(declarations[property] ?? ''))
          .map((property) => `${name}: ${selector} { ${property}: ${declarations[property]} }`)
      )
    )
    expect(offenders).toEqual([])
  })
})

describe('the running highlight', () => {
  function runningLayers(selector: string): { lengths: number[]; color: string }[] {
    return shadowLayers(rule(SHEETS.graph, selector)['box-shadow'] ?? '')
      .map(parseLayer)
      .filter((layer) => layer.color.includes('var(--st-running)'))
  }

  it('rings the running card in the lens green and lets it glow, stronger than the old 16% ring', () => {
    const layers = runningLayers('.pg-card.ew-tone-running')
    const ring = layers.find(({ lengths }) => lengths[2] === 0 && (lengths[3] ?? 0) >= 2)
    const glow = layers.find(({ lengths }) => (lengths[2] ?? 0) >= 12)
    expect([ring === undefined, glow === undefined]).toEqual([false, false])
    for (const { color } of layers) {
      const share = Number(/var\(--st-running\) (\d+)%/.exec(color)?.[1])
      expect(share, color).toBeGreaterThan(16)
    }
  })

  it('keeps the glow around the selection ring when a running card is selected', () => {
    const layers = shadowLayers(rule(SHEETS.graph, '.pg-card.ew-tone-running.is-active')['box-shadow'] ?? '')
    expect(layers).toContain('0 0 0 2px var(--ring)')
    expect(runningLayers('.pg-card.ew-tone-running.is-active').some(({ lengths }) => (lengths[2] ?? 0) >= 12)).toBe(true)
  })
})

describe('the plan canvas and its edges', () => {
  it('dots the canvas with --line on --bg', () => {
    const flow = rule(SHEETS.graph, '.pg .react-flow')
    expect([flow['--xy-background-color'], flow['--xy-background-pattern-color']]).toEqual(['var(--bg)', 'var(--line)'])
  })

  it('draws met prerequisites solid in --edge and waiting ones dashed in --edge-waiting, edges and legend alike', () => {
    const met = rule(SHEETS.graph, '.pg-edge .react-flow__edge-path')
    const waiting = rule(SHEETS.graph, '.pg-edge.is-waiting .react-flow__edge-path')
    expect([met.stroke, met['stroke-dasharray'], waiting.stroke]).toEqual(['var(--edge)', undefined, 'var(--edge-waiting)'])
    expect(waiting['stroke-dasharray']).toMatch(/^\d+ \d+$/)
    expect(rule(SHEETS.graph, '.pg-legend-line')['border-top']).toBe('2px solid var(--edge)')
    expect(rule(SHEETS.graph, '.pg-legend-line.is-dashed')).toMatchObject({
      'border-top-style': 'dashed',
      'border-top-color': 'var(--edge-waiting)'
    })
  })
})

describe('state tones', () => {
  it('defines a tone class for every ticket and run state', () => {
    const tones = [...new Set([...Object.values(EXECUTION_TONES), ...Object.values(RUN_STATE_TONES)])]
    expect(tones.filter((tone) => toneToken(tone) === undefined)).toEqual([])
  })

  it.each([
    ['ticket', EXECUTION_TONES],
    ['run', RUN_STATE_TONES]
  ])('gives every %s state tone its own palette color', (_kind, map) => {
    const tones = [...new Set(Object.values(map))]
    const colors = tones.map((tone) => ROOT_TOKENS[toneToken(tone) ?? ''])
    expect(colors.every((color) => color !== undefined)).toBe(true)
    expect(new Set(colors).size).toBe(tones.length)
  })

  it('colors an awaiting checkpoint orchid (--attention), as the sidebar does', () => {
    expect(toneToken(RUN_STATE_TONES.awaiting_checkpoint)).toBe('--attention')
  })
})

describe('display ink and brass', () => {
  it('sets the workspace, ticket panel, checkpoint gate and graph epic titles in bone display ink', () => {
    expect([
      rule(SHEETS.epic, '.ew-title').color,
      rule(SHEETS.ticket, '.tp-title').color,
      rule(SHEETS.checkpoint, '.cp-gate-title').color,
      rule(SHEETS.graph, '.pg-epic-title').color
    ]).toEqual(Array(4).fill('var(--ink-display)'))
  })

  it('keeps links, inline code, the "new" tone and the active sprint heading brass', () => {
    expect([
      rule(SHEETS.epic, '.ew-link').color,
      rule(SHEETS.markdown, '.md .md-link').color,
      rule(SHEETS.markdown, '.md .md-inline-code').color,
      rule(SHEETS.tones, '.ew-tone-new')['--tone'],
      rule(SHEETS.graph, '.pg-sprint.is-active .pg-sprint-heading').color
    ]).toEqual(Array(5).fill('var(--accent)'))
    expect(rule(SHEETS.markdown, '.md .md-link:hover').color).toBe('var(--accent-hover)')
  })

  it('leaves danger buttons to the app-wide style, whose hover keeps dark text on the light rose', () => {
    expect(rules(SHEETS.epic).has('.ew .btn-danger')).toBe(false)
  })
})
