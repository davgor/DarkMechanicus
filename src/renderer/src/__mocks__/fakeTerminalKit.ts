/**
 * A terminal emulator for renderer tests: xterm needs a canvas and layout that jsdom lacks. Each view records
 * what was written to it, and the test types into it and resizes the host.
 */
import type { TerminalKit, TerminalSize, TerminalView, TerminalViewOptions } from '../agents/terminalView'

export class FakeTerminalView implements TerminalView {
  readonly written: string[] = []
  focused = 0
  disposed = false
  private readonly inputs = new Set<(data: string) => void>()
  private readonly titles = new Set<(title: string) => void>()

  constructor(
    readonly host: HTMLElement,
    readonly options: TerminalViewOptions,
    private readonly kit: FakeTerminalKit
  ) {}

  write(data: string): void {
    this.written.push(data)
    // Like xterm's parser: OSC 0 and OSC 2 (`ESC ] 0 ; title BEL`, or ended by ST) set the title.
    // eslint-disable-next-line no-control-regex
    for (const match of data.matchAll(/\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
      for (const listener of this.titles) listener(match[1])
    }
  }

  onTitleChange(listener: (title: string) => void): () => void {
    this.titles.add(listener)
    return () => this.titles.delete(listener)
  }

  /** How many title listeners are subscribed. */
  get titleListeners(): number {
    return this.titles.size
  }

  onInput(listener: (data: string) => void): () => void {
    this.inputs.add(listener)
    return () => this.inputs.delete(listener)
  }

  fit(): TerminalSize | null {
    return this.kit.size
  }

  focus(): void {
    this.focused += 1
  }

  dispose(): void {
    this.disposed = true
  }

  /** What the person typed or pasted. */
  type(data: string): void {
    for (const listener of this.inputs) listener(data)
  }
}

export class FakeTerminalKit implements TerminalKit {
  readonly views: FakeTerminalView[] = []
  /** What a fit answers: the grid that fits the host now. */
  size: TerminalSize | null = { cols: 100, rows: 30 }
  private readonly watchers = new Map<() => void, HTMLElement>()

  create(host: HTMLElement, options: TerminalViewOptions): TerminalView {
    const view = new FakeTerminalView(host, options, this)
    this.views.push(view)
    return view
  }

  observeSize(element: HTMLElement, onChange: () => void): () => void {
    this.watchers.set(onChange, element)
    return () => this.watchers.delete(onChange)
  }

  /** The newest view; throws when none was created. */
  latest(): FakeTerminalView {
    const view = this.views.at(-1)
    if (view === undefined) throw new Error('no terminal view was created')
    return view
  }

  /** The host changed size: what fits is now `size`, and every watcher hears of it. */
  resizeTo(size: TerminalSize | null): void {
    this.size = size
    for (const onChange of this.watchers.keys()) onChange()
  }

  /** The elements being watched. */
  watched(): HTMLElement[] {
    return [...this.watchers.values()]
  }
}
