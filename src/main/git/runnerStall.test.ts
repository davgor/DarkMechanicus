/** The stall timeout of network git: no new output for the stall limit ends it with `timeout`; progress resets the clock. */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ChildLike, createGitRunner, type GitRunRequest, type SpawnFn } from './runner'

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = Object.assign(new EventEmitter(), { end: (): void => undefined })
  kills: Array<NodeJS.Signals | number | undefined> = []
  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal)
    return true
  }
  err(text: string): void {
    this.stderr.emit('data', Buffer.from(text))
  }
  out(text: string): void {
    this.stdout.emit('data', Buffer.from(text))
  }
}

function fakeSpawn(): { spawn: SpawnFn; children: FakeChild[]; args: Array<readonly string[]> } {
  const children: FakeChild[] = []
  const args: Array<readonly string[]> = []
  const spawn: SpawnFn = (_command, spawnArgs) => {
    const child = new FakeChild()
    children.push(child)
    args.push(spawnArgs)
    return child as unknown as ChildLike
  }
  return { spawn, children, args }
}

const fetch = (over: Partial<GitRunRequest> = {}): GitRunRequest => ({ cwd: '/fake/repo', args: ['fetch', '--progress', 'origin'], kind: 'network', ...over })
const SECOND = 1000

// The injected clock: every timer the runner sets runs on vitest's fake clock.
beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('stall timeout (fake spawn, injected clock)', () => {
  it('ends a network operation silent for 60 s with timeout, a stalled-connection message and the scrubbed last stderr line', async () => {
    const { spawn, children } = fakeSpawn()
    const run = createGitRunner({ spawn, platform: 'linux' }).run(fetch({ redact: ['tok-123'] }))
    const settled = expect(run).rejects.toMatchObject({
      code: 'timeout',
      detail: 'Receiving objects:  20% (2/10) via [redacted]',
      message: expect.stringMatching(/stalled/)
    })
    children[0].err('remote: Enumerating objects: 10, done.\nReceiving objects:  10% (1/10)\rReceiving objects:  20% (2/10) via tok-123\r')
    await vi.advanceTimersByTimeAsync(60 * SECOND - 1)
    expect(children[0].kills).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(children[0].kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(2 * SECOND)
    expect(children[0].kills).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('times out with an empty detail when git printed nothing at all', async () => {
    const { spawn } = fakeSpawn()
    const run = createGitRunner({ spawn, platform: 'linux' }).run(fetch())
    const settled = expect(run).rejects.toMatchObject({ code: 'timeout', detail: '' })
    await vi.advanceTimersByTimeAsync(60 * SECOND)
    await settled
  })

  it('never times out a transfer that prints progress every 10 s for 3 minutes', async () => {
    const { spawn, children } = fakeSpawn()
    const run = createGitRunner({ spawn, platform: 'linux' }).run(fetch())
    for (let second = 10; second <= 180; second += 10) {
      await vi.advanceTimersByTimeAsync(10 * SECOND)
      children[0].err(`Receiving objects:  ${second}% (${second}/180)\r`)
    }
    await vi.advanceTimersByTimeAsync(59 * SECOND)
    expect(children[0].kills).toEqual([])
    children[0].emit('close', 0, null)
    await expect(run).resolves.toMatchObject({ code: 0 })
  })
})

describe('stall limit and its neighbours (fake spawn, injected clock)', () => {
  it('counts new stdout as progress too', async () => {
    const { spawn, children } = fakeSpawn()
    const run = createGitRunner({ spawn, platform: 'linux' }).run(fetch())
    await vi.advanceTimersByTimeAsync(50 * SECOND)
    children[0].out('From origin\n')
    await vi.advanceTimersByTimeAsync(50 * SECOND)
    expect(children[0].kills).toEqual([])
    children[0].emit('close', 0, null)
    await run
  })

  it('takes the stall limit from the runner options (for tests), and leaves reads and writes to their own timeouts', async () => {
    const { spawn, children } = fakeSpawn()
    const runner = createGitRunner({ spawn, platform: 'linux', stallMs: 500 })
    const network = runner.run(fetch())
    const read = runner.run({ cwd: '/fake/repo', args: ['status'], kind: 'read' })
    const networkSettled = expect(network).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(500)
    await networkSettled
    expect(children[1].kills).toEqual([])
    children[1].emit('close', 0, null)
    await read
  })

  it('still stalls a network operation that has a longer overall timeout', async () => {
    const { spawn } = fakeSpawn()
    const run = createGitRunner({ spawn, platform: 'linux' }).run(fetch({ timeoutMs: 10 * 60 * SECOND }))
    const settled = expect(run).rejects.toMatchObject({ code: 'timeout', message: expect.stringMatching(/stalled/) })
    await vi.advanceTimersByTimeAsync(60 * SECOND)
    await settled
  })

  it('leaves cancel as it was: cancelled, one group kill, and no stall timeout afterwards', async () => {
    const { spawn, children } = fakeSpawn()
    const groups: Array<[number, string]> = []
    const controller = new AbortController()
    const runner = createGitRunner({ spawn, platform: 'linux', killGroup: (pgid, signal) => groups.push([pgid, signal]) })
    const run = runner.run(fetch({ signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(30 * SECOND)
    children[0].err('Receiving objects:  50% (5/10)\r')
    controller.abort()
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    await vi.advanceTimersByTimeAsync(120 * SECOND)
    expect(groups).toEqual([
      [4242, 'SIGTERM'],
      [4242, 'SIGKILL']
    ])
  })
})

describe('low-speed limits', () => {
  it('passes http.lowSpeedLimit and http.lowSpeedTime on network operations only', async () => {
    const { spawn, children, args } = fakeSpawn()
    const runner = createGitRunner({ spawn, platform: 'linux' })
    const network = runner.run(fetch())
    const read = runner.run({ cwd: '/fake/repo', args: ['status'], kind: 'read' })
    const write = runner.run({ cwd: '/fake/other', args: ['commit'], kind: 'write' })
    expect(args[0]).toEqual([
      '-c',
      'core.quotepath=false',
      '-c',
      'color.ui=never',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'http.lowSpeedLimit=1000',
      '-c',
      'http.lowSpeedTime=60',
      'fetch',
      '--progress',
      'origin'
    ])
    expect(args[1]).not.toContain('http.lowSpeedLimit=1000')
    expect(args[2]).not.toContain('http.lowSpeedTime=60')
    for (const child of children) {
      child.emit('close', 0, null)
    }
    await Promise.all([network, read, write])
  })
})
