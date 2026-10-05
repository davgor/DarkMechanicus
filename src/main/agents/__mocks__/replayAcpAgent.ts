/**
 * Test double for an ACP agent process: it replays a recorded exchange. A recording is the list of
 * JSON-RPC messages in the order they crossed the wire, each tagged with who sent it. Messages
 * from the agent are delivered as soon as the client has sent everything recorded before them;
 * every message the client writes must equal the next recorded client message, so a recording
 * pins what the adapter says as well as what it does with the answers. Not shipped.
 */
import { isDeepStrictEqual } from 'node:util'
import type { ProbeLaunch } from '../../desktop/agentProbe'
import type { TransportFactory, TransportHandle, TransportSink } from '../adapters/acpClient'

type JsonObject = Record<string, unknown>

export interface Frame {
  from: 'client' | 'agent'
  message: JsonObject
}

/** A message the client is expected to write. */
export function client(message: JsonObject): Frame {
  return { from: 'client', message: { jsonrpc: '2.0', ...message } }
}

/** A message the agent sends. */
export function agent(message: JsonObject): Frame {
  return { from: 'agent', message: { jsonrpc: '2.0', ...message } }
}

interface Launched {
  launch: ProbeLaunch
  cwd: string
}

class Replay implements TransportHandle {
  killed = false
  /** Every line the client wrote, as written. */
  readonly writes: string[] = []
  private next = 0

  constructor(
    private readonly frames: readonly Frame[],
    private readonly sink: TransportSink,
    private readonly problems: string[]
  ) {
    this.deliver()
  }

  finished(): boolean {
    return this.next >= this.frames.length
  }

  write(line: string): void {
    this.writes.push(line)
    const expected = this.frames[this.next]
    this.next += 1
    const actual: unknown = JSON.parse(line)
    if (expected === undefined || expected.from !== 'client') {
      this.problems.push(`The client wrote a message the recording does not expect: ${line}`)
    } else if (!isDeepStrictEqual(actual, expected.message)) {
      this.problems.push(`Expected ${JSON.stringify(expected.message)} but the client wrote ${line}`)
    }
    this.deliver()
  }

  kill(): void {
    this.killed = true
  }

  /** The agent's own exit, which the client learns from the closed stream. */
  exit(detail: string): void {
    this.sink.closed(detail)
  }

  private deliver(): void {
    while (this.next < this.frames.length && this.frames[this.next]?.from === 'agent') {
      const frame = this.frames[this.next]
      this.next += 1
      queueMicrotask(() => {
        if (!this.killed && frame !== undefined) {
          this.sink.line(JSON.stringify(frame.message))
        }
      })
    }
  }
}

/** Hands one recording to each process the adapter starts, in order. */
export class ReplayAcpAgents {
  readonly launches: Launched[] = []
  /** What went wrong: unexpected or unequal client messages, and processes nobody recorded. */
  readonly problems: string[] = []
  readonly processes: Replay[] = []
  private readonly recordings: Frame[][]

  constructor(...recordings: Frame[][]) {
    this.recordings = recordings
  }

  readonly factory: TransportFactory = (launch, cwd, sink) => {
    this.launches.push({ launch, cwd })
    const frames = this.recordings[this.processes.length]
    if (frames === undefined) {
      this.problems.push(`A process was started that no recording covers: ${JSON.stringify(launch.args)}`)
    }
    const replay = new Replay(frames ?? [], sink, this.problems)
    this.processes.push(replay)
    return replay
  }

  /** True when every recorded message of every recording was exchanged. */
  finished(): boolean {
    return this.processes.length === this.recordings.length && this.processes.every((replay) => replay.finished())
  }
}
