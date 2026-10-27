import { describe, expect, it } from 'vitest'
import type { ProbeLaunch } from '../../desktop/agentProbe'
import { AcpError, openAcpConnection, type AcpHandlers, type TransportFactory, type TransportSink } from './acpClient'

const LAUNCH: ProbeLaunch = { file: 'agent', args: ['acp'], verbatimArguments: false }

interface Rig {
  written: Record<string, unknown>[]
  kills: number
  /** What a transport kill returns: resolved unless a test holds it back. */
  killResult: Promise<void>
  notifications: [string, unknown][]
  requests: [number | string, string, unknown][]
  closures: string[]
  sink: () => TransportSink
  open: (overrides?: Partial<AcpHandlers>) => ReturnType<typeof openAcpConnection>
  hear: (message: unknown) => void
}

function rig(): Rig {
  let sink: TransportSink | null = null
  const state: Rig = {
    written: [],
    kills: 0,
    killResult: Promise.resolve(),
    notifications: [],
    requests: [],
    closures: [],
    sink: () => {
      if (sink === null) {
        throw new Error('not opened')
      }
      return sink
    },
    open: (overrides = {}) => {
      const factory: TransportFactory = (_launch, _cwd, given) => {
        sink = given
        return {
          write: (line) => {
            state.written.push(JSON.parse(line) as Record<string, unknown>)
          },
          kill: () => {
            state.kills += 1
            return state.killResult
          }
        }
      }
      return openAcpConnection(factory, LAUNCH, '/work', {
        notification: (method, params) => state.notifications.push([method, params]),
        request: (id, method, params) => state.requests.push([id, method, params]),
        closed: (detail) => state.closures.push(detail),
        ...overrides
      })
    },
    hear: (message) => {
      state.sink().line(JSON.stringify(message))
    }
  }
  return state
}

describe('openAcpConnection', () => {
  it('writes requests as JSON-RPC lines with increasing ids and resolves each with its own result', async () => {
    const t = rig()
    const connection = t.open()

    const first = connection.request('initialize', { protocolVersion: 1 })
    const second = connection.request('session/new', { cwd: '/work' })
    t.hear({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } })
    t.hear({ jsonrpc: '2.0', id: 1, result: { ok: true } })

    expect(t.written).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } },
      { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/work' } }
    ])
    await expect(second).resolves.toEqual({ sessionId: 's' })
    await expect(first).resolves.toEqual({ ok: true })
  })

  it('rejects a request with the agent error, keeping its code and data', async () => {
    const t = rig()
    const pending = t.open().request('session/load', {})

    t.hear({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Session not found', data: { id: 'x' } } })

    const error = await pending.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AcpError)
    expect(error).toMatchObject({ message: 'Session not found', code: -32602, data: { id: 'x' } })
  })
})

describe('openAcpConnection: what the agent sends', () => {
  it('hands notifications and the agent requests to the handlers, and answers requests on demand', () => {
    const t = rig()
    const connection = t.open()

    t.hear({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's' } })
    t.hear({ jsonrpc: '2.0', id: 'a-1', method: 'session/request_permission', params: { sessionId: 's' } })
    connection.respond('a-1', { outcome: { outcome: 'cancelled' } })
    connection.fail(5, -32601, 'Method not found')
    connection.notify('session/cancel', { sessionId: 's' })

    expect(t.notifications).toEqual([['session/update', { sessionId: 's' }]])
    expect(t.requests).toEqual([['a-1', 'session/request_permission', { sessionId: 's' }]])
    expect(t.written).toEqual([
      { jsonrpc: '2.0', id: 'a-1', result: { outcome: { outcome: 'cancelled' } } },
      { jsonrpc: '2.0', id: 5, error: { code: -32601, message: 'Method not found' } },
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } }
    ])
  })

  it('ignores lines that are not JSON-RPC messages and answers nobody for a response it never asked for', () => {
    const t = rig()
    t.open()

    t.sink().line('Welcome to Cursor Agent')
    t.sink().line('')
    t.hear(42)
    t.hear(null)
    t.hear({ jsonrpc: '2.0', id: 99, result: {} })
    t.hear({ jsonrpc: '2.0', method: 5 })

    expect(t.notifications).toEqual([])
    expect(t.requests).toEqual([])
    expect(t.written).toEqual([])
  })

})

