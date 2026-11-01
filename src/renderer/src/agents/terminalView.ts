/**
 * What a chat's pane needs of a terminal emulator: xterm in the app (`xtermKit.ts`), a fake in tests, since
 * xterm needs a canvas and layout that jsdom does not have.
 */
import type { TerminalTheme } from './terminalTheme'

/** A grid size in whole cells. */
export interface TerminalSize {
  cols: number
  rows: number
}

export interface TerminalViewOptions {
  theme: TerminalTheme
  fontFamily: string
}

/** One terminal emulator mounted in a pane's host element. */
export interface TerminalView {
  /** Puts what the CLI printed (or main's snapshot of its screen) on the screen. */
  write(data: string): void
  /** Subscribes to what the person types or pastes, as the CLI should get it; returns the unsubscribe function. */
  onInput(listener: (data: string) => void): () => void
  /** Fits the grid to the host element and answers its size; null while the host has no size to fit. */
  fit(): TerminalSize | null
  focus(): void
  /** Unmounts the emulator and frees what it holds (its WebGL context). */
  dispose(): void
}

export interface TerminalKit {
  create(host: HTMLElement, options: TerminalViewOptions): TerminalView
  /** Calls `onChange` when the element's size changes; returns the function that stops watching. */
  observeSize(element: HTMLElement, onChange: () => void): () => void
}
