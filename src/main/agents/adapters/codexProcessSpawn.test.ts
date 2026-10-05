import { spawn } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { killTree } from '../../desktop/agentProbeNode'
import { FakeChild } from '../__mocks__/fakeChild'
import { spawnCodexTransport } from './codexProcess'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('../../desktop/agentProbeNode', () => ({
  inspectExecutable: (): 'ok' => 'ok',
  killTree: vi.fn()
}))

/** Lets queued stream callbacks run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Starts the transport against a fake child and records what it reports. */
function start(): { child: FakeChild; transport: ReturnType<typeof spawnCodexTransport>; closes: string[]; lines: string[] } {
  const child = new FakeChild()
  vi.mocked(spawn).mockReturnValue(child.asChild())
  const transport = spawnCodexTransport(process.execPath, '/work/folder')
  const seen = { closes: [] as string[], lines: [] as string[] }
  transport.onLine((line) => seen.lines.push(line))
  transport.onClose((reason) => seen.closes.push(reason))
  return { child, transport, ...seen }
}

beforeEach(() => {
  vi.mocked(spawn).mockReset()
  vi.mocked(killTree).mockReset()
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
    expect(killTree).not.toHaveBeenCalled()
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

  it('stops the whole tree and settles once the program has closed, reporting it as stopped', async () => {
    const { child, transport, closes } = start()

    const stopping = transport.kill()
    expect(killTree).toHaveBeenCalledWith(child)
    child.emit('close', null, 'SIGKILL')
    await stopping

    expect(closes).toEqual(['Codex was stopped.'])
  })

  it('settles a stop after a few seconds even if the program never reports closing', async () => {
    vi.useFakeTimers()
    try {
      const { transport } = start()

      const stopping = transport.kill()
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(stopping).resolves.toBeUndefined()
      expect(killTree).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
