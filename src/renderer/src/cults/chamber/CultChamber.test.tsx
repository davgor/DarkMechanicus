// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAMBER_CLIPS, CHAMBER_PROPS } from './chamberArt'
import { applyChamberEvent, createChamber, staticChamber, type ChamberEvent } from './chamberState'
import { CultChamber, backdropRect, type ChamberMember } from './CultChamber'
import { plateMetrics } from './plates'
import { chamberLayout } from './layout'

const ROOM = { width: 1280, height: 800 }
const MEMBERS: ChamberMember[] = [
  { id: 'm1', name: 'Vexa-9', hue: 40 }, { id: 'm2', name: 'Orlok Teth', hue: 160 }, { id: 'm3', name: 'Kryz', hue: 280 }
]
const JOIN: ChamberEvent[] = [
  { type: 'runState', runState: 'running' },
  ...MEMBERS.map((member): ChamberEvent => ({ type: 'memberJoined', id: member.id })),
  { type: 'working', id: 'm2', on: true }
]

let reduced = false
let visible = true
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1
let requested = 0
const mediaListeners = new Set<() => void>()
const intersections = new Set<(entries: Array<{ isIntersecting: boolean }>) => void>()

class SizeObserver {
  observe(): void {}
  disconnect(): void {}
}

class ViewObserver {
  private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void
  constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { this.callback = callback }
  observe(): void { intersections.add(this.callback) }
  disconnect(): void { intersections.delete(this.callback) }
}

function tick(time: number): void {
  const pending = [...frames.values()]
  frames.clear()
  act(() => pending.forEach((frame) => frame(time)))
}

function setVisible(next: boolean): void {
  visible = next
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}

function setOnScreen(next: boolean): void {
  act(() => intersections.forEach((callback) => callback([{ isIntersecting: next }])))
}

function mount(props: { onSelectMember?: (id: string) => void; selectedMemberId?: string; events?: ChamberEvent[] } = {}) {
  const view = render(<CultChamber events={props.events ?? JOIN} seed={7} members={MEMBERS}
    onSelectMember={props.onSelectMember ?? (() => undefined)} selectedMemberId={props.selectedMemberId}
    viewscreen={<button type="button" data-testid="shrine">Enlarge</button>} />)
  const query = <T extends HTMLElement = HTMLElement>(selector: string) => view.container.querySelector<T>(selector)!
  const all = (selector: string) => [...view.container.querySelectorAll<HTMLElement>(selector)]
  return { ...view, query, all }
}

beforeEach(() => {
  reduced = false
  visible = true
  frames.clear()
  nextFrame = 1
  requested = 0
  vi.stubGlobal('ResizeObserver', SizeObserver)
  vi.stubGlobal('IntersectionObserver', ViewObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    requested += 1
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return reduced },
    addEventListener: (_name: string, callback: () => void) => mediaListeners.add(callback),
    removeEventListener: (_name: string, callback: () => void) => mediaListeners.delete(callback)
  }))
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => !visible })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => ROOM.width })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => ROOM.height })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  mediaListeners.clear()
  intersections.clear()
})

