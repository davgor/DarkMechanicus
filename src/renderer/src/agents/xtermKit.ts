/**
 * The chat pane's terminal emulator: `@xterm/xterm` 6 with the fit addon and the WebGL renderer
 * (`docs/design/chat-shells.md`, "In the app's window"). See `inertStyles.ts` for how it keeps the production
 * CSP's `style-src 'self'` free of violations.
 */
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import type { IDisposable, ITerminalAddon, ITerminalOptions } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { withInertStyleElements } from './inertStyles'
import type { TerminalKit, TerminalSize } from './terminalView'

const FONT_SIZE = 13

/** What the kit uses of xterm's `Terminal`. */
interface XtermTerminal {
  readonly cols: number
  readonly rows: number
  loadAddon(addon: ITerminalAddon): void
  open(parent: HTMLElement): void
  write(data: string): void
  onData(listener: (data: string) => void): IDisposable
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void
  focus(): void
  dispose(): void
}

interface XtermFit extends ITerminalAddon {
  fit(): void
  proposeDimensions(): TerminalSize | undefined
}

interface XtermWebgl extends ITerminalAddon {
  onContextLoss(listener: () => void): IDisposable
}

/**
 * Whether xterm handles a key: never a Cmd combination, which stays the app menu's on macOS (Cmd+C and Cmd+V
 * through the Edit role, Cmd+W, Cmd+Q); Ctrl+C and every other key go to the CLI.
 */
export function keyGoesToTerminal(event: Pick<KeyboardEvent, 'metaKey'>): boolean {
  return !event.metaKey
}

/** The classes the kit builds on: xterm's in the app, fakes in its unit test. */
export interface XtermParts {
  Terminal: new (options: ITerminalOptions) => XtermTerminal
  FitAddon: new () => XtermFit
  WebglAddon: new () => XtermWebgl
  ResizeObserver: new (callback: () => void) => { observe(target: Element): void; disconnect(): void }
}

/**
 * Loads a WebGL renderer into the terminal. A lost context that the browser does not restore (the addon waits
 * 3 s) ends that addon: it is disposed and a fresh one loaded, both with style elements inert, since disposing
 * puts xterm's DOM renderer back until the new addon replaces it.
 */
function loadWebgl(parts: XtermParts, terminal: XtermTerminal, doc: Document): void {
  const webgl = new parts.WebglAddon()
  const lost = webgl.onContextLoss(() => {
    lost.dispose()
    withInertStyleElements(doc, () => {
      webgl.dispose()
      loadWebgl(parts, terminal, doc)
    })
  })
  terminal.loadAddon(webgl)
}

export function createXtermKit(parts: XtermParts): TerminalKit {
  return {
    create: (host, { theme, fontFamily }) => {
      const terminal = new parts.Terminal({ theme, fontFamily, fontSize: FONT_SIZE })
      const fit = new parts.FitAddon()
      terminal.loadAddon(fit)
      terminal.attachCustomKeyEventHandler(keyGoesToTerminal)
      // Loaded before `open`, the addon sets its renderer as the terminal opens, so xterm never makes a DOM renderer.
      loadWebgl(parts, terminal, host.ownerDocument)
      withInertStyleElements(host.ownerDocument, () => terminal.open(host))
      return {
        write: (data) => terminal.write(data),
        onInput: (listener) => {
          const subscription = terminal.onData(listener)
          return () => subscription.dispose()
        },
        fit: () => {
          const proposed = fit.proposeDimensions()
          // Undefined, or NaN, while the host is hidden or has not been laid out.
          if (proposed === undefined || !(proposed.cols > 0 && proposed.rows > 0)) {
            return null
          }
          fit.fit()
          return { cols: terminal.cols, rows: terminal.rows }
        },
        focus: () => terminal.focus(),
        dispose: () => terminal.dispose()
      }
    },
    observeSize: (element, onChange) => {
      const observer = new parts.ResizeObserver(onChange)
      observer.observe(element)
      return () => observer.disconnect()
    }
  }
}

export const xtermKit = createXtermKit({ Terminal, FitAddon, WebglAddon, ResizeObserver: globalThis.ResizeObserver })
