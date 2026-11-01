/**
 * Message ports and frames for the terminal channel's tests. A port pair is a real `worker_threads` channel (so
 * what crosses it is structured-cloned, as between main and a renderer), with main's end shaped like Electron's
 * `MessagePortMain`: `on('message')` hears `{ data }`, and nothing is delivered until `start()`. A frame records
 * what main posted to it. Not shipped.
 */
import { MessageChannel, MessagePort } from 'node:worker_threads'
import type { SenderFrame } from '../../ipcGuard'
import type { TerminalFrame, TerminalMainPort } from '../terminalHandlers'

/** A port pair: main's end and the end main posts to the renderer. */
export interface PortPair {
  local: TerminalMainPort
  remote: MessagePort
}

/** Every port the test opened, closed by `closeAll` so no test leaves one holding the event loop. */
export class Ports {
  readonly pairs: PortPair[] = []

  /** `deps.channel` for the handlers. */
  readonly channel = (): PortPair => {
    const { port1, port2 } = new MessageChannel()
    port1.unref()
    port2.unref()
    const messageListeners: ((event: { data: unknown }) => void)[] = []
    let started = false
    const local: TerminalMainPort = {
      postMessage: (message) => {
        port1.postMessage(message)
      },
      on: (event: 'message' | 'close', listener: ((event: { data: unknown }) => void) | (() => void)) => {
        if (event === 'close') {
          port1.on('close', listener as () => void)
        } else {
          messageListeners.push(listener)
          if (started) {
            port1.on('message', (data: unknown) => listener({ data }))
          }
        }
      },
      start: () => {
        if (!started) {
          started = true
          for (const listener of messageListeners) {
            port1.on('message', (data: unknown) => listener({ data }))
          }
        }
      },
      close: () => {
        port1.close()
      }
    }
    const pair = { local, remote: port2 }
    this.pairs.push(pair)
    return pair
  }

  closeAll(): void {
    for (const { local, remote } of this.pairs) {
      local.close()
      remote.close()
    }
  }
}

/** What main posted to a frame. */
export interface Posted {
  channel: string
  message: unknown
  transfer: unknown[]
}

/** The attaching frame, as the sender guard reads it: records each post, and hands it on to `deliver` when set (the preload's port listener). */
export class FakeFrame implements TerminalFrame, SenderFrame {
  readonly posted: Posted[] = []
  deliver: ((posted: Posted) => void) | null = null
  /** Makes the next post throw, as a frame disposed mid-attach does. */
  failNextPost: Error | null = null

  constructor(
    readonly url: string,
    readonly parent: object | null = null,
    readonly detached = false
  ) {}

  isDestroyed(): boolean {
    return false
  }

  postMessage(channel: string, message: unknown, transfer: unknown[]): void {
    const error = this.failNextPost
    if (error !== null) {
      this.failNextPost = null
      throw error
    }
    const posted = { channel, message, transfer }
    this.posted.push(posted)
    this.deliver?.(posted)
  }

  /** The ports main transferred to this frame, oldest first. */
  ports(): MessagePort[] {
    return this.posted.flatMap((posted) => posted.transfer.filter((candidate) => candidate instanceof MessagePort))
  }
}

/** Everything that arrives on `port`, in order. */
export function received(port: MessagePort): unknown[] {
  const messages: unknown[] = []
  port.on('message', (message: unknown) => messages.push(message))
  return messages
}

/** Whether `port`'s other end has been closed, as its `close` event says. */
export function closedFlag(port: MessagePort): { closed: boolean } {
  const flag = { closed: false }
  port.on('close', () => {
    flag.closed = true
  })
  return flag
}
