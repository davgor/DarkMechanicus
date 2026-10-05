import { describe, expect, it } from 'vitest'
import { createRpcClient, RpcError, type RpcClient, type RpcHandlers, type RpcTransport } from './codexRpc'

interface Rig {
  client: RpcClient
  /** Lines the client wrote, parsed. */
  written: Record<string, unknown>[]
  /** Delivers a line from the server. */
  receive: (message: unknown) => void
  receiveRaw: (line: string) => void
  close: (reason: string) => void
  notifications: { method: string; params: unknown }[]
  /** Reasons the handler was told the connection ended. */
  closes: string[]
}

function rig(onRequest: RpcHandlers['onRequest'] = () => Promise.resolve(null)): Rig {
  const closes: string[] = []
  const written: Record<string, unknown>[] = []
  const notifications: Rig['notifications'] = []
  let lineListener: (line: string) => void = () => {}
  let closeListener: (reason: string) => void = () => {}
  const transport: RpcTransport = {
    write: (line) => written.push(JSON.parse(line) as Record<string, unknown>),
    onLine: (listener) => {
      lineListener = listener
    },
    onClose: (listener) => {
      closeListener = listener
    },
    kill: () => Promise.resolve()
  }
  const client = createRpcClient(transport, {
    onNotification: (method, params) => notifications.push({ method, params }),
    onRequest,
    onClose: (reason) => closes.push(reason)
  })
  return {
    client,
    written,
    notifications,
    closes,
    receive: (message) => lineListener(JSON.stringify(message)),
    receiveRaw: (line) => lineListener(line),
    close: (reason) => closeListener(reason)
  }
}

