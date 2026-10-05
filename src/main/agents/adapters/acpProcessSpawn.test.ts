import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProbeLaunch } from '../../desktop/agentProbe'
import { killTree } from '../../desktop/agentProbeNode'
import { FakeChild } from '../__mocks__/fakeChild'
import { nodeTransport } from './acpProcess'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('../../desktop/agentProbeNode', () => ({ killTree: vi.fn() }))

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
  vi.mocked(killTree).mockReset()
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
      handle.kill()
    }).not.toThrow()
    expect(killTree).not.toHaveBeenCalled()
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
  it('kills the whole process group where there are groups', () => {
    pretendPlatform('linux')
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const { handle } = open(new FakeChild(4242))

    handle.kill()

    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
    expect(killTree).not.toHaveBeenCalled()
  })

  it('starts the process as its own group leader everywhere but on Windows', () => {
    pretendPlatform('darwin')
    open(new FakeChild())

    expect(spawn).toHaveBeenCalledWith('/opt/agent', ['--acp'], expect.objectContaining({ detached: true, shell: false }))
  })

  it('falls back to ending the process directly when the group is already gone', () => {
    pretendPlatform('linux')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })
    const child = new FakeChild(4242)
    const { handle } = open(child)

    handle.kill()

    expect(killTree).toHaveBeenCalledWith(child)
  })

  it('ends the process directly when it has no pid to address a group by', () => {
    pretendPlatform('linux')
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const child = new FakeChild(undefined)
    const { handle } = open(child)

    handle.kill()

    expect(kill).not.toHaveBeenCalled()
    expect(killTree).toHaveBeenCalledWith(child)
  })

  it('ends the process tree directly on Windows, where there are no groups', () => {
    pretendPlatform('win32')
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const child = new FakeChild(4242)
    const { handle } = open(child)

    handle.kill()

    expect(kill).not.toHaveBeenCalled()
    expect(killTree).toHaveBeenCalledWith(child)
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
