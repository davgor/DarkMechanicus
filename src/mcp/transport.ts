import { Transform, type TransformCallback, type Readable, type Writable } from 'node:stream'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ErrorCode, type JSONRPCMessage, type RequestId } from '@modelcontextprotocol/sdk/types.js'
import { READBACK_LIMITS } from '../core/schemas'

/**
 * Bytes in one JSON-RPC message on stdin: everything before its newline, a `\r` included. Four times
 * `READBACK_LIMITS.partChars`: the largest tool call is one read-back part, whose JSON is at most that many
 * characters, and a client that writes UTF-8 as is spends at most three bytes a character, which leaves a quarter
 * for the call around it. A client that escapes non-ASCII as `\uXXXX` needs smaller parts for such text.
 */
export const MCP_MESSAGE_MAX_BYTES = 4 * READBACK_LIMITS.partChars

/** Bytes kept from each end of a refused line to find its id. */
const PEEK_BYTES = 256
const NEWLINE = 0x0a

const ID_VALUE = String.raw`(-?\d{1,16}|"(?:[^"\\]|\\.){0,200}")`
/** The id as the first key, or second after `"jsonrpc":"2.0"`, as many clients write it. */
const ID_AT_START = new RegExp(String.raw`^\s*\{\s*(?:"jsonrpc"\s*:\s*"2\.0"\s*,\s*)?"id"\s*:\s*${ID_VALUE}\s*[,}]`)
/** The id as the last key of the message, as the SDK's client writes it: no other object closes after it. */
const ID_AT_END = new RegExp(String.raw`[,{]\s*"id"\s*:\s*${ID_VALUE}\s*\}\s*$`)

/** The refused message's id when either end of the line shows it as a top-level key. */
function idOf(head: Buffer, tail: Buffer): RequestId | undefined {
  const found = ID_AT_START.exec(head.toString('utf8')) ?? ID_AT_END.exec(tail.toString('utf8'))
  if (found?.[1] === undefined) {
    return undefined
  }
  let id: unknown
  try {
    // A short literal the pattern matched, never the message itself. The pattern is looser than JSON (`01`,
    // `"\q"`), and a throw here would stop the transport, so a literal JSON refuses has no id.
    id = JSON.parse(found[1])
  } catch {
    return undefined
  }
  return typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id)) ? id : undefined
}

/** A copy of the last `count` bytes of `pieces` joined, so it keeps none of their memory. */
function lastBytes(pieces: Buffer[], count: number): Buffer {
  const kept: Buffer[] = []
  let size = 0
  for (let at = pieces.length - 1; at >= 0 && size < count; at -= 1) {
    const piece = pieces[at] ?? Buffer.alloc(0)
    const end = piece.subarray(Math.max(0, piece.length - (count - size)))
    kept.unshift(end)
    size += end.length
  }
  return Buffer.concat(kept, size)
}

/**
 * Splits stdin into lines and passes each line of at most `maxBytes` on whole, its newline included. A longer line
 * is dropped as it arrives, keeping copies of only `PEEK_BYTES` from each end, and reported once its newline comes.
 */
export class LineLimit extends Transform {
  /** Called with the refused line's id, when it shows one, once its newline comes. */
  onRefused: (id: RequestId | undefined) => void = () => undefined
  /** The current line, while it is within the limit. */
  private pieces: Buffer[] = []
  private size = 0
  /** The start and the latest bytes of a line past the limit, while it is dropped. */
  private dropped: { head: Buffer; tail: Buffer } | null = null

  constructor(private readonly maxBytes: number) {
    super()
  }

  /** Bytes of the current line held: all of it within the limit, only the copied ends once it is dropped. */
  get retainedBytes(): number {
    return this.dropped === null ? this.size : this.dropped.head.length + this.dropped.tail.length
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start)
      const end = newline === -1 ? chunk.length : newline
      this.collect(chunk.subarray(start, end))
      if (newline === -1) {
        break
      }
      this.endLine(chunk.subarray(newline, newline + 1))
      start = newline + 1
    }
    done()
  }

  private collect(segment: Buffer): void {
    if (this.dropped !== null) {
      this.dropped.tail = lastBytes([this.dropped.tail, segment], PEEK_BYTES)
      return
    }
    if (this.size + segment.length <= this.maxBytes) {
      this.pieces.push(segment)
      this.size += segment.length
      return
    }
    this.dropped = {
      head: Buffer.concat([...this.pieces, segment.subarray(0, PEEK_BYTES)], Math.min(PEEK_BYTES, this.size + segment.length)),
      tail: lastBytes([...this.pieces, segment], PEEK_BYTES)
    }
    this.pieces = []
    this.size = 0
  }

  private endLine(newline: Buffer): void {
    const { dropped } = this
    if (dropped === null) {
      this.push(Buffer.concat([...this.pieces, newline]))
    } else {
      this.dropped = null
      this.onRefused(idOf(dropped.head, dropped.tail))
    }
    this.pieces = []
    this.size = 0
  }
}

/**
 * The SDK's stdio server transport, with every message bounded at `maxMessageBytes` before it is parsed. A longer
 * line is never held whole: it is answered with a JSON-RPC error and reported through `onerror`, and the messages
 * after it are served as usual.
 */
export class BoundedStdioServerTransport extends StdioServerTransport {
  private readonly input: Readable
  private readonly lines: LineLimit

  constructor(stdin: Readable = process.stdin, stdout: Writable = process.stdout, options: { maxMessageBytes?: number } = {}) {
    const maxBytes = options.maxMessageBytes ?? MCP_MESSAGE_MAX_BYTES
    const lines = new LineLimit(maxBytes)
    // The SDK's own buffer sees only whole lines within the limit, so it never reaches its size.
    super(lines, stdout, { maxBufferSize: maxBytes + 1 })
    this.input = stdin
    this.lines = lines
    lines.onRefused = (id) => {
      this.onerror?.(new Error(`Refused a message of more than ${maxBytes} bytes without reading it (id ${JSON.stringify(id ?? null)}).`))
      // With no id to answer, the error goes without one, as MCP's schema has it.
      const reply: JSONRPCMessage = {
        jsonrpc: '2.0',
        ...(id === undefined ? {} : { id }),
        error: {
          code: ErrorCode.InvalidRequest,
          message: `A message is at most ${maxBytes} bytes; this one was longer, so it was not read. Send less in one call: a transfer read-back goes in more, smaller parts.`
        }
      }
      void this.send(reply)
    }
  }

  override async start(): Promise<void> {
    await super.start()
    this.input.on('error', this._onerror)
    this.input.pipe(this.lines)
  }

  override async close(): Promise<void> {
    this.input.unpipe(this.lines)
    this.input.off('error', this._onerror)
    await super.close()
  }
}
