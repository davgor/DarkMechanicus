import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SHEET = readFileSync(fileURLToPath(new URL('./terminalPane.css', import.meta.url)), 'utf8')

/** The declarations of the rule whose whole selector is `selector`; empty when the sheet has none. */
function declarationsOf(selector: string): string {
  return new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(SHEET)?.[1] ?? ''
}

describe('terminal host stylesheet', () => {
  it('lets the host grow and shrink with the pane in both dimensions, and clips what xterm puts past it', () => {
    // Without the clip, the helper textarea left at the old cursor row after the pane got shorter made app-main
    // scrollable: its scrollbar took the pane's width, and a wheel over the terminal scrolled the pane away.
    const host = declarationsOf('.terminal-host')
    for (const declaration of ['flex: 1;', 'min-width: 0;', 'min-height: 0;', 'overflow: clip;']) {
      expect(host).toContain(declaration)
    }
  })

  it('finds nothing for a rule the sheet does not have', () => {
    expect(declarationsOf('.not-a-rule')).toBe('')
  })
})
