/**
 * The pure parts of the Skitarii OMP extension (`index.ts` is the entry OMP loads with `-e`): which mascot frame shows
 * when, the banner and indicator rows, the working messages and the terminal title. Nothing here imports OMP, so the
 * app's tests run it with fake timers and a fake UI.
 *
 * What OMP lets an extension draw is pinned in `docs/reports/omp-cli.md`, 10: no header or logo replacement, so the
 * banner is a widget above the editor (a component, since a string widget stops at 10 lines and the banner is 16);
 * the loader's own spinner glyph comes from the theme, so the drill mascot plays as a second widget while OMP works;
 * the label beside the loader is `setWorkingMessage`; the title is `setTitle` (OSC 0).
 */
import { BANNER_LINE, THINKING_LINES, TOOL_LINES } from './voice'

/** A frame size of one loop in `resources/skitarii/mascot/frames.json` (`scripts/mascotFrames.mjs`). */
interface FrameSize {
  rows: number
  cols: number
  frames: ReadonlyArray<{ name: string; rows: readonly string[] }>
}

interface MascotLoop {
  fps: number
  sizes: { banner: FrameSize; indicator: FrameSize }
}

export interface MascotFrames {
  loops: { idle: MascotLoop; drill: MascotLoop }
}

/** The fastest an animation here runs: the report keeps custom animation at or below about 12 fps. */
export const MAX_FPS = 12
/** How many times the banner's idle loop plays before it holds still. */
export const BANNER_CYCLES = 3
export const BANNER_KEY = 'skitarii-banner'
export const INDICATOR_KEY = 'skitarii-indicator'
const APP_NAME = 'Skitarii'

