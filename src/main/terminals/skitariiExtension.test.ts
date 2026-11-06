import { describe, expect, it, vi } from 'vitest'
import frames from '../../../resources/skitarii/mascot/frames.json'
import skitariiExtension, { attach, reducedMotion, type OmpApi } from '../../../resources/skitarii/extension/index'
import {
  BANNER_KEY,
  FramePlayer,
  INDICATOR_KEY,
  MAX_FPS,
  Skitarii,
  frameInterval,
  indicatorRows,
  titleFor,
  type MascotFrames,
  type Paint,
  type SkitariiUi,
  type Timers,
  type Tui
} from '../../../resources/skitarii/extension/skitarii'
import { THINKING_LINES, TOOL_LINES } from '../../../resources/skitarii/extension/voice'

const mascot = frames as MascotFrames
const drill = mascot.loops.drill.sizes.indicator

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
const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '')

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
  it('notices the viewer, startles, articulates a run across the pane, then removes the opening', () => {
    const timers = fakeTimers()
    const ui = fakeUi()
    new Skitarii(mascot, { timers, reducedMotion: false }).start(ui, 'C:\\work\\forge\\')
    expect(ui.titles).toEqual(['Skitarii · forge'])
    const samples: { text: string; left: number; art: string }[] = []
    for (let tick = 0; tick < 100 && ui.widgets.has(BANNER_KEY); tick += 1) {
      const rows = ui.widgets.get(BANNER_KEY)?.render(120) ?? []
      const plain = rows.map(strip)
      const art = plain.slice(0, -2)
      samples.push({
        text: plain.slice(-2).join('\n'),
        left: Math.min(...art.filter((row) => row.trim()).map((row) => row.search(/\S/))),
        art: art.map((row) => row.trim()).join('\n')
      })
      timers.tick()
    }
    expect(samples[0]?.text).toContain('S K I T A R I I')
    expect(samples.some((sample) => sample.text.includes('Oh!'))).toBe(true)
    const running = samples.filter((sample) => sample.text.includes('Coming through'))
    expect(new Set(running.map((sample) => sample.art)).size).toBeGreaterThan(2)
    expect(running.at(-1)!.left - running[0]!.left).toBeGreaterThan(60)
    expect(samples.at(-1)?.text).toContain('Ready')
    expect(ui.widgets.has(BANNER_KEY)).toBe(false)
    expect(timers.live.size).toBe(0)
    const repaints = vi.mocked(ui.tui.requestRender).mock.calls.length
    timers.tick(10)
    expect(ui.tui.requestRender).toHaveBeenCalledTimes(repaints)
  })

  it('reflows every animated frame safely during narrow, zero-width and wide resizes', () => {
    const timers = fakeTimers()
    const ui = fakeUi()
    new Skitarii(mascot, { timers, reducedMotion: false }).start(ui, '/forge')
    const banner = ui.widgets.get(BANNER_KEY)!
    for (let tick = 0; tick < 30; tick += 1) {
      for (const width of [120, 25, 1, 0, 64, 160]) {
        const rows = banner.render(width)
        for (const row of rows) expect(strip(row).length).toBeLessThanOrEqual(width)
        expect(rows.join('')).not.toContain('undefined')
      }
      timers.tick()
    }
    expect(banner.render(160).some((row) => strip(row).trim().includes('▀'))).toBe(true)
  })

  it('stops a disposed opening and cannot resurrect it on later ticks', () => {
    const timers = fakeTimers()
    const ui = fakeUi()
    new Skitarii(mascot, { timers, reducedMotion: false }).start(ui, '/forge')
    ui.widgets.get(BANNER_KEY)?.dispose?.()
    const repaints = vi.mocked(ui.tui.requestRender).mock.calls.length
    timers.tick(100)
    expect(timers.live.size).toBe(0)
    expect(ui.tui.requestRender).toHaveBeenCalledTimes(repaints)
  })

  it('drops an earlier opening when a process starts a resumed session', () => {
    const timers = fakeTimers()
    const ui = fakeUi()
    const skitarii = new Skitarii(mascot, { timers, reducedMotion: false })
    skitarii.start(ui, '/forge')
    skitarii.start(ui, '/forge', true)
    expect(ui.widgets.has(BANNER_KEY)).toBe(false)
    expect(timers.live.size).toBe(0)
  })

  it.each([0, 8, 24, 42])('hands off immediately to working at opening tick %s without stale completion', (tick) => {
    const timers = fakeTimers()
    const ui = fakeUi()
    const skitarii = new Skitarii(mascot, { timers, reducedMotion: false })
    skitarii.start(ui, '/forge')
    timers.tick(tick)
    skitarii.workStarted(ui)
    const indicator = ui.widgets.get(INDICATOR_KEY)
    expect(ui.widgets.has(BANNER_KEY)).toBe(false)
    expect(timers.live.size).toBe(1)
    timers.tick(100)
    expect(ui.widgets.get(INDICATOR_KEY)).toBe(indicator)
    expect(ui.widgets.has(BANNER_KEY)).toBe(false)
    skitarii.workEnded(ui)
    expect(timers.live.size).toBe(0)
  })

  it('stops the drill timer on widget disposal or process shutdown', () => {
    const timers = fakeTimers()
    const ui = fakeUi()
    const skitarii = new Skitarii(mascot, { timers, reducedMotion: false })
    skitarii.workStarted(ui)
    ui.widgets.get(INDICATOR_KEY)?.dispose?.()
    expect(timers.live.size).toBe(0)
    skitarii.workEnded(ui)
    skitarii.workStarted(ui)
    skitarii.shutdown()
    expect(timers.live.size).toBe(0)
  })

  it('shows only the title when told the session is resumed', () => {
    const ui = fakeUi()
    new Skitarii(mascot, { timers: fakeTimers(), reducedMotion: false }).start(ui, '/home/a/forge', true)
    expect(ui.titles).toEqual(['Skitarii · forge'])
    expect(ui.widgets.has(BANNER_KEY)).toBe(false)
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
    const before = ui.widgets.get(BANNER_KEY)?.render(120)
    timers.tick(100)
    expect(ui.widgets.get(BANNER_KEY)?.render(120)).toEqual(before)
    expect(before?.map(strip).join('\n')).toContain('Ready')
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
  it('hides the drill in a pane that cannot hold its full rows', () => {
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

  it.each(['reduced', 'none'])('holds still under the current OMP tui.motion=%s preset', (motion) => {
    const { pi, handlers } = fakePi()
    const timers = fakeTimers()
    attach(pi, (id) => id === 'tui.motion' ? { get: () => motion } : undefined, timers)
    const ui = fakeUi()
    handlers.get('session_start')?.({}, { ui, hasUI: true, cwd: '/forge' })
    const before = ui.widgets.get(BANNER_KEY)?.render(120)
    timers.tick(60)
    expect(ui.widgets.get(BANNER_KEY)?.render(120)).toEqual(before)
    expect(before?.map(strip).join('\n')).toContain('Ready')
    expect(timers.live.size).toBe(0)
  })
})

describe('the OMP entry at session start, new or resumed', () => {
  function fakePi() {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>()
    const pi: OmpApi = { on: (event, handler) => handlers.set(event, handler as never), pi: { settings: 'scope' } }
    return { pi, handlers }
  }

  const user = { type: 'message', message: { role: 'user' } }
  const assistant = { type: 'message', message: { role: 'assistant' } }
  const modelChange = { type: 'model_change' }
  function startWith(entries: unknown[] | 'unreadable' | undefined) {
    const { pi, handlers } = fakePi()
    const timers = fakeTimers()
    const skitarii = attach(pi, null, timers)
    const ui = fakeUi()
    const sessionManager =
      entries === undefined
        ? undefined
        : {
            getEntries: () => {
              if (entries === 'unreadable') throw new Error('not ready')
              return entries
            }
          }
    const ctx = { ui, hasUI: true, cwd: '/home/a/forge', sessionManager }
    handlers.get('session_start')?.({}, ctx)
    return { ui, handlers, skitarii, ctx }
  }

  it('shows the banner and the title on a new session, which has no messages yet', () => {
    for (const entries of [[], [modelChange], undefined, 'unreadable' as const]) {
      const { ui } = startWith(entries)
      expect(ui.titles).toEqual(['Skitarii · forge'])
      expect(ui.widgets.has(BANNER_KEY)).toBe(true)
    }
  })

  it('shows no banner on a resumed session, but still sets the title and keeps the working indicator', () => {
    for (const entries of [[modelChange, user, assistant], [user]]) {
      const { ui, handlers, skitarii, ctx } = startWith(entries)
      expect(ui.titles).toEqual(['Skitarii · forge'])
      expect(ui.widgets.has(BANNER_KEY)).toBe(false)
      handlers.get('agent_start')?.({}, ctx)
      handlers.get('turn_start')?.({}, ctx)
      expect(skitarii.working).toBe(true)
      expect(ui.widgets.has(INDICATOR_KEY)).toBe(true)
      handlers.get('agent_end')?.({}, ctx)
      expect(ui.widgets.has(INDICATOR_KEY)).toBe(false)
    }
  })
})
