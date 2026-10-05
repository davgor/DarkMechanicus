import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeChild } from '../agents/__mocks__/fakeChild'
import { killProcessTree } from '../agents/processTree'
import { runInstallerProcess } from './agentInstallerNode'
import { runProcess } from './agentProbeNode'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('../agents/processTree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agents/processTree')>()),
  killProcessTree: vi.fn()
}))

/** The two process runners that stop a program that runs past its time: the version probe and the installer. */
const RUNNERS: [string, (timeoutMs: number) => Promise<{ kind: string }>][] = [
  ['the probe runner', (timeoutMs) => runProcess({ file: '/opt/agent', args: ['--version'], verbatimArguments: false }, timeoutMs)],
  ['the installer runner', (timeoutMs) => runInstallerProcess({ file: '/bin/sh', args: ['install.sh'], env: {} }, timeoutMs)]
]

const platform = Object.getOwnPropertyDescriptor(process, 'platform')

/** Holds the tree kill back until the test lets it finish. */
function heldKill(): { release: () => void } {
  const held = { release: () => {} }
  vi.mocked(killProcessTree).mockReturnValue(
    new Promise<boolean>((resolve) => {
      held.release = () => {
        resolve(true)
      }
    })
  )
  return held
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(spawn).mockReset()
  vi.mocked(killProcessTree).mockReset()
  vi.mocked(killProcessTree).mockResolvedValue(true)
})

afterEach(() => {
  vi.useRealTimers()
  if (platform !== undefined) {
    Object.defineProperty(process, 'platform', platform)
  }
})

describe.each(RUNNERS)('%s: a program that runs past its time', (_name, run) => {
  it('ends the whole tree and reports the timeout only once the tree is gone', async () => {
    const child = new FakeChild(4242)
    vi.mocked(spawn).mockReturnValue(child.asChild())
    const held = heldKill()
    let outcome: { kind: string } | null = null

    const running = run(1000).then((result) => {
      outcome = result
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(killProcessTree).toHaveBeenCalledWith(child)
    expect(outcome).toBeNull()
    held.release()
    await running

    expect(outcome).toEqual(expect.objectContaining({ kind: 'timed_out' }))
  })

  it('still reports a timeout, not an exit, when the program closes before the tree kill has finished', async () => {
    const child = new FakeChild(4242)
    vi.mocked(spawn).mockReturnValue(child.asChild())
    heldKill()

    const running = run(1000)
    await vi.advanceTimersByTimeAsync(1000)
    child.emit('close', null, 'SIGKILL')

    expect(await running).toEqual(expect.objectContaining({ kind: 'timed_out' }))
  })

  it('does not kill anything for a program that ends in time', async () => {
    const child = new FakeChild(4242)
    vi.mocked(spawn).mockReturnValue(child.asChild())

    const running = run(1000)
    child.emit('close', 0, null)

    expect(await running).toEqual(expect.objectContaining({ kind: 'exited' }))
    await vi.advanceTimersByTimeAsync(5000)
    expect(killProcessTree).not.toHaveBeenCalled()
  })

  it('starts the program as its own process group leader where there are groups, and not on Windows', () => {
    vi.mocked(spawn).mockReturnValue(new FakeChild(1).asChild())
    Object.defineProperty(process, 'platform', { value: 'linux' })
    void run(1000)
    Object.defineProperty(process, 'platform', { value: 'win32' })
    void run(1000)

    const detached = vi.mocked(spawn).mock.calls.map((call) => (call[2] as { detached: boolean }).detached)
    expect(detached).toEqual([true, false])
  })
})
