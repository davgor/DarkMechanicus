import { describe, expect, it, vi } from 'vitest'
import frames from '../../../resources/skitarii/mascot/frames.json'
import skitariiExtension, { attach, reducedMotion, type OmpApi } from '../../../resources/skitarii/extension/index'
import {
  BANNER_CYCLES,
  BANNER_KEY,
  FramePlayer,
  INDICATOR_KEY,
  MAX_FPS,
  Skitarii,
  bannerRows,
  frameInterval,
  indicatorRows,
  titleFor,
  type MascotFrames,
  type Paint,
  type SkitariiUi,
  type Timers,
  type Tui
} from '../../../resources/skitarii/extension/skitarii'
import { BANNER_LINE, THINKING_LINES, TOOL_LINES } from '../../../resources/skitarii/extension/voice'

const mascot = frames as MascotFrames
const drill = mascot.loops.drill.sizes.indicator
const idle = mascot.loops.idle.sizes.banner

/** Timers that only run when the test ticks them. */
function fakeTimers(): Timers & { live: Map<number, { callback: () => void; ms: number }>; tick: (times?: number) => void } {
  const live = new Map<number, { callback: () => void; ms: number }>()
  let next = 1
  return {
    live,
    setInterval: (callback, ms) => {
      const id = next++
      live.set(id, { callback, ms })
      return id
    },
    clearInterval: (handle) => {
      live.delete(handle as number)
    },
    tick(times = 1) {
      for (let i = 0; i < times; i += 1) for (const timer of Array.from(live.values())) timer.callback()
    }
  }
}

const plainPaint: Paint = { fg: (_color, text) => text, bold: (text) => text }

type Widget = Parameters<SkitariiUi['setWidget']>[1]

/** A fake `ctx.ui` that mounts widget factories the way OMP does (called once, the old one disposed). */
function fakeUi() {
  const tui: Tui = { requestRender: vi.fn() }
  const widgets = new Map<string, ReturnType<NonNullable<Widget>>>()
  const ui = {
    tui,
    widgets,
    titles: [] as string[],
    messages: [] as (string | undefined)[],
    setTitle: (title: string) => ui.titles.push(title),
    setWorkingMessage: (message?: string) => ui.messages.push(message),
    setWidget: (key: string, content: Widget) => {
      widgets.get(key)?.dispose?.()
      widgets.delete(key)
      if (content !== undefined) widgets.set(key, content(tui, plainPaint))
    }
  }
  return ui
}

describe('FramePlayer', () => {
  it('loops until stopped, at the loop fps, and goes back to the first frame', () => {
    const timers = fakeTimers()
    const onFrame = vi.fn()
    const player = new FramePlayer(drill, 4, { timers, reducedMotion: false, onFrame })
    player.play()
    expect([...timers.live.values()][0]?.ms).toBe(250)
    timers.tick(drill.frames.length + 2)
    expect(player.index).toBe(2)
    expect(player.rows).toBe(drill.frames[2]?.rows)
    expect(onFrame).toHaveBeenCalledTimes(drill.frames.length + 2)
    player.stop()
    expect(player.playing).toBe(false)
    expect(player.index).toBe(0)
    expect(timers.live.size).toBe(0)
  })

  it('plays a counted loop that many times and then holds the first frame', () => {
    const timers = fakeTimers()
    const player = new FramePlayer(idle, 6, { timers, reducedMotion: false, onFrame: () => {}, cycles: 2 })
    player.play()
    timers.tick(2 * idle.frames.length - 1)
    expect(player.playing).toBe(true)
    timers.tick()
    expect(player.playing).toBe(false)
    expect(player.index).toBe(0)
  })

  it('never sets a timer with reduced motion, nor for a one-frame loop', () => {
    const timers = fakeTimers()
    new FramePlayer(drill, 4, { timers, reducedMotion: true, onFrame: () => {} }).play()
    new FramePlayer({ ...drill, frames: drill.frames.slice(0, 1) }, 4, { timers, reducedMotion: false, onFrame: () => {} }).play()
    expect(timers.live.size).toBe(0)
  })

  it('caps the frame rate', () => {
    expect(frameInterval(60)).toBe(Math.round(1000 / MAX_FPS))
    expect(frameInterval(0)).toBe(1000)
    expect(frameInterval(mascot.loops.idle.fps)).toBe(167)
  })
})