describe('CultChamber scene', () => {
  it('draws one tinted sprite and one name plate per member', () => {
    const view = mount()
    tick(0)
    const acolytes = view.all('.cc-acolyte')
    expect(acolytes.map((item) => item.dataset.memberId)).toEqual(['m1', 'm2', 'm3'])
    for (const [index, acolyte] of acolytes.entries()) {
      const member = MEMBERS[index]!
      expect(acolyte.style.getPropertyValue('--member-hue')).toBe(`${member.hue}deg`)
      expect(acolyte.querySelectorAll('.pg-mascot-sprite')).toHaveLength(1)
      expect(acolyte.querySelector('.cc-nameplate')!.textContent).toBe(member.name)
    }
  })

  it('never tints the Magos, who stands on the helm', () => {
    const view = mount()
    const magos = view.query('.cc-magos')
    expect(magos.closest('.cc-acolyte')).toBeNull()
    expect(magos.closest('[style*="--member-hue"]')).toBeNull()
    expect(magos.style.filter).toBe('')
    expect(magos.style.backgroundImage).toContain('magos')
    const layout = chamberLayout(ROOM, CHAMBER_PROPS, MEMBERS.length)
    expect(parseFloat(magos.style.top) + parseFloat(magos.style.height)).toBeGreaterThan(layout.magos.y)
    expect(parseFloat(magos.style.top)).toBeLessThan(layout.magos.y)
  })

  it('draws the backdrop with its floor line on the room floor, then every prop', () => {
    const view = mount()
    const layout = chamberLayout(ROOM, CHAMBER_PROPS, MEMBERS.length)
    const backdrop = backdropRect(layout, CHAMBER_PROPS.backdrop)
    expect(backdrop.y + CHAMBER_PROPS.backdrop.floorY * backdrop.height / CHAMBER_PROPS.backdrop.height)
      .toBeCloseTo(layout.floorY, 6)
    expect(backdrop.width).toBeGreaterThanOrEqual(ROOM.width)
    expect(backdrop.y + backdrop.height).toBeGreaterThanOrEqual(ROOM.height)
    expect(view.query('.cc-backdrop').style.top).toBe(`${backdrop.y}px`)
    const kinds = view.all('.cc-prop').map((item) => item.dataset.prop)
    expect(kinds).toEqual(['door-closed', 'teleport-pad', ...layout.consoles.map(() => 'console'), 'helm'])
    expect(layout.consoles.length).toBeGreaterThanOrEqual(3)
    expect(view.query('.cc-conduit')).not.toBeNull()
    expect(view.all('[data-effect]')).toHaveLength(0)
  })
})

describe('CultChamber scene: degenerate art, unlisted members and the dark room', () => {
  it('scales a backdrop whose floor line is its bottom edge by width and floor only', () => {
    const layout = chamberLayout(ROOM, CHAMBER_PROPS, MEMBERS.length)
    const rect = backdropRect(layout, { width: 1000, height: 400, floorY: 400 })
    const scale = Math.max(ROOM.width / 1000, layout.floorY / 400)
    expect(rect).toEqual({ x: (ROOM.width - 1000 * scale) / 2, y: layout.floorY - 400 * scale,
      width: 1000 * scale, height: 400 * scale })
    expect(rect.y + rect.height).toBeCloseTo(layout.floorY, 6)
  })

  it('names and tints an acolyte that has no roster entry by its id and the default hue', () => {
    const events: ChamberEvent[] = [...JOIN, { type: 'memberJoined', id: 'ghost', present: true },
      { type: 'bubble', id: 'ghost', text: 'Unlisted' }]
    const view = mount({ events })
    tick(0)
    const ghost = view.query('[data-member-id="ghost"]')
    expect(ghost.style.getPropertyValue('--member-hue')).toBe('0deg')
    expect(ghost.querySelector('.cc-nameplate')!.textContent).toBe('ghost')
    const bubble = view.query('.cc-bubble[data-speaker="ghost"]')
    expect(bubble.textContent).toBe('Unlisted')
    expect(bubble.style.getPropertyValue('--bubble-color')).toBe('hsl(0 70% 58%)')
  })

  it('draws the Magos bubble in brass over the helm, ahead of acolyte bubbles', () => {
    const view = mount({ events: [...JOIN, { type: 'bubble', id: 'magos', text: 'Obey.' }] })
    tick(0)
    const layout = chamberLayout(ROOM, CHAMBER_PROPS, MEMBERS.length)
    const bubble = view.query('.cc-bubble[data-speaker="magos"]')
    expect(bubble.textContent).toBe('Obey.')
    expect(bubble.style.getPropertyValue('--bubble-color')).toBe('var(--accent)')
    expect(parseFloat(bubble.style.top)).toBeLessThan(layout.magos.y - layout.magosSize.height)
  })

  it('when dark draws only the lit-off scenery: no Magos, no acolytes and no frame loop', () => {
    const view = render(<CultChamber events={JOIN} seed={7} members={MEMBERS} onSelectMember={() => undefined} dark
      viewscreen={<span data-testid="shrine" />} />)
    const scene = view.container.querySelector<HTMLElement>('.cc-scene')!
    expect(scene.classList.contains('cc-lights-off')).toBe(true)
    expect(view.container.querySelectorAll('.cc-acolyte, .cc-magos, .cc-effects')).toHaveLength(0)
    expect(view.container.querySelector('.cc-prop[data-prop="door-closed"]')).not.toBeNull()
    expect(view.getByTestId('shrine')).not.toBeNull()
    expect(frames.size).toBe(0)
    expect(view.container.querySelector<HTMLElement>('.cc-chamber')!.dataset.animated).toBe('false')
  })
})