export interface Timers {
  setInterval: (callback: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

/**
 * Steps through one loop's frames on a timer. `cycles` plays the loop that many times and then holds the first frame;
 * without it the loop runs until `stop`. With reduced motion no timer is ever set: the first frame shows and holds.
 */
export class FramePlayer {
  #index = 0
  #ticks = 0
  #handle: unknown = null

  constructor(
    private readonly size: FrameSize,
    private readonly fps: number,
    private readonly options: { timers: Timers; reducedMotion: boolean; onFrame: () => void; cycles?: number }
  ) {}

  get rows(): readonly string[] {
    return this.size.frames[this.#index]?.rows ?? []
  }

  get index(): number {
    return this.#index
  }

  get playing(): boolean {
    return this.#handle !== null
  }

  play(): void {
    if (this.playing || this.options.reducedMotion || this.size.frames.length < 2) return
    this.#index = 0
    this.#ticks = 0
    this.#handle = this.options.timers.setInterval(() => this.#tick(), frameInterval(this.fps))
  }

  /** Stops the timer and goes back to the first frame. */
  stop(): void {
    if (this.#handle !== null) this.options.timers.clearInterval(this.#handle)
    this.#handle = null
    this.#index = 0
  }

  #tick(): void {
    this.#ticks += 1
    const { cycles } = this.options
    if (cycles !== undefined && this.#ticks >= cycles * this.size.frames.length) {
      this.stop()
    } else {
      this.#index = this.#ticks % this.size.frames.length
    }
    this.options.onFrame()
  }
}

/** Milliseconds between frames for a loop's `fps`, never faster than `MAX_FPS`. */
export function frameInterval(fps: number): number {
  return Math.round(1000 / Math.min(Math.max(fps, 1), MAX_FPS))
}

/** The terminal title for a chat in `cwd`: Skitarii and the folder's name, where OMP's own says `π > <folder>`. */
export function titleFor(cwd: string): string {
  const folder = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return folder === '' ? APP_NAME : `${APP_NAME} · ${folder}`
}

/** The theme's painter as the extension uses it (OMP's `Theme`). */
export interface Paint {
  fg: (color: string, text: string) => string
  bold: (text: string) => string
}

/**
 * The banner: the mascot frame on the left, SKITARII in bone and the Mechanicus line in brass beside its middle rows.
 * Each row starts with one column of padding, as OMP's string widgets do. A pane narrower than the mascot gets the text
 * only, and the text is cut to fit.
 */
export function bannerRows(frame: readonly string[], cols: number, width: number, paint: Paint): string[] {
  const textRows = [paint.bold(paint.fg('toolTitle', 'S K I T A R I I')), paint.fg('customMessageLabel', BANNER_LINE)]
  const plain = ['S K I T A R I I', BANNER_LINE]
  const withMascot = width >= cols + 3
  const room = Math.max(0, width - 1 - (withMascot ? cols + 3 : 0))
  const text = plain.map((line, i) => (line.length <= room ? textRows[i] : line.slice(0, room)))
  if (!withMascot) return text.map((line) => ` ${line}`)
  const top = Math.max(0, Math.floor(frame.length / 2) - 1)
  return frame.map((row, i) => {
    const beside = i >= top && i < top + text.length ? `   ${text[i - top]}` : ''
    return ` ${row}${beside}`
  })
}

/** The working indicator: the drill mascot frame, or nothing when the pane is narrower than it. */
export function indicatorRows(frame: readonly string[], cols: number, width: number): string[] {
  return width >= cols + 1 ? frame.map((row) => ` ${row}`) : []
}

/** Cycles through one list of lines, starting at its first. */
class LineCycle {
  #next = 0
  constructor(private readonly lines: readonly string[]) {}
  take(): string {
    const line = this.lines[this.#next % this.lines.length] ?? ''
    this.#next += 1
    return line
  }
}

/** A component as OMP's TUI renders it. */
interface Component {
  render: (width: number) => readonly string[]
  invalidate: () => void
  dispose?: () => void
}

/** What the extension asks of OMP's TUI: a repaint after a frame changed. */
export interface Tui {
  requestRender: () => void
}

type WidgetFactory = (tui: Tui, theme: Paint) => Component

/** The part of OMP's `ctx.ui` the extension uses. */
export interface SkitariiUi {
  setWidget: (key: string, content: WidgetFactory | undefined, options?: { placement?: 'aboveEditor' | 'belowEditor' }) => void
  setWorkingMessage: (message?: string) => void
  setTitle: (title: string) => void
}

/**
 * The extension's state for one OMP process: the banner from session start until the first turn, the drill indicator
 * while the agent works, the Mechanicus working messages, and the title. `index.ts` calls these from OMP's events.
 */
export class Skitarii {
  #banner: FramePlayer | null = null
  #indicator: FramePlayer | null = null
  #thinking = new LineCycle(THINKING_LINES)
  #tools = new LineCycle(TOOL_LINES)
  #working = false
  /** Whether the working message shown is a tool line, so the model's next turn goes back to a thinking line. */
  #onTool = false

  constructor(
    private readonly frames: MascotFrames,
    private readonly options: { timers: Timers; reducedMotion: boolean }
  ) {}

  get working(): boolean {
    return this.#working
  }

  /**
   * Session start: the title, then the banner, its idle loop played `BANNER_CYCLES` times and then still. A resumed
   * session already shows its history, so it gets the title and no banner.
   */
  start(ui: SkitariiUi, cwd: string, resumed = false): void {
    ui.setTitle(titleFor(cwd))
    if (resumed) return
    const { idle } = this.frames.loops
    const size = idle.sizes.banner
    ui.setWidget(BANNER_KEY, (tui, theme) => {
      this.#banner?.stop()
      const player = new FramePlayer(size, idle.fps, { ...this.options, cycles: BANNER_CYCLES, onFrame: () => tui.requestRender() })
      this.#banner = player
      player.play()
      return frameComponent(player, (rows, width) => bannerRows(rows, size.cols, width, theme))
    })
  }

  /** The agent started working: the banner gives way to the drill indicator, and the first thinking line shows. */
  workStarted(ui: SkitariiUi): void {
    if (this.#working) return
    ui.setWorkingMessage(this.#thinking.take())
    this.#onTool = false
    this.#working = true
    this.#dropBanner(ui)
    const { drill } = this.frames.loops
    const size = drill.sizes.indicator
    ui.setWidget(INDICATOR_KEY, (tui) => {
      this.#indicator?.stop()
      const player = new FramePlayer(size, drill.fps, { ...this.options, onFrame: () => tui.requestRender() })
      this.#indicator = player
      player.play()
      return frameComponent(player, (rows, width) => indicatorRows(rows, size.cols, width))
    })
  }

  /** A tool started running. */
  toolStarted(ui: SkitariiUi): void {
    if (!this.#working) return
    ui.setWorkingMessage(this.#tools.take())
    this.#onTool = true
  }

  /** A new turn: after a tool ran, the model streams again under a thinking line. */
  turnStarted(ui: SkitariiUi): void {
    if (!this.#working || !this.#onTool) return
    ui.setWorkingMessage(this.#thinking.take())
    this.#onTool = false
  }

  /** The agent is idle again: the indicator stops and goes, and OMP's own working message comes back. */
  workEnded(ui: SkitariiUi): void {
    if (!this.#working) return
    this.#working = false
    this.#indicator?.stop()
    this.#indicator = null
    ui.setWidget(INDICATOR_KEY, undefined)
    ui.setWorkingMessage()
  }

  /** The session is closing: no timer may outlive it. */
  shutdown(): void {
    this.#banner?.stop()
    this.#indicator?.stop()
    this.#banner = null
    this.#indicator = null
  }

  #dropBanner(ui: SkitariiUi): void {
    if (this.#banner === null) return
    this.#banner.stop()
    this.#banner = null
    ui.setWidget(BANNER_KEY, undefined)
  }
}

/** A widget that renders its player's current frame, the same rows (by reference) while the frame and width hold. */
function frameComponent(player: FramePlayer, rowsFor: (frame: readonly string[], width: number) => string[]): Component {
  let cache: { index: number; width: number; rows: readonly string[] } | null = null
  return {
    render(width) {
      if (cache === null || cache.index !== player.index || cache.width !== width) {
        cache = { index: player.index, width, rows: rowsFor(player.rows, width) }
      }
      return cache.rows
    },
    invalidate() {
      cache = null
    },
    dispose() {
      player.stop()
    }
  }
}