/** Lets queued promise callbacks run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('requests', () => {
  it('writes the method and params with an id and no jsonrpc field, and resolves with the result', async () => {
    const { client, written, receive } = rig()

    const pending = client.request('thread/start', { cwd: '/repo' })
    receive({ id: written[0]?.id, result: { thread: { id: 't1' } } })

    await expect(pending).resolves.toEqual({ thread: { id: 't1' } })
    expect(written).toEqual([{ id: written[0]?.id, method: 'thread/start', params: { cwd: '/repo' } }])
    expect(written[0]).not.toHaveProperty('jsonrpc')
  })

  it('matches out-of-order responses to their own requests', async () => {
    const { client, written, receive } = rig()

    const first = client.request('a')
    const second = client.request('b')
    expect(written[0]?.id).not.toEqual(written[1]?.id)
    receive({ id: written[1]?.id, result: 'second' })
    receive({ id: written[0]?.id, result: 'first' })

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
  })

  it('rejects with an RpcError that carries the code and data of an error response', async () => {
    const { client, written, receive } = rig()

    const pending = client.request('thread/resume', { threadId: 'gone' })
    receive({ id: written[0]?.id, error: { code: -32600, message: 'no rollout found', data: { threadId: 'gone' } } })

    const error: unknown = await pending.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RpcError)
    expect(error).toMatchObject({ code: -32600, message: 'no rollout found', data: { threadId: 'gone' } })
  })

  it('ignores a response nobody asked for and lines that are not JSON', async () => {
    const { client, written, receive, receiveRaw } = rig()

    const pending = client.request('a')
    receive({ id: 999, result: 'stray' })
    receiveRaw('not json at all')
    receiveRaw('')
    receiveRaw('[1,2]')
    receive({ id: written[0]?.id, result: 'real' })

    await expect(pending).resolves.toBe('real')
  })

  it('omits params when there are none', () => {
    const { client, written } = rig()

    void client.request('model/list').catch(() => {})

    expect(written[0]).not.toHaveProperty('params')
  })
})

describe('responses and writes that go wrong', () => {
  it('ignores a response whose id is neither a number nor a string', async () => {
    const { client, written, receive } = rig()

    const pending = client.request('a')
    receive({ id: null, result: 'null id' })
    receive({ id: { nested: true }, result: 'object id' })
    receive({ result: 'no id' })
    receive({ id: written[0]?.id, result: 'real' })

    await expect(pending).resolves.toBe('real')
  })

  it('rejects with a default RpcError when the error response is not an object', async () => {
    const { client, written, receive } = rig()

    const pending = client.request('a')
    receive({ id: written[0]?.id, error: 'broken' })

    const error: unknown = await pending.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RpcError)
    expect(error).toMatchObject({ code: -32603, message: 'The request failed.', data: undefined })
  })

  it('falls back to the internal error code and a default message for fields of the wrong type', async () => {
    const { client, written, receive } = rig()

    const pending = client.request('a')
    receive({ id: written[0]?.id, error: { code: 'E_BAD', message: 42 } })

    const error: unknown = await pending.catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: -32603, message: 'The request failed.' })
  })

  it('rejects the request when the transport cannot write, whatever it throws', async () => {
    const thrown: unknown[] = [new Error('pipe closed'), 'plain failure']
    const transport: RpcTransport = {
      write: () => {
        throw thrown.shift()
      },
      onLine: () => {},
      onClose: () => {},
      kill: () => Promise.resolve()
    }
    const client = createRpcClient(transport, { onNotification: () => {}, onRequest: () => Promise.resolve(null) })

    const first: unknown = await client.request('a').catch((caught: unknown) => caught)
    const second: unknown = await client.request('b').catch((caught: unknown) => caught)

    expect(first).toEqual(new Error('pipe closed'))
    expect(second).toEqual(new Error('plain failure'))
  })
})

describe('notifications', () => {
  it('writes a notification without an id', () => {
    const { client, written } = rig()

    client.notify('initialized')
    client.notify('x', { a: 1 })

    expect(written).toEqual([{ method: 'initialized' }, { method: 'x', params: { a: 1 } }])
  })

  it('hands the server notifications to the handler', () => {
    const { notifications, receive } = rig()

    receive({ method: 'turn/started', params: { threadId: 't' } })
    receive({ method: 'warning' })

    expect(notifications).toEqual([
      { method: 'turn/started', params: { threadId: 't' } },
      { method: 'warning', params: undefined }
    ])
  })
})

describe('requests from the server', () => {
  it('answers with the handler result under the id the server used', async () => {
    const { written, receive } = rig((method, params) => Promise.resolve({ echoed: method, params }))

    receive({ id: 7, method: 'item/fileChange/requestApproval', params: { itemId: 'i' } })
    receive({ id: 'abc', method: 'other' })
    await settle()

    expect(written).toEqual([
      { id: 7, result: { echoed: 'item/fileChange/requestApproval', params: { itemId: 'i' } } },
      { id: 'abc', result: { echoed: 'other' } }
    ])
  })

  it('answers a failing handler with an internal error and keeps the code of an RpcError', async () => {
    const { written, receive } = rig((method) =>
      method === 'known' ? Promise.reject(new Error('boom')) : Promise.reject(new RpcError(-32601, 'no such method'))
    )

    receive({ id: 1, method: 'known' })
    receive({ id: 2, method: 'unknown' })
    await settle()

    expect(written).toEqual([
      { id: 1, error: { code: -32603, message: 'boom' } },
      { id: 2, error: { code: -32601, message: 'no such method' } }
    ])
  })

  it('sends the data of an RpcError back in the error response', async () => {
    const { written, receive } = rig(() => Promise.reject(new RpcError(-32000, 'login expired', { action: 'relogin' })))

    receive({ id: 4, method: 'x' })
    await settle()

    expect(written).toEqual([{ id: 4, error: { code: -32000, message: 'login expired', data: { action: 'relogin' } } }])
  })

  it('answers a handler that rejects with something other than an Error using its text', async () => {
    const { written, receive } = rig(() => Promise.reject('plain text'))

    receive({ id: 5, method: 'x' })
    await settle()

    expect(written).toEqual([{ id: 5, error: { code: -32603, message: 'plain text' } }])
  })

  it('answers when the handler throws instead of returning a promise', async () => {
    const { written, receive } = rig(() => {
      throw new Error('sync')
    })

    receive({ id: 3, method: 'x' })
    await settle()

    expect(written).toEqual([{ id: 3, error: { code: -32603, message: 'sync' } }])
  })
})

describe('closing', () => {
  it('rejects every pending request with the reason the process ended', async () => {
    const { client, close } = rig()

    const first = client.request('a')
    const second = client.request('b')
    close('Codex exited with code 1')

    await expect(first).rejects.toThrow('Codex exited with code 1')
    await expect(second).rejects.toThrow('Codex exited with code 1')
    expect(client.closed).toBe(true)
  })

  it('refuses requests after it closed and does not write any more', async () => {
    const { client, written, close } = rig()

    close('gone')

    await expect(client.request('a')).rejects.toThrow('gone')
    client.notify('b')
    expect(written).toEqual([])
  })

  it('does not answer a server request after it closed', async () => {
    const { client, written, receive } = rig()

    receive({ id: 1, method: 'slow' })
    client.close('done')
    await settle()

    expect(written).toEqual([])
  })

  it('can be closed locally, which also rejects the pending requests without telling the handler', async () => {
    const { client, closes, close } = rig()

    const pending = client.request('a')
    client.close('Codex chat closed')
    close('and then the process ended')

    await expect(pending).rejects.toThrow('Codex chat closed')
    expect(closes).toEqual([])
  })

  it('tells the handler once why the process ended', () => {
    const { closes, close } = rig()

    close('Codex exited with code 1')
    close('again')

    expect(closes).toEqual(['Codex exited with code 1'])
  })
})
