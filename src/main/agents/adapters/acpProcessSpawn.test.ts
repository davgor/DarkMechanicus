import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProbeLaunch } from '../../desktop/agentProbe'
import { FakeChild } from '../__mocks__/fakeChild'
import { killProcessTree } from '../processTree'
import { nodeTransport } from './acpProcess'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('../processTree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../processTree')>()),
  killProcessTree: vi.fn()
}))

const LAUNCH: ProbeLaunch = { file: '/opt/agent', args: ['--acp'], verbatimArguments: false }

interface Heard {
  lines: string[]
  closed: string[]
}

function open(child: FakeChild): { heard: Heard; handle: ReturnType<typeof nodeTransport> } {
  vi.mocked(spawn).mockReturnValue(child.asChild())
  const heard: Heard = { lines: [], closed: [] }
  const handle = nodeTransport(LAUNCH, '/work', {
    line: (text) => heard.lines.push(text),
    closed: (detail) => heard.closed.push(detail)
  })
  return { heard, handle }
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform')

function pretendPlatform(name: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: name })
}

beforeEach(() => {
  vi.mocked(spawn).mockReset()
  vi.mocked(killProcessTree).mockReset()
  vi.mocked(killProcessTree).mockResolvedValue(true)
})

afterEach(() => {
  if (platform !== undefined) {
    Object.defineProperty(process, 'platform', platform)
  }
  vi.restoreAllMocks()
})

describe('nodeTransport: how the process ended', () => {
  it('names the signal that ended the process', () => {
    const child = new FakeChild()
    const { heard } = open(child)

    child.emit('close', null, 'SIGKILL')

    expect(heard.closed).toEqual(['signal SIGKILL'])
  })

  it('reports the exit code, or -1 when the process gave neither a code nor a signal', () => {
    const exited = new FakeChild()
    const first = open(exited)
    exited.emit('close', 4, null)

    const vanished = new FakeChild()
    const second = open(vanished)
    vanished.emit('close', null, null)

    expect(first.heard.closed).toEqual(['exit code 4'])
    expect(second.heard.closed).toEqual(['exit code -1'])
  })

  it('reports a start failure with its error code when it has one, without it otherwise', () => {
    const coded = new FakeChild()
    const first = open(coded)
    coded.emit('error', Object.assign(new Error('spawn /opt/agent ENOENT'), { code: 'ENOENT' }))

    const plain = new FakeChild()
    const second = open(plain)
    plain.emit('error', new Error('no pipes'))

    expect(first.heard.closed).toEqual(['could not be started (ENOENT): spawn /opt/agent ENOENT'])
    expect(second.heard.closed).toEqual(['could not be started: no pipes'])
  })

  it('reports a spawn that throws something other than an Error, once and after the caller has the handle', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw 'out of descriptors'
    })
    const closed: string[] = []

    const handle = nodeTransport(LAUNCH, '/work', { line: () => {}, closed: (detail) => closed.push(detail) })
    expect(closed).toEqual([])
    await Promise.resolve()

    expect(closed).toEqual(['could not be started: out of descriptors'])
    expect(() => {
      handle.write('ignored')
    }).not.toThrow()
    await expect(handle.kill()).resolves.toBeUndefined()
    expect(killProcessTree).not.toHaveBeenCalled()
  })

})

describe('nodeTransport: output and failed starts', () => {
  it('keeps stdout lines flowing and adds the stderr tail to the way it ended', async () => {
    const child = new FakeChild()
    const { heard } = open(child)

    child.stdout.write('{"a":1}\r\n')
    child.stderr.write('warming up\n')
    await new Promise((resolve) => setImmediate(resolve))
    child.emit('close', 2, null)

    expect(heard.lines).toEqual(['{"a":1}'])
    expect(heard.closed).toEqual(['exit code 2: warming up'])
  })
})

describe('nodeTransport: stopping the process', () => {
  it('has the shared tree killer end the process and what it started, and resolves once that is done', async () => {
    pretendPlatform('linux')
    const child = new FakeChild(4242)
    const { handle } = open(child)
    let treeGone: () => void = () => {}
    vi.mocked(killProcessTree).mockReturnValue(
      new Promise<boolean>((resolve) => {
        treeGone = () => {
          resolve(true)
        }
      })
    )
    let done = false

    const stopping = handle.kill().then(() => {
      done = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(killProcessTree).toHaveBeenCalledWith(child)
    expect(done).toBe(false)
    treeGone()
    await stopping

    expect(done).toBe(true)
  })

  it('does not signal the process group itself any more, whatever the platform', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    for (const name of ['linux', 'win32'] as const) {
      pretendPlatform(name)
      await open(new FakeChild(4242)).handle.kill()
    }

    expect(kill).not.toHaveBeenCalled()
    expect(killProcessTree).toHaveBeenCalledTimes(2)
  })

  it('starts the process as its own group leader everywhere but on Windows', () => {
    pretendPlatform('darwin')
    open(new FakeChild())

    expect(spawn).toHaveBeenCalledWith('/opt/agent', ['--acp'], expect.objectContaining({ detached: true, shell: false }))
  })

  it('does not detach on Windows, where the tree is found through its parent', () => {
    pretendPlatform('win32')
    open(new FakeChild(4242))

    expect(spawn).toHaveBeenCalledWith('/opt/agent', ['--acp'], expect.objectContaining({ detached: false }))
  })
})

describe('nodeTransport: writing', () => {
  it('writes each message as one line while stdin is open and nothing after it is closed', () => {
    const child = new FakeChild()
    const { handle } = open(child)

    handle.write('{"id":1}')
    child.stdin.end()
    handle.write('{"id":2}')

    expect(child.written.join('')).toBe('{"id":1}\n')
  })
})
