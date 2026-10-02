import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const RENDERER_DIR = fileURLToPath(new URL('.', import.meta.url))
const STYLES = readFileSync(join(RENDERER_DIR, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Every rule of the theme sheet as its selector list and declarations, in source order. */
const RULES = [...STYLES.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
  selectors: (selectors ?? '').split(',').map((selector) => selector.trim()),
  declarations: (body ?? '')
    .split(';')
    .map((line) => line.split(':'))
    .filter(([property, ...value]) => property?.trim() && value.length > 0)
    .map(([property, ...value]) => [property?.trim() ?? '', value.join(':').trim()] as const)
}))

/** The declarations the theme sheet gives `selector`, alone or in a selector list; later rules win. */
function rule(selector: string): Record<string, string> {
  const matching = RULES.filter((entry) => entry.selectors.includes(selector))
  if (matching.length === 0) throw new Error(`no rule for ${selector}`)
  return Object.fromEntries(matching.flatMap((entry) => entry.declarations))
}

/** Every declaration in the theme sheet outside :root, as `selector { property: value }`. */
const DECLARATIONS = RULES.filter((entry) => !entry.selectors.includes(':root')).flatMap((entry) =>
  entry.declarations.map(([property, value]) => ({ where: `${entry.selectors.join(', ')} { ${property} }`, property, value }))
)

/** The value of a `#rrggbb` token in :root. */
function token(name: string): string {
  const value = new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(STYLES)?.[1]
  if (!value) throw new Error(`no hex token ${name}`)
  return value
}

/** WCAG 2.x relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const c = parseInt(hex.slice(start, start + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}

const SELECTED_ROWS = ['.folder-row.is-selected', '.status-row.is-selected', '.epic-row.is-selected']

describe('crimson, the primary accent, in the shell', () => {
  it('fills primary buttons with crimson and bone ink, brightening on hover', () => {
    expect(rule('.btn-primary')).toMatchObject({
      background: 'var(--primary)',
      'border-color': 'var(--primary)',
      color: 'var(--primary-ink)'
    })
    expect(rule('.btn-primary:hover:not(:disabled)')).toMatchObject({
      background: 'var(--primary-hover)',
      'border-color': 'var(--primary-hover)'
    })
  })

  it('fills the update banner restart button and the active onboarding step the same way', () => {
    for (const selector of ['.update-banner-restart', '.step.is-active .step-dot']) {
      expect(rule(selector), selector).toMatchObject({ background: 'var(--primary)', color: 'var(--primary-ink)' })
    }
    expect(rule('.update-banner-restart').border).toBe('1px solid var(--primary)')
    expect(rule('.step.is-active .step-dot')['border-color']).toBe('var(--primary)')
    expect(rule('.update-banner-restart:hover')).toMatchObject({
      background: 'var(--primary-hover)',
      'border-color': 'var(--primary-hover)'
    })
  })

  it('draws every keyboard focus ring in the lit crimson that meets 3:1', () => {
    expect(rule(':focus-visible').outline).toBe('2px solid var(--ring)')
    expect(rule('.input:focus-visible')).toMatchObject({
      'border-color': 'var(--ring)',
      'box-shadow': '0 0 0 1px var(--ring)'
    })
  })

  it('washes selected text in crimson', () => {
    expect(rule('::selection').background).toBe('var(--primary-soft)')
  })

  it('never sets text in crimson, which reaches only 3.2:1 on the surfaces', () => {
    const crimsonText = DECLARATIONS.filter(
      ({ property, value }) => property === 'color' && /var\(--(primary|primary-hover|primary-soft|ring)\)/.test(value)
    )
    expect(crimsonText.map(({ where }) => where)).toEqual([])
  })
})

describe('the active sidebar row', () => {
  it('is marked with a crimson wash and a 2px ring bar', () => {
    for (const selector of SELECTED_ROWS) {
      expect(rule(selector), selector).toMatchObject({
        background: 'var(--primary-soft)',
        'box-shadow': 'inset 2px 0 0 var(--ring)'
      })
    }
  })

  it('keeps the wash under the pointer, by following the hover rules', () => {
    const lastRule = (selector: string): number =>
      RULES.reduce((last, entry, index) => (entry.selectors.includes(selector) ? index : last), -1)
    for (const row of ['.folder-row', '.status-row', '.epic-row']) {
      expect(lastRule(`${row}:hover`), row).toBeGreaterThan(-1)
      expect(lastRule(`${row}.is-selected`), row).toBeGreaterThan(lastRule(`${row}:hover`))
    }
  })
})

describe('danger buttons beside primary ones', () => {
  it('fill with the light rose and its dark ink, not the crimson', () => {
    expect(rule('.btn-danger')).toMatchObject({
      background: 'var(--danger)',
      'border-color': 'var(--danger)',
      color: 'var(--danger-ink)'
    })
    expect(rule('.btn-danger:hover:not(:disabled)').background).toBe('var(--btn-danger-hover)')
  })

  it('have the opposite polarity: dark text on a light fill against light text on a dark fill', () => {
    expect(luminance(token('--danger-ink'))).toBeLessThan(luminance(token('--danger')))
    expect(luminance(token('--primary-ink'))).toBeGreaterThan(luminance(token('--primary')))
    expect(luminance(token('--danger'))).toBeGreaterThan(2 * luminance(token('--primary')))
  })
})

describe('bone, brass and the text tones in the shell', () => {
  it('sets screen titles, dialog titles and the wordmark in bone display ink', () => {
    for (const selector of ['.display', '.dialog-title', '.empty-state-title', '.brand-name']) {
      expect(rule(selector).color, selector).toBe('var(--ink-display)')
    }
  })

  it('keeps links, warnings and the draft badge in brass', () => {
    for (const selector of ['a', '.tone-warn', '.inline-warning', '.badge-draft', '.footer-warning', '.status-row']) {
      expect(rule(selector).color, selector).toBe('var(--accent)')
    }
  })

  it('rules the brand bar off with a brass hairline', () => {
    expect(rule('.sidebar-brand')['border-bottom']).toMatch(/^1px solid color-mix\(in srgb, var\(--accent\) \d+%, transparent\)$/)
  })

  it('shows form, snippet and tone errors in the failed rose, leaving orchid for checkpoints', () => {
    for (const selector of ['.form-error', '.tone-error', '.snippet-error']) {
      expect(rule(selector).color, selector).toBe('var(--st-failed)')
    }
    expect(rule('.pill-awaiting_checkpoint')['--pill']).toBe('var(--attention)')
  })

  it('never uses the decorative --faint for text', () => {
    expect(rule('.input::placeholder').color).toBe('var(--muted)')
    expect(rule('.pill-later_sprint')).toMatchObject({ '--pill': 'var(--muted)', 'border-style': 'dashed' })
    expect(rule('.epic-status')['--tone']).toBe('var(--muted)')
    const faintText = DECLARATIONS.filter(
      ({ property, value }) => ['color', '--pill', '--tone'].includes(property) && value.includes('var(--faint)')
    )
    expect(faintText.map(({ where }) => where)).toEqual([])
  })

  it('keeps lens green to the brand mark glow among the shell rules', () => {
    const lens = DECLARATIONS.filter(({ value }) => value.includes('var(--lens)'))
    expect(lens.map(({ where }) => where)).toEqual(['.brand-mark { filter }'])
  })
})
