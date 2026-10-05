/**
 * Test double for a spawned child process: three pipes the test drives and the events a real one
 * emits (`error`, `close`). Lets a test make a program end in ways a real one only does on some
 * platforms (killed by a signal, no pid, failing without an error code). Not shipped.
 */
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

export class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  /** Everything written to the child's stdin. */
  readonly written: string[] = []

  constructor(readonly pid?: number) {
    super()
    this.stdin.setEncoding('utf8').on('data', (chunk: string) => {
      this.written.push(chunk)
    })
  }

  /** The child as the code under test sees it. */
  asChild(): ChildProcess {
    return this as unknown as ChildProcess
  }
}
