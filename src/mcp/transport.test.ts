import { PassThrough } from 'node:stream'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoundedStdioServerTransport, LineLimit, MCP_MESSAGE_MAX_BYTES } from './transport'

interface Rig {
  server: Server
  stdin: PassThrough
  /** Resolves with the first `count` lines the server wrote, each parsed. */
  replies(count: number): Promise<unknown[]>
  errors: string[]
  closed: () => boolean
}

const rigs: Server[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(rigs.splice(0).map((server) => server.close()))
})

/** A server that answers `ping` over a bounded transport on in-memory pipes. */
async function rig(options?: { maxMessageBytes?: number }): Promise<Rig> {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} })
  const errors: string[] = []
  let closed = false
  server.onerror = (error) => errors.push(error.message)
  server.onclose = () => {
    closed = true
  }
  await server.connect(new BoundedStdioServerTransport(stdin, stdout, options))
  rigs.push(server)
  let text = ''
  stdout.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8')
  })
  const replies = async (count: number): Promise<unknown[]> => {
    await vi.waitFor(
      () => {
        if (text.split('\n').length <= count) {
          throw new Error(`waiting for ${count} replies, have ${text}`)
        }
      },
      { timeout: 5_000, interval: 5 }
    )
    return text
      .split('\n')
      .slice(0, count)
      .map((line) => JSON.parse(line) as unknown)
  }
  return { server, stdin, replies, errors, closed: () => closed }
}

/** A ping request, as the SDK's client orders its keys (id last), whose line is `bytes` long without the newline. */
function pingOf(id: number | string, bytes: number, order: 'id-last' | 'id-first' = 'id-last'): string {
  const json = (pad: string): string =>
    order === 'id-last'
      ? JSON.stringify({ method: 'ping', params: { _meta: { pad } }, jsonrpc: '2.0', id })
      : JSON.stringify({ jsonrpc: '2.0', id, method: 'ping', params: { _meta: { pad } } })
  const pad = 'x'.repeat(bytes - json('').length)
  const line = json(pad)
  expect(Buffer.byteLength(line)).toBe(bytes)
  return line
}

/** Writes `text` in pieces of `size` bytes, as a pipe delivers a long line. */
function writeInPieces(stdin: PassThrough, text: string, size: number): void {
  const bytes = Buffer.from(text)
  for (let at = 0; at < bytes.length; at += size) {
    stdin.write(bytes.subarray(at, at + size))
  }
}

/** The refusal of an oversized message: with its id when the line showed one, else without an id, as MCP's schema allows. */
function refusal(id: number | string | undefined, max: number): object {
  return {
    jsonrpc: '2.0',
    ...(id === undefined ? {} : { id }),
    error: { code: -32600, message: expect.stringContaining(`A message is at most ${max} bytes`) as unknown }
  }
}

describe('BoundedStdioServerTransport', () => {
  it('pins the message limit: four times the read-back part limit, so a part fits at three UTF-8 bytes a character', () => {
    expect(MCP_MESSAGE_MAX_BYTES).toBe(32_000_000)
  })

  it('answers a line over the limit with an error without parsing it, and serves the next request', async () => {
    const parse = vi.spyOn(JSON, 'parse')
    const { stdin, replies, errors, closed } = await rig()
    writeInPieces(stdin, `${pingOf(1, MCP_MESSAGE_MAX_BYTES + 1)}\n`, 1 << 20)
    stdin.write(`${pingOf(2, 100)}\n`)

    expect(await replies(2)).toEqual([refusal(1, MCP_MESSAGE_MAX_BYTES), { jsonrpc: '2.0', id: 2, result: {} }])
    expect(parse.mock.calls.every(([text]) => text.length <= MCP_MESSAGE_MAX_BYTES)).toBe(true)
    expect(errors).toEqual([expect.stringContaining(`Refused a message of more than ${MCP_MESSAGE_MAX_BYTES} bytes`)])
    expect(closed()).toBe(false)
  })

  it('reads a message of exactly the limit, and the request written after it in the same chunk', async () => {
    const { stdin, replies, errors } = await rig()
    stdin.write(`${pingOf(1, MCP_MESSAGE_MAX_BYTES)}\n${pingOf(2, 100)}\n`)
    expect(await replies(2)).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: {} }
    ])
    expect(errors).toEqual([])
  })
})

describe('BoundedStdioServerTransport refusal ids', () => {
  it('answers with the id found at either end of the line, or without one when it cannot tell', async () => {
    const max = 1_000
    const { stdin, replies } = await rig({ maxMessageBytes: max })
    // Id first, as many clients write it, and a string id; then a line ten times the limit in 7-byte pieces.
    stdin.write(`${pingOf('req-7', max + 1, 'id-first')}\n`)
    writeInPieces(stdin, `${pingOf(8, 10 * max)}\n`, 7)
    // An id only inside the params is not the message's.
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/x', params: { pad: 'x'.repeat(max), id: 5 } })}\n`)
    // Not JSON at all, with the next request in the same chunk.
    stdin.write(`${'y'.repeat(3 * max)}\r\n${pingOf(9, 100)}\n`)

    expect(await replies(5)).toStrictEqual([
      refusal('req-7', max),
      refusal(8, max),
      refusal(undefined, max),
      refusal(undefined, max),
      { jsonrpc: '2.0', id: 9, result: {} }
    ])
  })

  it('answers a line whose id JSON would refuse without an id, and keeps serving', async () => {
    const max = 1_000
    const { stdin, replies, closed } = await rig({ maxMessageBytes: max })
    stdin.write(`{"id":01,"pad":"${'x'.repeat(2 * max)}"}\n`)
    stdin.write(`{"id":"\\q","pad":"${'x'.repeat(2 * max)}"}\n`)
    stdin.write(`${pingOf(3, 100)}\n`)
    expect(await replies(3)).toStrictEqual([refusal(undefined, max), refusal(undefined, max), { jsonrpc: '2.0', id: 3, result: {} }])
    expect(closed()).toBe(false)
  })
})

describe('BoundedStdioServerTransport lifecycle', () => {
  it('passes stdin errors to onerror, and stops reading stdin once closed', async () => {
    const { server, stdin, errors } = await rig()
    expect(stdin.listenerCount('data')).toBe(1)
    stdin.emit('error', new Error('stdin broke'))
    expect(errors).toEqual(['stdin broke'])
    await server.close()
    expect(stdin.listenerCount('data')).toBe(0)
    expect(stdin.listenerCount('error')).toBe(0)
  })
})

describe('LineLimit', () => {
  it('holds a line within the limit whole, and only the copied ends of a longer one as it arrives', () => {
    const lines = new LineLimit(1_000)
    const passed: string[] = []
    lines.on('data', (chunk: Buffer) => passed.push(chunk.toString('utf8')))
    lines.write(Buffer.alloc(1_000, 'a'))
    expect(lines.retainedBytes).toBe(1_000)
    lines.write(Buffer.from('\n'))
    expect(passed).toEqual([`${'a'.repeat(1_000)}\n`])
    for (let piece = 0; piece < 100; piece += 1) {
      lines.write(Buffer.alloc(65_536, 'b'))
      expect(lines.retainedBytes).toBeLessThanOrEqual(512)
    }
    lines.write(Buffer.from('\nok\n'))
    expect(lines.retainedBytes).toBe(0)
    expect(passed).toEqual([`${'a'.repeat(1_000)}\n`, 'ok\n'])
  })
})