describe('Skitarii', () => {
  it('shows the title and the banner at session start, which animates BANNER_CYCLES times and then holds still', () => {
    const timers = fakeTimers()
    const ui = fakeUi()
    new Skitarii(mascot, { timers, reducedMotion: false }).start(ui, 'C:\\work\\forge\\')
    expect(ui.titles).toEqual(['Skitarii · forge'])
    const banner = ui.widgets.get(BANNER_KEY)
    expect(banner?.render(120)[0]).toBe(` ${idle.frames[0]?.rows[0]}`)
    timers.tick()
    expect(ui.tui.requestRender).toHaveBeenCalledTimes(1)
    expect(banner?.render(120)[0]).toBe(` ${idle.frames[1]?.rows[0]}`)
    timers.tick(BANNER_CYCLES * idle.frames.length)
    expect(timers.live.size).toBe(0)
    expect(banner?.render(120)[0]).toBe(` ${idle.frames[0]?.rows[0]}`)
  })

  it('plays the drill loop while working and stops it when idle', () => {
    const timers = fakeTimers()
    const ui = fakeUi()
    const skitarii = new Skitarii(mascot, { timers, reducedMotion: false })
    skitarii.start(ui, '/home/a/forge')
    skitarii.workStarted(ui)
    expect(skitarii.working).toBe(true)
    expect(ui.widgets.has(BANNER_KEY)).toBe(false)
    const indicator = ui.widgets.get(INDICATOR_KEY)
    expect(timers.live.size).toBe(1)
    expect([...timers.live.values()][0]?.ms).toBe(frameInterval(mascot.loops.drill.fps))
    const seen = new Set<string>()
    for (let i = 0; i < drill.frames.length; i += 1) {
      seen.add(indicator?.render(80).join('\n') ?? '')
      timers.tick()
    }
    expect(seen.size).toBe(new Set(drill.frames.map((frame) => frame.rows.join('\n'))).size)
    skitarii.workEnded(ui)
    expect(skitarii.working).toBe(false)
    expect(ui.widgets.has(INDICATOR_KEY)).toBe(false)
    expect(timers.live.size).toBe(0)
    expect(ui.messages.at(-1)).toBeUndefined()
  })

})

describe('Skitarii: motion, voice and shutdown', () => {
  it('holds the first frames still with reduced motion', () => {
    const timers = fakeTimers()
    const ui = fakeUi()
    const skitarii = new Skitarii(mascot, { timers, reducedMotion: true })
    skitarii.start(ui, '/forge')
    expect(ui.widgets.get(BANNER_KEY)?.render(120)[0]).toBe(` ${idle.frames[0]?.rows[0]}`)
    skitarii.workStarted(ui)
    expect(ui.widgets.get(INDICATOR_KEY)?.render(80)).toEqual(drill.frames[0]?.rows.map((row) => ` ${row}`))
    expect(timers.live.size).toBe(0)
  })

  it('speaks a thinking line while the model streams and a tool line while a tool runs', () => {
    const ui = fakeUi()
    const skitarii = new Skitarii(mascot, { timers: fakeTimers(), reducedMotion: false })
    skitarii.toolStarted(ui)
    skitarii.turnStarted(ui)
    expect(ui.messages).toEqual([])
    skitarii.workStarted(ui)
    skitarii.turnStarted(ui)
    skitarii.toolStarted(ui)
    skitarii.turnStarted(ui)
    skitarii.workStarted(ui)
    expect(ui.messages).toEqual([THINKING_LINES[0], TOOL_LINES[0], THINKING_LINES[1]])
    expect(THINKING_LINES).toContain('Communing with the machine spirit')
    expect(TOOL_LINES).toContain('Applying the sacred unguents')
  })

  it('leaves no timer running after shutdown', () => {
    const timers = fakeTimers()
    const ui = fakeUi()
    const skitarii = new Skitarii(mascot, { timers, reducedMotion: false })
    skitarii.start(ui, '/forge')
    skitarii.workStarted(ui)
    skitarii.workEnded(ui)
    skitarii.workEnded(ui)
    skitarii.start(ui, '/forge')
    skitarii.shutdown()
    expect(timers.live.size).toBe(0)
  })
})

