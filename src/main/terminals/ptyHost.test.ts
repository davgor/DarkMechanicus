import { describe, expect, it } from 'vitest'
import { FakePtyHost } from './__mocks__/fakePtyHost'
import { createNodePtyHost, type NodePtyModule, type PtyExit, type PtyHost, type PtySpawnSpec } from './ptyHost'

const SPEC: PtySpawnSpec = {
  file: '/usr/local/bin/agent',
  args: ['--model', 'haiku', 'two words'],
  cwd: '/private/tmp/work',
  env: { PATH: '/usr/bin', DM_SESSION_TOKEN: 'grant' },
  cols: 100,
  rows: 30
}

type Listener<T> = (event: T) => void

/** node-pty's module as `createNodePtyHost` sees it: records each spawn and lets the test emit events. */
class FakeNodePty implements NodePtyModule {
  readonly calls: { file: string; args: string[] | string; options: Record<string, unknown> }[] = []
  readonly writes: string[] = []
  readonly resizes: [number, number][] = []
  kills = 0
  readonly dataListeners = new Set<Listener<string>>()
  readonly exitListeners = new Set<Listener<{ exitCode: number; signal?: number }>>()

  spawn: NodePtyModule['spawn'] = (file, args, options) => {
    this.calls.push({ file, args, options: { ...options } })
    return {
      pid: 777,
      write: (data) => {
        this.writes.push(data)
      },
      resize: (cols, rows) => {
        this.resizes.push([cols, rows])
      },
      kill: () => {
        this.kills += 1
      },
      onData: (listener) => subscribe(this.dataListeners, listener),
      onExit: (listener) => subscribe(this.exitListeners, listener)
    }
  }
}

function subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): { dispose: () => void } {
  listeners.add(listener)
  return { dispose: () => listeners.delete(listener) }
}

/** An executable helper, so the macOS cases test the host and not this machine's install (`ptyHelperCheck.test.ts`). */
const executableHelper = (): { mode: number; isFile: () => boolean } => ({ mode: 0o100755, isFile: () => true })

async function hostOver(platform: string): Promise<{ host: PtyHost; pty: FakeNodePty }> {
  const pty = new FakeNodePty()
  const host = await createNodePtyHost({
    platform,
    load: () => Promise.resolve(pty),
    helperPath: '/app/spawn-helper',
    statHelper: executableHelper
  })
  return { host, pty }
}

describe('createNodePtyHost', () => {
  it('spawns the file with the argv, cwd, environment and size it is given, as an xterm', async () => {
    const { host, pty } = await hostOver('darwin')

    const child = host.spawn(SPEC)

    expect(child.pid).toBe(777)
    expect(pty.calls).toEqual([
      {
        file: '/usr/local/bin/agent',
        args: ['--model', 'haiku', 'two words'],
        options: { name: 'xterm-256color', cwd: '/private/tmp/work', env: SPEC.env, cols: 100, rows: 30 }
      }
    ])
  })

  it('copies the argv, so node-pty never holds the caller array', async () => {
    const { host, pty } = await hostOver('linux')
    const args = ['a']

    host.spawn({ ...SPEC, args })

    expect(pty.calls[0]?.args).toEqual(['a'])
    expect(pty.calls[0]?.args).not.toBe(args)
  })

  it("uses node-pty's bundled ConPTY on Windows and passes a pre-escaped command line through as is", async () => {
    const { host, pty } = await hostOver('win32')

    host.spawn({ ...SPEC, file: 'C:\\agent.exe', args: '"two words" --x' })

    expect(pty.calls[0]?.args).toBe('"two words" --x')
    expect(pty.calls[0]?.options['useConptyDll']).toBe(true)
  })

  it('refuses a command line string outside Windows, where it has no meaning', async () => {
    const { host, pty } = await hostOver('darwin')

    expect(() => host.spawn({ ...SPEC, args: '--model haiku' })).toThrow(/Windows/)
    expect(pty.calls).toEqual([])
  })
})

describe('createNodePtyHost: the running PTY', () => {
  it('passes input, resizes and kills through to node-pty', async () => {
    const { host, pty } = await hostOver('darwin')
    const child = host.spawn(SPEC)

    child.write('hi\r')
    child.resize(120, 40)
    child.kill()

    expect(pty.writes).toEqual(['hi\r'])
    expect(pty.resizes).toEqual([[120, 40]])
    expect(pty.kills).toBe(1)
  })

  it('delivers output and the exit to listeners until their disposers are called', async () => {
    const { host, pty } = await hostOver('darwin')
    const child = host.spawn(SPEC)
    const data: string[] = []
    const exits: PtyExit[] = []
    const stopData = child.onData((chunk) => data.push(chunk))
    const stopExit = child.onExit((exit) => exits.push(exit))

    for (const listener of pty.dataListeners) listener('out')
    for (const listener of pty.exitListeners) listener({ exitCode: 0, signal: 9 })
    for (const listener of pty.exitListeners) listener({ exitCode: 2 })
    stopData()
    stopExit()

    expect(data).toEqual(['out'])
    expect(exits).toEqual([
      { exitCode: 0, signal: 9 },
      { exitCode: 2, signal: null }
    ])
    expect(pty.dataListeners.size).toBe(0)
    expect(pty.exitListeners.size).toBe(0)
  })

  it('reports a node-pty that cannot be loaded when it is created, not at the first spawn', async () => {
    const load = (): Promise<NodePtyModule> => Promise.reject(new Error('Failed to load native module: pty.node'))

    await expect(createNodePtyHost({ platform: 'linux', load })).rejects.toThrow(/pty\.node/)
  })
})

describe('FakePtyHost', () => {
  it('records each spawn and drives output, input, resize, kill and exit like a PTY', () => {
    const host = new FakePtyHost()
    const child = host.spawn(SPEC)
    const data: string[] = []
    const exits: PtyExit[] = []
    const stopData = child.onData((chunk) => data.push(chunk))
    child.onExit((exit) => exits.push(exit))

    child.write('typed')
    child.resize(80, 24)
    child.kill()
    host.last().emitData('shown')
    stopData()
    host.last().emitData('not shown')
    host.last().exit({ exitCode: 1, signal: null })

    expect(host.spawns.map((spawned) => spawned.spec)).toEqual([SPEC])
    expect(child.pid).toBeGreaterThan(0)
    expect(host.last().written).toEqual(['typed'])
    expect(host.last().sizes).toEqual([[80, 24]])
    expect(host.last().kills).toBe(1)
    expect(data).toEqual(['shown'])
    expect(exits).toEqual([{ exitCode: 1, signal: null }])
    expect(host.last().exited).toBe(true)
  })

  it('throws the error it is told to from the next spawn only', () => {
    const host = new FakePtyHost()
    host.failNextSpawn(new Error('posix_spawnp failed.'))

    expect(() => host.spawn(SPEC)).toThrow('posix_spawnp failed.')
    expect(host.spawn(SPEC).pid).toBeGreaterThan(0)
    expect(host.spawns).toHaveLength(1)
  })
})
