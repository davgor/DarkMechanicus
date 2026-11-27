// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChamberEffects } from './ChamberEffects'
import { CHAMBER_PROPS } from './chamberArt'
import { applyChamberEvent, createChamber, stepChamber, type ChamberEvent, type ChamberState } from './chamberState'
import { CultChamber, OUTLINE_MS, type ChamberMember } from './CultChamber'
import { chamberLayout } from './layout'

const ROOM = { width: 1280, height: 720 }
const MEMBERS: ChamberMember[] = [
  { id: 'm1', name: 'Vexa-9', hue: 40 }, { id: 'm2', name: 'Orlok Teth', hue: 160 }, { id: 'm3', name: 'Kryz', hue: 280 }
]
const JOIN: ChamberEvent[] = [
  { type: 'runState', runState: 'running' },
  ...MEMBERS.map((member): ChamberEvent => ({ type: 'memberJoined', id: member.id }))
]
const layout = chamberLayout(ROOM, CHAMBER_PROPS, MEMBERS.length)

const apply = (state: ChamberState, ...events: ChamberEvent[]): ChamberState =>
  events.reduce((next, event) => applyChamberEvent(next, event, layout), state)

let reduced = false
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1

class Observer {
  observe(): void {}
  disconnect(): void {}
}

function tick(time: number): void {
  const pending = [...frames.values()]
  frames.clear()
  act(() => pending.forEach((frame) => frame(time)))
}

beforeEach(() => {
  reduced = false
  frames.clear()
  vi.stubGlobal('ResizeObserver', Observer)
  vi.stubGlobal('IntersectionObserver', Observer)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced }, addEventListener() {}, removeEventListener() {} }))
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => ROOM.width })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => ROOM.height })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function mount(events: ChamberEvent[]) {
  const view = render(<CultChamber events={events} seed={5} members={MEMBERS} onSelectMember={() => undefined} />)
  const all = (selector: string) => [...view.container.querySelectorAll<HTMLElement>(selector)]
  const scene = () => view.container.querySelector<HTMLElement>('.cc-scene')!
  return { ...view, all, scene }
}

describe('ChamberEffects from the chamber state', () => {
  it('draws a packet with a trail on its arc, a ring, a beam and sparks', () => {
    let state = apply(createChamber(5), ...JOIN)
    state = stepChamber(state, 1000, layout)
    state = apply(state, { type: 'orderSent', to: 'm1', orderId: 'o1' }, { type: 'reportSent', from: 'm2' },
      { type: 'orderSent', to: 'all', orderId: 'all1' }, { type: 'memberJoined', id: 'm4' })
    state = stepChamber(state, 200, layout)
    state = apply(state, { type: 'runState', runState: 'killed' })
    const killed = state.effects
    const before = stepChamber(apply(apply(createChamber(5), ...JOIN), { type: 'orderSent', to: 'm1', orderId: 'o' },
      { type: 'reportSent', from: 'm2' }, { type: 'orderSent', to: 'all', orderId: 'a' }), 200, layout).effects
    const view = render(<ChamberEffects effects={[...before, ...killed.map((item) => ({ ...item, id: item.id + 100 }))]}
      width={ROOM.width} height={ROOM.height} warning={false} stasis={false} />)
    const kinds = [...view.container.querySelectorAll<HTMLElement>('[data-effect]')].map((item) => item.dataset.effect)
    expect(kinds).toEqual(expect.arrayContaining(['packet', 'ring', 'beam', 'sparks']))
    const purposes = [...view.container.querySelectorAll<SVGElement>('.cc-packet')].map((item) => item.dataset.purpose)
    expect(purposes).toEqual(expect.arrayContaining(['order', 'report']))
    expect(view.container.querySelectorAll('.cc-packet')[0]!.querySelectorAll('.cc-packet-trail')).toHaveLength(4)
    const sparks = killed.find((item) => item.kind === 'sparks')!
    expect(view.container.querySelectorAll('.cc-spark')).toHaveLength(sparks.kind === 'sparks' ? sparks.sparks.length : 0)
  })

  it('places the packet dot where the state puts it and grows the ring with elapsed time', () => {
    let state = apply(createChamber(5), ...JOIN, { type: 'orderSent', to: 'all', orderId: 'a' })
    const ringAt = (current: ChamberState) => {
      const view = render(<ChamberEffects effects={current.effects} width={ROOM.width} height={ROOM.height}
        warning={false} stasis={false} />)
      const rx = Number(view.container.querySelector('.cc-ring')!.getAttribute('rx'))
      view.unmount()
      return rx
    }
    state = stepChamber(state, 100, layout)
    const early = ringAt(state)
    state = stepChamber(state, 600, layout)
    expect(ringAt(state)).toBeGreaterThan(early)
  })

  it('draws a zero-duration effect fully faded', () => {
    const beam = { kind: 'beam' as const, id: 1, elapsed: 0, duration: 0, x: 100, y: 500, height: 400 }
    const view = render(<ChamberEffects effects={[beam, { ...beam, id: 2, duration: 900 }]} width={ROOM.width}
      height={ROOM.height} warning={false} stasis={false} />)
    const beams = [...view.container.querySelectorAll('.cc-beam')].map((item) => item.getAttribute('opacity'))
    expect(beams).toEqual(['0', '1'])
  })
})

