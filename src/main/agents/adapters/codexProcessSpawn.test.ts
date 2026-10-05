import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeChild } from '../__mocks__/fakeChild'
import { killProcessTree } from '../processTree'
import { spawnCodexTransport } from './codexProcess'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('../../desktop/agentProbeNode', () => ({ inspectExecutable: (): 'ok' => 'ok' }))
vi.mock('../processTree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../processTree')>()),
  killProcessTree: vi.fn()
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')

function pretendPlatform(name: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: name })
}

/** Lets queued stream callbacks run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Starts the transport against a fake child and records what it reports. */
function start(path = process.execPath): { child: FakeChild; transport: ReturnType<typeof spawnCodexTransport>; closes: string[]; lines: string[] } {
  const child = new FakeChild()
  vi.mocked(spawn).mockReturnValue(child.asChild())
  const transport = spawnCodexTransport(path, '/work/folder')
  const seen = { closes: [] as string[], lines: [] as string[] }
  transport.onLine((line) => seen.lines.push(line))
  transport.onClose((reason) => seen.closes.push(reason))
  return { child, transport, ...seen }
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
})

describe('how the program ended', () => {
  it('says the program was ended by the signal that killed it', () => {
    const { child, closes } = start()

    child.emit('close', null, 'SIGSEGV')

    expect(closes).toEqual(['Codex was ended by SIGSEGV.'])
  })

  it('says it was ended by a signal when it names none', () => {
    const { child, closes } = start()

    child.emit('close', null, null)

    expect(closes).toEqual(['Codex was ended by a signal.'])
  })

  it('gives the exit code alone when the program printed nothing on stderr', () => {
    const { child, closes } = start()

    child.emit('close', 7, null)

    expect(closes).toEqual(['Codex exited with code 7.'])
  })

  it('adds what the program said on stderr to the exit code', async () => {
    const { child, closes } = start()

    child.stderr.write('  not logged in\n')
    await settle()
    child.emit('close', 1, null)

    expect(closes).toEqual(['Codex exited with code 1: not logged in'])
  })

  it('reports a start failure and ignores the close that follows it', () => {
    const { child, closes } = start()

    child.emit('error', new Error('spawn ENOENT'))
    child.emit('close', 1, null)

    expect(closes).toEqual(['Codex could not start: spawn ENOENT'])
  })
})

describe('after the program ended', () => {
  it('tells a listener that registers late why it ended, straight away', () => {
    const { child, transport } = start()
    child.emit('close', 2, null)

    const late: string[] = []
    transport.onClose((reason) => late.push(reason))

    expect(late).toEqual(['Codex exited with code 2.'])
  })

  it('does not write any more and has nothing left to kill', async () => {
    const { child, transport } = start()
    child.emit('close', 0, null)

    transport.write('{"late":true}')
    await transport.kill()

    expect(child.written).toEqual([])
    expect(killProcessTree).not.toHaveBeenCalled()
  })
})

describe('while the program runs', () => {
  it('writes each message as one line to its stdin', () => {
    const { child, transport } = start()

    transport.write('{"id":1}')
    transport.write('{"id":2}')

    expect(child.written.join('')).toBe('{"id":1}\n{"id":2}\n')
  })

  it('starts it in the folder without a shell, with the subcommand', () => {
    start()

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['app-server'],
      expect.objectContaining({ cwd: '/work/folder', shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    )
  })

  it('delivers stdout as lines and flushes a last line that has no newline when it ends', async () => {
    const { child, lines } = start()

    child.stdout.write('{"a":1}\n{"b"')
    await settle()
    expect(lines).toEqual(['{"a":1}'])
    child.stdout.write(':2}')
    await settle()
    child.emit('close', 0, null)

    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })

})

describe('while the program is stopped', () => {
  it('has the shared tree killer end the whole tree, and settles only once the tree is gone', async () => {
    const { child, transport } = start()
    let treeGone: () => void = () => {}
    vi.mocked(killProcessTree).mockReturnValue(
      new Promise<boolean>((resolve) => {
        treeGone = () => {
          resolve(true)
        }
      })
    )
    let done = false

    const stopping = transport.kill().then(() => {
      done = true
    })
    await settle()
    expect(killProcessTree).toHaveBeenCalledWith(child)
    expect(done).toBe(false)
    treeGone()
    await stopping

    expect(done).toBe(true)
  })

  it('reports the end it was given as a stop, not as a crash', async () => {
    const { child, transport, closes } = start()

    const stopping = transport.kill()
    child.emit('close', null, 'SIGKILL')
    await stopping

    expect(closes).toEqual(['Codex was stopped.'])
  })

  it('starts the program as its own process group leader where there are groups, so the whole group can be killed', () => {
    pretendPlatform('linux')
    start('/usr/local/bin/codex')
    pretendPlatform('win32')
    start('C:\\Tools\\codex.exe')

    const detached = vi.mocked(spawn).mock.calls.map((call) => (call[2] as { detached: boolean }).detached)
    expect(detached).toEqual([true, false])
  })
})