describe('CultChamber selection and accessibility', () => {
  it('calls onSelectMember with the clicked member id and highlights the selection', () => {
    const onSelectMember = vi.fn()
    const view = mount({ onSelectMember, selectedMemberId: 'm2' })
    tick(0)
    fireEvent.click(view.query('[data-member-id="m3"] .pg-mascot-sprite'))
    fireEvent.click(view.query('[data-member-id="m1"] .cc-nameplate'))
    expect(onSelectMember.mock.calls).toEqual([['m3'], ['m1']])
    expect(view.all('.cc-acolyte').map((item) => item.dataset.selected)).toEqual(['false', 'true', 'false'])
  })

  it('renders the viewscreen node inside the frame window, outside the aria-hidden scene', () => {
    const view = mount()
    const layout = chamberLayout(ROOM, CHAMBER_PROPS, MEMBERS.length)
    const window = view.query('.cc-viewscreen-window')
    expect(window.contains(view.getByTestId('shrine'))).toBe(true)
    expect(window.style.left).toBe(`${layout.viewscreen.window.x}px`)
    expect(window.style.top).toBe(`${layout.viewscreen.window.y}px`)
    expect(window.style.width).toBe(`${layout.viewscreen.window.width}px`)
    expect(window.style.height).toBe(`${layout.viewscreen.window.height}px`)
    expect(view.getByTestId('shrine').closest('[aria-hidden="true"]')).toBeNull()
  })

  it('hides the drawn scene from assistive technology', () => {
    const view = mount()
    tick(0)
    const scene = view.query('.cc-scene')
    expect(scene.getAttribute('aria-hidden')).toBe('true')
    for (const selector of ['.cc-backdrop', '.cc-prop', '.cc-magos', '.cc-acolyte', '.cc-effects']) {
      expect(scene.contains(view.query(selector))).toBe(true)
    }
  })
})

describe('CultChamber frame loop', () => {
  it('drives every actor from one requestAnimationFrame loop', () => {
    const view = mount()
    expect(frames.size).toBe(1)
    const before = view.all('.cc-acolyte .pg-mascot-sprite').map((item) => item.style.left + item.dataset.frame)
    for (let time = 0; time <= 3000; time += 16) {
      tick(time)
      expect(frames.size).toBe(1)
    }
    const after = view.all('.cc-acolyte .pg-mascot-sprite').map((item) => item.style.left + item.dataset.frame)
    expect(after).not.toEqual(before)
    expect(view.query('.cc-chamber').dataset.animated).toBe('true')
  })

  it('cancels the loop while the page is hidden and restarts it when shown', () => {
    const view = mount()
    tick(0)
    tick(16)
    setVisible(false)
    expect(frames.size).toBe(0)
    const calls = requested
    const frozen = view.all('.pg-mascot-sprite').map((item) => item.style.cssText)
    expect(view.query('.cc-chamber').dataset.animated).toBe('false')
    setVisible(true)
    expect(frames.size).toBe(1)
    expect(requested).toBe(calls + 1)
    tick(10_000)
    expect(view.all('.pg-mascot-sprite').map((item) => item.style.cssText)).toEqual(frozen)
  })

  it('stops while the room is off-screen and resumes when it scrolls back', () => {
    mount()
    expect(frames.size).toBe(1)
    setOnScreen(false)
    expect(frames.size).toBe(0)
    setOnScreen(true)
    expect(frames.size).toBe(1)
  })
})

