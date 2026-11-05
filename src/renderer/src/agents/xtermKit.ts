/**
 * The chat pane's terminal emulator: `@xterm/xterm` 6 with the fit addon, the WebGL renderer, grapheme
 * widths, link opening and OSC 52 copy
 * (`docs/design/chat-shells.md`, "In the app's window"). See `inertStyles.ts` for how it keeps the production
 * CSP's `style-src 'self'` free of violations.
 */
import { ClipboardAddon } from '@xterm/addon-clipboard'
import type { IClipboardProvider } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import type { IDisposable, ITerminalAddon, ITerminalOptions } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { withInertStyleElements } from './inertStyles'
import { modifiedEnter, type KeyModes } from './terminalKeys'
import type { TerminalKit, TerminalSize } from './terminalView'

const FONT_SIZE = 13

type CsiParams = readonly (number | number[])[]

/** What the kit uses of xterm's `Terminal`. */
interface XtermTerminal {
  readonly cols: number
  readonly rows: number
  loadAddon(addon: ITerminalAddon): void
  open(parent: HTMLElement): void
  write(data: string): void
  onData(listener: (data: string) => void): IDisposable
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void
  input(data: string, wasUserInput?: boolean): void
  readonly parser: {
    registerCsiHandler(id: { prefix?: string; final: string }, callback: (params: CsiParams) => boolean): IDisposable
  }
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
function keyGoesToTerminal(event: Pick<KeyboardEvent, 'metaKey'>): boolean {
  return !event.metaKey
}

/** Whether the click that activates a link was made with the key that asks for it: Ctrl, or Cmd on macOS. */
function opensLink(event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>): boolean {
  return event.ctrlKey || event.metaKey
}

/** The classes the kit builds on: xterm's in the app, fakes in its unit test. */
export interface XtermParts {
  Terminal: new (options: ITerminalOptions) => XtermTerminal
  FitAddon: new () => XtermFit
  WebglAddon: new () => XtermWebgl
  /** Grapheme-clustered Unicode widths, as OMP's layout counts them. */
  UnicodeGraphemesAddon: new () => ITerminalAddon
  /** Makes plain URLs in the output clickable. */
  WebLinksAddon: new (handler: (event: MouseEvent, uri: string) => void) => ITerminalAddon
  /** OSC 52: lets the CLI put text on the clipboard. */
  ClipboardAddon: new (base64: undefined, provider: IClipboardProvider) => ITerminalAddon
  /** Opens a link through the app's external-open path (which refuses anything but http, https and mailto). */
  openLink(url: string): void
  writeClipboard(text: string): Promise<void>
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

/** Follows the keyboard modes the CLI switches on and off (`terminalKeys.ts`); xterm itself carries on with each sequence. */
function trackKeyModes(terminal: XtermTerminal): KeyModes {
  const modes: KeyModes = { win32: false, modifyOtherKeys: false }
  const has = (params: CsiParams, value: number): boolean => params.some((param) => param === value)
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    modes.win32 ||= has(params, 9001)
    return false
  })
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    modes.win32 &&= !has(params, 9001)
    return false
  })
  terminal.parser.registerCsiHandler({ prefix: '>', final: 'm' }, (params) => {
    // `CSI > 4 ; 2 m` sets level 2; `CSI > 4 m` (or level 0 or 1) resets it.
    if (params[0] === 4) {
      modes.modifyOtherKeys = params[1] === 2
    }
    return false
  })
  return modes
}

/** The addons every terminal gets besides fit and WebGL: grapheme widths, plain-URL links, and OSC 52 copy. */
function loadContentAddons(parts: XtermParts, terminal: XtermTerminal, activate: LinkActivate): void {
  terminal.loadAddon(new parts.UnicodeGraphemesAddon())
  terminal.loadAddon(new parts.WebLinksAddon(activate))
  // Write-only: a CLI can copy to the clipboard, never read what the person copied.
  terminal.loadAddon(new parts.ClipboardAddon(undefined, { readText: () => '', writeText: (_selection, text) => parts.writeClipboard(text) }))
}

/** Keeps the Cmd combinations for the app menu, and sends a modified Enter the way the CLI's keyboard mode defines it. */
function keyHandler(terminal: XtermTerminal, modes: KeyModes): (event: KeyboardEvent) => boolean {
  return (event) => {
    if (!keyGoesToTerminal(event)) {
      return false
    }
    const sequence = modifiedEnter(event, modes)
    if (sequence === null) {
      return true
    }
    terminal.input(sequence, true)
    return false
  }
}

type LinkActivate = (event: MouseEvent, uri: string) => void

export function createXtermKit(parts: XtermParts): TerminalKit {
  const activate: LinkActivate = (event, uri) => {
    if (opensLink(event)) {
      parts.openLink(uri)
    }
  }
  return {
    create: (host, { theme, fontFamily }) => {
      const terminal = new parts.Terminal({
        theme,
        fontFamily,
        fontSize: FONT_SIZE,
        // The grapheme addon's Unicode version is proposed API.
        allowProposedApi: true,
        // OSC 8 hyperlinks; http, https and mailto only.
        linkHandler: { activate, allowNonHttpProtocols: false }
      })
      const fit = new parts.FitAddon()
      terminal.loadAddon(fit)
      loadContentAddons(parts, terminal, activate)
      terminal.attachCustomKeyEventHandler(keyHandler(terminal, trackKeyModes(terminal)))
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

export const xtermKit = createXtermKit({
  Terminal,
  FitAddon,
  WebglAddon,
  UnicodeGraphemesAddon,
  WebLinksAddon,
  ClipboardAddon,
  ResizeObserver: globalThis.ResizeObserver,
  openLink: (url) => void window.dm.openExternal(url),
  writeClipboard: (text) => navigator.clipboard.writeText(text)
})