describe('rows and title', () => {
  it('puts SKITARII and the Mechanicus line beside the mascot, painted bone and brass', () => {
    const paint: Paint = { fg: (color, text) => `<${color}>${text}`, bold: (text) => `*${text}` }
    const rows = bannerRows(['a', 'b', 'c', 'd'], 1, 80, paint)
    expect(rows).toEqual([' a', ' b   *<toolTitle>S K I T A R I I', ` c   <customMessageLabel>${BANNER_LINE}`, ' d'])
  })

  it('drops the mascot and cuts the text in a narrow pane', () => {
    expect(bannerRows(idle.frames[0]?.rows ?? [], idle.cols, 12, plainPaint)).toEqual([' S K I T A R', ` ${BANNER_LINE.slice(0, 11)}`])
    expect(indicatorRows(drill.frames[0]?.rows ?? [], drill.cols, drill.cols)).toEqual([])
  })

  it('names the folder in the title', () => {
    expect(titleFor('/home/a/forge')).toBe('Skitarii · forge')
    expect(titleFor('/')).toBe('Skitarii')
  })
})

describe('the OMP entry', () => {
  function fakePi() {
    const handlers = new Map<string, (event: unknown, ctx: { ui: SkitariiUi; hasUI: boolean; cwd: string }) => void>()
    const pi: OmpApi = { on: (event, handler) => handlers.set(event, handler), pi: { settings: 'scope' } }
    return { pi, handlers }
  }

  it('wires session start, work and shutdown to OMP events, only where OMP has a UI', () => {
    const timers = fakeTimers()
    const { pi, handlers } = fakePi()
    const skitarii = attach(pi, null, timers)
    const ui = fakeUi()
    handlers.get('session_start')?.({}, { ui, hasUI: false, cwd: '/forge' })
    expect(ui.titles).toEqual([])
    handlers.get('session_start')?.({}, { ui, hasUI: true, cwd: '/forge' })
    handlers.get('agent_start')?.({}, { ui, hasUI: true, cwd: '/forge' })
    handlers.get('tool_execution_start')?.({}, { ui, hasUI: true, cwd: '/forge' })
    handlers.get('turn_start')?.({}, { ui, hasUI: true, cwd: '/forge' })
    expect(skitarii.working).toBe(true)
    handlers.get('agent_end')?.({}, { ui, hasUI: true, cwd: '/forge' })
    expect(skitarii.working).toBe(false)
    handlers.get('session_start')?.({}, { ui, hasUI: true, cwd: '/forge' })
    handlers.get('session_shutdown')?.({}, { ui, hasUI: true, cwd: '/forge' })
    expect(timers.live.size).toBe(0)
  })

  it("registers its handlers when OMP loads it, animating when OMP's settings cannot be read", async () => {
    const { pi, handlers } = fakePi()
    await skitariiExtension(pi)
    expect([...handlers.keys()]).toEqual(['session_start', 'agent_start', 'turn_start', 'tool_execution_start', 'agent_end', 'session_shutdown'])
  })

  it("holds still when OMP's display.shimmer is disabled", () => {
    const { pi } = fakePi()
    const scopes: unknown[] = []
    const lookup = (value: unknown) => (id: string) => (id === 'display.shimmer' ? { get: (scope: unknown) => (scopes.push(scope), value) } : undefined)
    expect(reducedMotion(pi, lookup('disabled'))).toBe(true)
    expect(scopes).toEqual(['scope'])
    expect(reducedMotion(pi, lookup('classic'))).toBe(false)
    expect(reducedMotion(pi, null)).toBe(false)
    expect(reducedMotion(pi, () => ({ get: () => { throw new Error('Settings not initialized') } }))).toBe(false)
    const timers = fakeTimers()
    const ui = fakeUi()
    const { pi: still, handlers } = fakePi()
    attach(still, lookup('disabled'), timers)
    handlers.get('session_start')?.({}, { ui, hasUI: true, cwd: '/forge' })
    handlers.get('agent_start')?.({}, { ui, hasUI: true, cwd: '/forge' })
    expect(timers.live.size).toBe(0)
  })
})
