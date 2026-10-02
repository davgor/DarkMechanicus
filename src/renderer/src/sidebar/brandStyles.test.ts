import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const STYLES = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8')

/** The declarations of the rule whose selector is exactly `selector`, as a property map. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(STYLES)
  if (!block) throw new Error(`no rule for ${selector}`)
  const declarations: Record<string, string> = {}
  for (const line of (block[1] ?? '').split(';')) {
    const [property, ...value] = line.split(':')
    if (property && value.length > 0) declarations[property.trim()] = value.join(':').trim()
  }
  return declarations
}

const px = (value: string | undefined): number => Number.parseFloat(value ?? '')

describe('sidebar brand styles', () => {
  it('sets the tagline smaller and quieter than the brand name', () => {
    const name = rule('.brand-name')
    const tagline = rule('.brand-tagline')
    expect(px(tagline['font-size'])).toBeGreaterThanOrEqual(10)
    expect(px(tagline['font-size'])).toBeLessThanOrEqual(11)
    expect(px(tagline['font-size'])).toBeLessThan(px(name['font-size']))
    expect(tagline.color).toBe('var(--muted)')
  })

  it('truncates the name and tagline with an ellipsis instead of wrapping', () => {
    for (const selector of ['.brand-name', '.brand-tagline']) {
      const styles = rule(selector)
      expect(styles['white-space'], selector).toBe('nowrap')
      expect(styles.overflow, selector).toBe('hidden')
      expect(styles['text-overflow'], selector).toBe('ellipsis')
    }
  })

  it('lets the tagline give way to the version and the icon keep its size', () => {
    expect(rule('.brand-text')['grid-template-columns']).toBe('minmax(0, 1fr) auto')
    expect(rule('.brand-text')['min-width']).toBe('0')
    expect(rule('.brand-name')['grid-column']).toBe('1 / -1')
    expect(rule('.brand-name')['min-width']).toBe('0')
    expect(rule('.brand-tagline')['min-width']).toBe('0')
    expect(rule('.brand-mark')['flex-shrink']).toBe('0')
  })

  it('keeps the icon and both text rows inside the fixed-height brand bar', () => {
    const bar = px(rule('.sidebar-brand').height)
    const rows =
      px(rule('.brand-name')['line-height']) +
      px(rule('.brand-text')['row-gap']) +
      px(rule('.brand-tagline')['line-height'])
    expect(px(rule('.brand-mark').height)).toBeLessThanOrEqual(bar)
    expect(rows).toBeLessThanOrEqual(bar)
  })
})