describe('CultChamber frame loop: missing observers and restarted logs', () => {

  it('runs the loop as on-screen where IntersectionObserver is missing', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const view = mount()
    expect(frames.size).toBe(1)
    expect(intersections.size).toBe(0)
    expect(view.query('.cc-chamber').dataset.animated).toBe('true')
  })

  it('keeps its on-screen state through an intersection batch with no entries', () => {
    mount()
    setOnScreen(false)
    act(() => intersections.forEach((callback) => callback([])))
    expect(frames.size).toBe(0)
    setOnScreen(true)
    act(() => intersections.forEach((callback) => callback([])))
    expect(frames.size).toBe(1)
  })

  it('restarts from the end of a shorter log, replaying nothing, then applies what is appended', () => {
    const view = mount()
    tick(0)
    const late: ChamberEvent = { type: 'memberJoined', id: 'late', present: true }
    const later: ChamberEvent = { type: 'memberJoined', id: 'later', present: true }
    const rerender = (events: ChamberEvent[]) => view.rerender(<CultChamber events={events} seed={7} members={MEMBERS}
      onSelectMember={() => undefined} />)
    rerender([late])
    tick(16)
    expect(view.all('.cc-acolyte').map((item) => item.dataset.memberId)).toEqual(['m1', 'm2', 'm3'])
    rerender([late, later])
    tick(32)
    expect(view.all('.cc-acolyte').map((item) => item.dataset.memberId)).toEqual(['m1', 'm2', 'm3', 'later'])
  })
})

describe('CultChamber loop timing and reduced motion', () => {
  it('clamps a long frame gap to 50 ms', () => {
    const events: ChamberEvent[] = [{ type: 'runState', runState: 'running' }, { type: 'memberJoined', id: 'm1' }]
    const view = mount({ events })
    tick(1000)
    tick(6000)
    // Beaming in lasts 900 ms: one clamped step (50 ms) leaves the acolyte arriving.
    expect(view.query('.cc-acolyte').dataset.mode).toBe('arriving')
  })

  it('with reduced motion schedules no frame and places members as staticChamber does', () => {
    reduced = true
    const view = mount()
    expect(requested).toBe(0)
    expect(view.query('.cc-chamber').dataset.animated).toBe('false')
    const layout = chamberLayout(ROOM, CHAMBER_PROPS, MEMBERS.length)
    const expected = staticChamber(JOIN.reduce((state, event) => applyChamberEvent(state, event, layout),
      createChamber(7, CHAMBER_CLIPS)), layout)
    for (const acolyte of expected.acolytes) {
      const sprite = view.query(`[data-member-id="${acolyte.id}"] .pg-mascot-sprite`)
      const plate = view.query(`[data-member-id="${acolyte.id}"] .cc-nameplate`)
      expect(sprite.dataset.action).toBe(acolyte.pose)
      expect(plate.style.left).toBe(`${acolyte.x}px`)
      const { rowHeight } = plateMetrics(layout.spriteScale)
      expect(plate.style.top).toBe(`${acolyte.y + 2 + Number(plate.dataset.row) * rowHeight}px`)
    }
    expect(expected.acolytes.find((item) => item.id === 'm2')!.pose).toBe('type')
    view.rerender(<CultChamber events={[...JOIN, { type: 'working', id: 'm1', on: true }]} seed={7} members={MEMBERS}
      onSelectMember={() => undefined} />)
    expect(view.query('[data-member-id="m1"] .pg-mascot-sprite').dataset.action).toBe('type')
    expect(requested).toBe(0)
  })

  it('applies each logged event once, even when re-rendered with the same log', () => {
    const view = mount()
    tick(0)
    view.rerender(<CultChamber events={[...JOIN]} seed={7} members={MEMBERS} onSelectMember={() => undefined} />)
    tick(16)
    expect(view.all('.cc-acolyte')).toHaveLength(3)
  })
})