describe('run-state theatrics on the scene root', () => {
  it.each([
    [[{ type: 'runState', runState: 'paused' }], 'cc-stasis'],
    [[{ type: 'runState', runState: 'ending' }], 'cc-lights-dim'],
    [[{ type: 'runState', runState: 'killed' }], 'cc-blackout'],
    [[{ type: 'lastMinute', on: true }], 'cc-warning']
  ] as Array<[ChamberEvent[], string]>)('%j sets %s', (extra, flag) => {
    const view = mount([...JOIN, ...extra])
    tick(0)
    // The march out takes a while: acolytes report, then walk to the door before the lights dim.
    for (let time = 50; time < 60_000 && !view.scene().classList.contains(flag); time += 50) tick(time)
    expect(view.scene().classList.contains(flag)).toBe(true)
    expect(view.scene().getAttribute('aria-hidden')).toBe('true')
  })

  it('draws the STASIS plate while paused, warning lights in the last minute and sparks on kill', () => {
    const paused = mount([...JOIN, { type: 'runState', runState: 'paused' }, { type: 'lastMinute', on: true }])
    tick(0)
    expect(paused.container.querySelector('.cc-stasis-plate')!.textContent).toBe('STASIS')
    expect(paused.all('[data-effect="warning"]')).toHaveLength(1)
    paused.unmount()
    const killed = mount([...JOIN, { type: 'runState', runState: 'killed' }])
    tick(0)
    expect(killed.all('[data-effect="sparks"]')).toHaveLength(1)
    expect(killed.scene().contains(killed.container.querySelector('.cc-effects'))).toBe(true)
  })

  it('leaves no flag class on a plain running scene', () => {
    const view = mount(JOIN)
    tick(0)
    expect(view.scene().className).toBe('cc-scene')
  })
})

describe('reduced motion', () => {
  it('outlines the target plate for an order, every plate for order all, and draws no packets or rings', () => {
    vi.useFakeTimers()
    reduced = true
    const view = mount(JOIN)
    const outlined = () => view.all('.cc-nameplate[data-outlined="true"]').map((plate) => plate.closest<HTMLElement>(
      '.cc-acolyte')!.dataset.memberId)
    expect(outlined()).toEqual([])
    view.rerender(<CultChamber events={[...JOIN, { type: 'orderSent', to: 'm2', orderId: 'o' }]} seed={5}
      members={MEMBERS} onSelectMember={() => undefined} />)
    expect(outlined()).toEqual(['m2'])
    expect(view.all('[data-effect]')).toHaveLength(0)
    act(() => { vi.advanceTimersByTime(OUTLINE_MS) })
    expect(outlined()).toEqual([])
    view.rerender(<CultChamber events={[...JOIN, { type: 'orderSent', to: 'm2', orderId: 'o' },
      { type: 'orderSent', to: 'all', orderId: 'a' }, { type: 'runState', runState: 'paused' }]} seed={5}
    members={MEMBERS} onSelectMember={() => undefined} />)
    expect(outlined()).toEqual(['m1', 'm2', 'm3'])
    expect(view.all('[data-effect]')).toHaveLength(0)
    expect(view.container.querySelectorAll('svg *')).toHaveLength(0)
    expect(view.scene().classList.contains('cc-stasis')).toBe(true)
    expect(view.container.querySelector('.cc-stasis-plate')).not.toBeNull()
    expect(frames.size).toBe(0)
  })

  it('still renders bubbles and the blackout statically', () => {
    reduced = true
    const view = mount([...JOIN, { type: 'bubble', id: 'm1', text: 'Ave Deus <i>Mechanicus</i>' }])
    expect(view.container.querySelector('.cc-bubble')!.textContent).toBe('Ave Deus <i>Mechanicus</i>')
    view.rerender(<CultChamber events={[...JOIN, { type: 'bubble', id: 'm1', text: 'x' },
      { type: 'runState', runState: 'killed' }]} seed={5} members={MEMBERS} onSelectMember={() => undefined} />)
    expect(view.scene().classList.contains('cc-blackout')).toBe(true)
    expect(view.all('[data-effect]')).toHaveLength(0)
  })
})
