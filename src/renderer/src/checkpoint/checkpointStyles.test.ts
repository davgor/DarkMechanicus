import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const STYLES = readFileSync(join(__dirname, 'checkpoint.css'), 'utf8')

/** The declarations of the rule whose selector is exactly `selector`, as a property map. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')
  const block = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(STYLES)
  if (!block) throw new Error(`no rule for ${selector}`)
  const declarations: Record<string, string> = {}
  for (const line of (block[1] ?? '').split(';')) {
    const [property, ...value] = line.split(':')
    if (property && value.length > 0) declarations[property.trim()] = value.join(':').trim()
  }
  return declarations
}

describe('checkpoint report row styles', () => {
  it('gives the report column the space the gate card leaves, without shrinking it to its content', () => {
    expect(rule('.cp')['grid-template-columns']).toBe('minmax(0, 1fr) 360px')
    expect(rule('.cp-report')['min-width']).toBe('0')
  })

  it('lets an entry without a ticket key use the key column too, instead of waiting in the 72px track', () => {
    const columns = rule('.cp-row')['grid-template-columns'] ?? ''
    expect(columns.startsWith('72px minmax(0, 1fr)')).toBe(true)
    expect(rule('.cp-row-title.is-keyless')['grid-column']).toBe('1 / span 2')
  })

  it('lets the entry text shrink to its column and break inside a long unbroken token', () => {
    const title = rule('.cp-row-title')
    expect(title['min-width']).toBe('0')
    expect(title['overflow-wrap']).toBe('anywhere')
  })
})

describe('checkpoint check row styles', () => {
  it('moves a detail that does not fit beside the name onto its own line instead of squeezing the name', () => {
    expect(rule('.cp-checks li')['flex-wrap']).toBe('wrap')
    expect(rule('.cp-check-name')['min-width']).toBe('0')
    expect(rule('.cp-checks li > .ew-muted')['min-width']).toBe('0')
  })

  it('never lets the name or the detail fill the whole line, so the icon is not left alone on one', () => {
    for (const selector of ['.cp-check-name', '.cp-checks li > .ew-muted']) {
      expect(rule(selector)['max-width'], selector).toBe('calc(100% - 26px)')
    }
    expect(rule('.cp-icon').width).toBe('16px')
  })
})
