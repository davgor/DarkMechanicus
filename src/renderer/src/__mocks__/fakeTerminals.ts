/**
 * `window.dm.terminals` for renderer tests about chat and sign-in terminals: attaches and sign-ins answer what the
 * test set (a running terminal with an empty screen by default), and each running answer has a fake handle the test
 * drives: output and the exit come from it, and it records what was written to it and the sizes sent.
 */
import type { TerminalAttachment, TerminalAttachOptions, TerminalExit, TerminalHandle, TerminalsApi } from '../../../shared/agents/terminalApi'
import type { AgentId, CommandResult } from '../../../shared/desktop/api'

export class FakeTerminalHandle implements TerminalHandle {
  readonly writes: string[] = []
  readonly resizes: [number, number][] = []
  closed = false
  private readonly output = new Set<(data: string) => void>()
  private readonly exits = new Set<(exit: TerminalExit) => void>()

  write(data: string): void {
    this.writes.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }

  onOutput(listener: (data: string) => void): () => void {
    this.output.add(listener)
    return () => this.output.delete(listener)
  }

  onExit(listener: (exit: TerminalExit) => void): () => void {
    this.exits.add(listener)
    return () => this.exits.delete(listener)
  }

  close(): void {
    this.closed = true
  }

  emitOutput(data: string): void {
    for (const listener of this.output) listener(data)
  }

  emitExit(exit: TerminalExit): void {
    for (const listener of this.exits) listener(exit)
  }

  listenerCounts(): { output: number; exit: number } {
    return { output: this.output.size, exit: this.exits.size }
  }
}

type Answer = CommandResult<TerminalAttachment>

export class FakeTerminals implements TerminalsApi {
  /** Every attach, as `[folder, chatId]`. */
  readonly calls: [string, string][] = []
  /** The options of every attach, in the same order. */
  readonly options: (TerminalAttachOptions | undefined)[] = []
  /** Every handle a running answer carried, oldest first. */
  readonly handles: FakeTerminalHandle[] = []
  /** Main's screen of a chat, sent as the snapshot of a running answer. */
  screens: Record<string, string> = {}
  /** What an attach of the chat answers instead of running. */
  outcomes: Record<string, Omit<TerminalAttachment, 'terminal'> | { error: string }> = {}
  private readonly gates: (() => void)[] = []
  private holding = false
  /** Every sign-in, as the agent id it named. */
  readonly signIns: string[] = []
  /** Every handle a running sign-in carried, oldest first. */
  readonly signInHandles: FakeTerminalHandle[] = []
  /** What a sign-in of the agent answers instead of running. */
  signInOutcomes: Record<string, Omit<TerminalAttachment, 'terminal'> | { error: string }> = {}

  /** From now on attaches wait until `release`. */
  hold(): void {
    this.holding = true
  }

  /** Lets every waiting attach answer, and stops holding. */
  release(): void {
    this.holding = false
    for (const open of this.gates.splice(0)) open()
  }

  /** The newest handle; throws when no attach ran. */
  latest(): FakeTerminalHandle {
    const handle = this.handles.at(-1)
    if (handle === undefined) throw new Error('no terminal was attached')
    return handle
  }

  async attach(folder: string, chatId: string, options?: TerminalAttachOptions): Promise<Answer> {
    this.calls.push([folder, chatId])
    this.options.push(options)
    if (this.holding) {
      await new Promise<void>((resolve) => this.gates.push(resolve))
    }
    const outcome = this.outcomes[chatId]
    if (outcome !== undefined && 'error' in outcome) {
      return { ok: false, error: { code: 'not_found', message: outcome.error } }
    }
    if (outcome !== undefined) {
      return { ok: true, data: { ...outcome, terminal: null } }
    }
    const terminal = new FakeTerminalHandle()
    this.handles.push(terminal)
    return { ok: true, data: { state: 'running', snapshot: this.screens[chatId] ?? '', terminal } }
  }

  /** The newest sign-in handle; throws when no sign-in ran. */
  latestSignIn(): FakeTerminalHandle {
    const handle = this.signInHandles.at(-1)
    if (handle === undefined) throw new Error('no sign-in was started')
    return handle
  }

  async signIn(agentId: AgentId): Promise<Answer> {
    this.signIns.push(agentId)
    const outcome = this.signInOutcomes[agentId]
    if (outcome !== undefined && 'error' in outcome) {
      return { ok: false, error: { code: 'invalid_input', message: outcome.error } }
    }
    if (outcome !== undefined) {
      return { ok: true, data: { ...outcome, terminal: null } }
    }
    const terminal = new FakeTerminalHandle()
    this.signInHandles.push(terminal)
    return { ok: true, data: { state: 'running', snapshot: '', terminal } }
  }
}
