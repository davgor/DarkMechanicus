import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SHEET = fileURLToPath(new URL('../epic/tones.css', import.meta.url))
const css = readFileSync(SHEET, 'utf8').replaceAll('\r\n', '\n')
const MOTION_BLOCK = /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}\n/g

describe('the hourglass stylesheet', () => {
  it('declares the turn only for people who have not asked for less motion', () => {
    const blocks = css.match(MOTION_BLOCK) ?? []
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatch(/\.ew-hourglass\.is-animated \.ew-hourglass-icon \{[^}]*animation: ew-hourglass-turn/)
    expect(css.replace(MOTION_BLOCK, '')).not.toMatch(/animation:/)
  })
})
