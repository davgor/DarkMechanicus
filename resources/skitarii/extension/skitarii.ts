/**
 * Skitarii's opening cutscene, drill indicator, working messages and terminal title.
 * Nothing here imports OMP, so the app's tests exercise the widget lifecycle with fake timers.
 *
 * OMP exposes a non-modal widget above the editor, not a replaceable header. The opening uses a component
 * (string widgets stop at ten rows) and gives the space back after a single notice / surprise / scurry sequence.
 * The drill mascot remains a separate widget while OMP works;
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
  loops: { idle: MascotLoop; run: MascotLoop; drill: MascotLoop }
}

/** The fastest an animation here runs: the report keeps custom animation at or below about 12 fps. */
export const MAX_FPS = 12
export const BANNER_KEY = 'skitarii-banner'
export const INDICATOR_KEY = 'skitarii-indicator'
const APP_NAME = 'Skitarii'

export interface Timers {
  setInterval: (callback: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

/**
 * Steps through one loop's frames on a timer until `stop`.
 * With reduced motion no timer is ever set: the first frame shows and holds.
 */
export class FramePlayer {
  #index = 0
  #handle: unknown = null

  constructor(
    private readonly size: FrameSize,
    private readonly fps: number,
    private readonly options: { timers: Timers; reducedMotion: boolean; onFrame: () => void }
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
    this.#handle = this.options.timers.setInterval(() => this.#tick(), frameInterval(this.fps))
  }

  /** Stops the timer and goes back to the first frame. */
  stop(): void {
    if (this.#handle !== null) this.options.timers.clearInterval(this.#handle)
    this.#handle = null
    this.#index = 0
  }

  #tick(): void {
    this.#index = (this.#index + 1) % this.size.frames.length
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
 * One 4.4-second opening. Its position is derived from the current width on every render, so resizing cannot leave
 * stale columns or split ANSI cells. Very narrow panes get only the caption; the editor remains OMP's throughout.
 */
class Opening implements Component {
  #tick = 0
  #handle: unknown = null
  #cache: { tick: number; width: number; rows: readonly string[] } | null = null

  constructor(
    private readonly frames: MascotFrames,
    private readonly options: { timers: Timers; reducedMotion: boolean },
    private readonly tui: Tui,
    private readonly paint: Paint,
    private readonly finish: () => void
  ) {
    if (!options.reducedMotion) {
      this.#handle = options.timers.setInterval(() => {
        this.#tick += 1
        if (this.#tick >= 44) {
          this.dispose()
          this.finish()
        } else {
          this.tui.requestRender()
        }
      }, frameInterval(10))
    }
  }

  render(width: number): readonly string[] {
    if (this.#cache?.tick === this.#tick && this.#cache.width === width) return this.#cache.rows
    const still = this.options.reducedMotion
    const running = !still && this.#tick >= 12 && this.#tick < 40
    const surprised = !still && this.#tick >= 5 && this.#tick < 12
    const ready = still || this.#tick >= 40
    const loop = surprised || running ? this.frames.loops.run : this.frames.loops.idle
    const size = loop.sizes.banner
    // The final run pose is the open-palmed skid / startled reaction, never part of the stride loop.
    const index = surprised ? size.frames.length - 1 : running ? (this.#tick - 12) % (size.frames.length - 1) : ready ? 0 : this.#tick < 3 ? 0 : 2
    const frame = size.frames[index]?.rows ?? []
    const travel = Math.max(0, width - size.cols - 2)
    const progress = running ? (this.#tick - 12) / 27 : ready && !still ? 1 : 0
    const left = 1 + Math.floor(travel * progress)
    const rows = width >= size.cols + 2 ? frame.map((row) => `${' '.repeat(left)}${row}`) : []
    const caption = ready ? 'Ready. The Omnissiah guides this forge.' : surprised ? 'Oh! A visitor!' : running ? 'Coming through! Mind the robes.' : BANNER_LINE
    if (width > 0) {
      const room = Math.max(0, width - 1)
      rows.push(` ${this.paint.bold(this.paint.fg('toolTitle', 'S K I T A R I I'.slice(0, room)))}`)
      rows.push(` ${this.paint.fg('customMessageLabel', caption.slice(0, room))}`)
    }
    this.#cache = { tick: this.#tick, width, rows }
    return rows
  }

  invalidate(): void {
    this.#cache = null
  }

  dispose(): void {
    if (this.#handle !== null) this.options.timers.clearInterval(this.#handle)
    this.#handle = null
  }
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
  #banner: Opening | null = null
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
   * A fresh session gets one opening, then the widget is removed. Resumed conversation gets only the title.
   * Reduced motion gets a static ready mascot until the first turn, with no timer.
   */
  start(ui: SkitariiUi, cwd: string, resumed = false): void {
    this.#dropBanner(ui)
    ui.setTitle(titleFor(cwd))
    if (resumed) return
    ui.setWidget(BANNER_KEY, (tui, theme) => {
      this.#banner?.dispose()
      const opening = new Opening(this.frames, this.options, tui, theme, () => this.#dropBanner(ui))
      this.#banner = opening
      return opening
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
    this.#banner?.dispose()
    this.#indicator?.stop()
    this.#banner = null
    this.#indicator = null
  }

  #dropBanner(ui: SkitariiUi): void {
    if (this.#banner === null) return
    this.#banner.dispose()
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
