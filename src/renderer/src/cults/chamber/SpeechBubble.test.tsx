// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { applyChamberEvent, BUBBLE_MAX_CHARS, createChamber } from './chamberState'
import { chamberLayout } from './layout'
import { layoutPlates, plateWidth } from './plates'
import { layoutBubbles, SpeechBubble, type BubbleInput } from './SpeechBubble'
import { PROPS } from './testFixtures'

const ROOM_WIDTH = 1280
const input = (overrides: Partial<BubbleInput>): BubbleInput =>
  ({ id: 'm1', text: 'Praise the Omnissiah', x: 400, headY: 500, color: 'hsl(40 70% 58%)', priority: false, ...overrides })

afterEach(cleanup)

describe('SpeechBubble', () => {
  it('renders markup in the text literally, never as HTML', () => {
    const text = '<b>bold</b><script>window.pwned = 1</script><img src=x onerror=alert(1)>'
    const [bubble] = layoutBubbles([input({ text })], ROOM_WIDTH)
    const view = render(<SpeechBubble bubble={bubble!} />)
    const element = view.container.querySelector<HTMLElement>('.cc-bubble')!
    expect(element.textContent).toBe(text)
    expect(element.querySelector('b, script, img')).toBeNull()
    expect(element.children).toHaveLength(0)
  })

  it('borders the bubble in the speaker colour', () => {
    const [bubble] = layoutBubbles([input({})], ROOM_WIDTH)
    const view = render(<SpeechBubble bubble={bubble!} />)
    expect(view.container.querySelector<HTMLElement>('.cc-bubble')!.style.getPropertyValue('--bubble-color'))
      .toBe('hsl(40 70% 58%)')
  })

  it('extends right of the head, and flips left near the right edge while staying inside the room', () => {
    const [left] = layoutBubbles([input({ x: 300 })], ROOM_WIDTH)
    expect(left!.flipped).toBe(false)
    expect(left!.left).toBeLessThan(300)
    const [edge] = layoutBubbles([input({ x: ROOM_WIDTH - 20, text: 'x'.repeat(50) })], ROOM_WIDTH)
    expect(edge!.flipped).toBe(true)
    expect(edge!.left + edge!.width).toBeLessThanOrEqual(ROOM_WIDTH)
    expect(edge!.left).toBeGreaterThanOrEqual(0)
    const view = render(<SpeechBubble bubble={edge!} />)
    expect(view.container.querySelector<HTMLElement>('.cc-bubble')!.dataset.flipped).toBe('true')
  })

  it('draws the ellipsis the chamber state put on long text, adding none of its own', () => {
    const layout = chamberLayout({ width: ROOM_WIDTH, height: 720 }, PROPS, 1)
    let state = applyChamberEvent(createChamber(3), { type: 'memberJoined', id: 'm1' }, layout)
    state = applyChamberEvent(state, { type: 'bubble', id: 'm1', text: 'a'.repeat(200) }, layout)
    const text = state.bubbles.m1!.text
    expect([...text]).toHaveLength(BUBBLE_MAX_CHARS)
    const [bubble] = layoutBubbles([input({ text })], ROOM_WIDTH)
    const view = render(<SpeechBubble bubble={bubble!} />)
    expect(view.container.querySelector('.cc-bubble')!.textContent).toBe(text)
    expect(text.endsWith('…')).toBe(true)
  })

})

describe('bubbles in a crowded room', () => {
  it('stacks overlapping bubbles upward without overlap and drops those with no room, keeping priority ones', () => {
    const crowd = Array.from({ length: 24 }, (_, index) =>
      input({ id: `m${index}`, x: 200 + index * 30, headY: 240, text: 'Binharic cant for the motive force' }))
    const placed = layoutBubbles([...crowd, input({ id: 'magos', x: 1180, headY: 380, priority: true })], ROOM_WIDTH)
    expect(placed.map((item) => item.id)).toContain('magos')
    for (const [index, a] of placed.entries()) {
      expect(a.top).toBeGreaterThanOrEqual(0)
      for (const b of placed.slice(index + 1)) {
        const apart = a.left + a.width <= b.left || b.left + b.width <= a.left ||
          a.top + a.height <= b.top || b.top + b.height <= a.top
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true)
      }
    }
    expect(placed.length).toBeLessThan(25)
  })
})

describe('name plates in a crowded room', () => {
  it('never overlap at 24 acolytes: staggered into rows, hidden when no row is free, priority always shown', () => {
    const layout = chamberLayout({ width: ROOM_WIDTH, height: 720 }, PROPS, 24)
    const names = ['Vexa-9', 'Orlok Teth', 'Kryz', 'Amaranth-3', 'Dorn Vel', 'Sable Quill', 'Zeta Kahl']
    const plates = Array.from({ length: 24 }, (_, index) => ({ id: `m${index}`, x: 180 + index * 22,
      name: names[index % names.length]!, priority: index % 2 === 0, forced: index === 13 }))
    const placed = layoutPlates(plates, layout.spriteScale)
    expect(placed.get('m13')!.hidden).toBe(false)
    const shown = plates.filter((plate) => !placed.get(plate.id)!.hidden)
    expect(shown.length).toBeGreaterThan(5)
    for (const [index, a] of shown.entries()) {
      for (const b of shown.slice(index + 1)) {
        if (placed.get(a.id)!.row !== placed.get(b.id)!.row) continue
        const half = (plateWidth(a.name, layout.spriteScale) + plateWidth(b.name, layout.spriteScale)) / 2
        expect(Math.abs(a.x - b.x), `${a.id} and ${b.id}`).toBeGreaterThanOrEqual(half)
      }
    }
  })
})