describe('openAcpConnection: handlers that fail', () => {
  it('answers an agent request its handler cannot handle with an internal error, and keeps going', async () => {
    const t = rig()
    const connection = t.open({
      request: () => {
        throw new Error('handler broke')
      }
    })

    t.hear({ jsonrpc: '2.0', id: 3, method: 'cursor/ask_question', params: {} })
    const pending = connection.request('session/prompt', {})
    t.hear({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } })

    expect(t.written[0]).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'handler broke' } })
    await expect(pending).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('survives a notification handler that throws', () => {
    const t = rig()
    t.open({
      notification: () => {
        throw new Error('boom')
      }
    })

    expect(() => {
      t.hear({ jsonrpc: '2.0', method: 'session/update', params: {} })
    }).not.toThrow()
  })
})

describe('openAcpConnection: the end of the process', () => {
  it('fails every waiting request when the process ends, tells the handler once and refuses new requests', async () => {
    const t = rig()
    const connection = t.open()
    const waiting = connection.request('session/prompt', {})

    t.sink().closed('exit code 1: boom')
    t.sink().closed('again')

    await expect(waiting).rejects.toThrow('The Cursor agent stopped: exit code 1: boom')
    await expect(connection.request('session/prompt', {})).rejects.toThrow('The Cursor agent stopped')
    expect(connection.isClosed()).toBe(true)
    expect(t.closures).toEqual(['exit code 1: boom'])
    connection.respond(1, {})
    connection.notify('x', {})
    expect(t.written).toHaveLength(1)
  })

  it('kills the process once on request, fails what is waiting and does not report it as a crash', async () => {
    const t = rig()
    const connection = t.open()
    const waiting = connection.request('session/prompt', {})

    const first = connection.kill()
    const second = connection.kill()
    t.sink().closed('killed')

    await expect(waiting).rejects.toThrow('The Cursor agent was stopped')
    await Promise.all([first, second])
    expect(t.kills).toBe(1)
    expect(connection.isClosed()).toBe(true)
    expect(t.closures).toEqual([])
  })

})

describe('openAcpConnection: waiting for the tree', () => {
  it('resolves a kill only once the transport says the process tree is gone, and fails what waits at once', async () => {
    const t = rig()
    let gone: () => void = () => {}
    t.killResult = new Promise<void>((resolve) => {
      gone = resolve
    })
    const connection = t.open()
    const waiting = connection.request('session/prompt', {}).catch((error: unknown) => error)
    let done = false

    const killing = connection.kill().then(() => {
      done = true
    })
    expect(await waiting).toBeInstanceOf(AcpError)
    await new Promise((resolve) => setImmediate(resolve))
    expect(done).toBe(false)
    gone()
    await killing

    expect(done).toBe(true)
  })

  it('fails a request whose line cannot be written', async () => {
    const connection = openAcpConnection(
      () => ({
        write: () => {
          throw new Error('EPIPE')
        },
        kill: () => Promise.resolve()
      }),
      LAUNCH,
      '/work',
      { notification: () => {}, request: () => {}, closed: () => {} }
    )

    await expect(connection.request('initialize', {})).rejects.toThrow('EPIPE')
  })
})

describe('openAcpConnection: unusual answers', () => {
  it('gives an error answer without a message or code a readable default', async () => {
    const t = rig()
    const pending = t.open().request('session/new', {})

    t.hear({ jsonrpc: '2.0', id: 1, error: 'broken' })

    const error = await pending.catch((caught: unknown) => caught)
    expect(error).toMatchObject({ message: 'The agent reported an error.', code: null })
  })
})
