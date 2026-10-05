/**
 * Replays a recorded `codex app-server` exchange against the code under test: a transport double
 * driven by a script of steps. Strict about order, so a recording that stops matching what the
 * adapter writes fails the test at the line that differs. Not shipped.
 *
 * A script lists, in order, what the client must write (`expect`, `expectResponse`) and what the
 * server then says (`reply`, `fail`, `notify`, `ask`). After each client line the server steps up to
 * the next client step are delivered, one microtask later, like lines arriving from a pipe.
 */
import { expect } from 'vitest'
import type { RpcTransport } from '../adapters/codexRpc'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type Step =
  /** The client writes a request or notification: `method` and (a subset of) `params`. */
  | { kind: 'expect'; method: string; params: Json | undefined }
  /** The client answers the server request `id` with exactly `result`. */
  | { kind: 'expectResponse'; id: number | string; result: Json }
  /** The client refuses the server request `id` with an error of this code. */
  | { kind: 'expectError'; id: number | string; code: number; message: string }
  /** The server answers the last request the client wrote. */
  | { kind: 'reply'; result: Json }
  | { kind: 'fail'; code: number; message: string; data?: Json }
  | { kind: 'notify'; method: string; params: Json }
  /** The server asks the client something. */
  | { kind: 'ask'; id: number | string; method: string; params: Json }
  /** The server process ends. */
  | { kind: 'exit'; reason: string }
  /** The server prints a line that is not JSON. */
  | { kind: 'noise'; line: string }

export const step = {
  expect: (method: string, params?: Json): Step => ({ kind: 'expect', method, params }),
  expectResponse: (id: number | string, result: Json): Step => ({ kind: 'expectResponse', id, result }),
  expectError: (id: number | string, code: number, message: string): Step => ({ kind: 'expectError', id, code, message }),
  reply: (result: Json = {}): Step => ({ kind: 'reply', result }),
  fail: (code: number, message: string, data?: Json): Step => ({ kind: 'fail', code, message, ...(data === undefined ? {} : { data }) }),
  notify: (method: string, params: Json): Step => ({ kind: 'notify', method, params }),
  ask: (id: number | string, method: string, params: Json): Step => ({ kind: 'ask', id, method, params }),
  exit: (reason: string): Step => ({ kind: 'exit', reason }),
  noise: (line: string): Step => ({ kind: 'noise', line })
}

export interface ReplayTransport extends RpcTransport {
  /** Every message the client wrote, parsed, in order. */
  readonly written: Record<string, unknown>[]
  /** How many times the process was killed. */
  readonly kills: number
  /** Steps the script still holds; empty once the whole recording was played. */
  remaining(): Step[]
  /** Delivers server steps now, outside the script (a reply that arrives late, a process that dies). */
  say(...steps: Step[]): void
}

function isClientStep(candidate: Step): boolean {
  return candidate.kind === 'expect' || candidate.kind === 'expectResponse' || candidate.kind === 'expectError'
}

class Replay implements ReplayTransport {
  readonly written: Record<string, unknown>[] = []
  kills = 0
  private readonly queue: Step[]
  private lineListener: (line: string) => void = () => {}
  private closeListener: (reason: string) => void = () => {}
  private lastRequestId: number | string | null = null

  constructor(script: Step[]) {
    this.queue = [...script]
  }

  remaining(): Step[] {
    return [...this.queue]
  }

  say(...steps: Step[]): void {
    for (const server of steps) {
      this.play(server)
    }
  }

  write(line: string): void {
    const message = JSON.parse(line) as Record<string, unknown>
    this.written.push(message)
    this.consume(message)
    while (this.queue.length > 0 && !isClientStep(this.queue[0] as Step)) {
      this.play(this.queue.shift() as Step)
    }
  }

  onLine(listener: (line: string) => void): void {
    this.lineListener = listener
  }

  onClose(listener: (reason: string) => void): void {
    this.closeListener = listener
  }

  kill(): Promise<void> {
    this.kills += 1
    return Promise.resolve()
  }

  private deliver(line: string): void {
    queueMicrotask(() => {
      this.lineListener(line)
    })
  }

  /** The line the server prints for a step, or null for a step that is not a line. */
  private lineFor(server: Step): string | null {
    switch (server.kind) {
      case 'reply':
        return JSON.stringify({ id: this.lastRequestId, result: server.result })
      case 'fail':
        return JSON.stringify({ id: this.lastRequestId, error: { code: server.code, message: server.message, ...(server.data === undefined ? {} : { data: server.data }) } })
      case 'notify':
        return JSON.stringify({ method: server.method, params: server.params })
      case 'ask':
        return JSON.stringify({ id: server.id, method: server.method, params: server.params })
      case 'noise':
        return server.line
      default:
        return null
    }
  }

  private play(server: Step): void {
    if (server.kind === 'exit') {
      const { reason } = server
      queueMicrotask(() => {
        this.closeListener(reason)
      })
      return
    }
    const line = this.lineFor(server)
    if (line === null) {
      throw new Error(`A client step cannot be played: ${server.kind}`)
    }
    this.deliver(line)
  }

  /** Checks what the client wrote against the next step of the recording. */
  private consume(message: Record<string, unknown>): void {
    const next = this.queue.shift()
    if (next === undefined) {
      throw new Error(`The recording ended, but the client wrote ${JSON.stringify(message)}`)
    }
    if (next.kind === 'expect') {
      expect(message).toMatchObject({ method: next.method })
      if (next.params !== undefined) {
        expect(message.params).toMatchObject(next.params as object)
      }
      this.lastRequestId = 'id' in message ? (message.id as number | string) : this.lastRequestId
    } else if (next.kind === 'expectResponse') {
      expect(message).toEqual({ id: next.id, result: next.result })
    } else if (next.kind === 'expectError') {
      expect(message).toEqual({ id: next.id, error: { code: next.code, message: next.message } })
    } else {
      throw new Error(`The client wrote ${JSON.stringify(message)} while the recording expected the server to ${next.kind}`)
    }
  }
}

export function replayTransport(script: Step[]): ReplayTransport {
  return new Replay(script)
}
