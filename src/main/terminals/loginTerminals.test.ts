/**
 * The sign-in terminals (`docs/design/chat-shells.md`, "Sign-in detection"): one PTY per agent running the CLI's
 * own login in the home folder, with no grant, shared by every view that shows it, stopped when the last view
 * leaves it, when the agent is removed, and at quit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentView } from '../../shared/desktop/api'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import type { PtyTree } from '../agents/processTree'
import { FakePty, FakePtyHost } from './__mocks__/fakePtyHost'
import type { PtySpawnSpec } from './ptyHost'
import { recorder, settle } from './__mocks__/terminalSessionsRig'
import { createLoginTerminals, type LoginTerminals } from './loginTerminals'

const CLAUDE = builtInAgent('claude', { executablePath: '/Users/me/.local/bin/claude' })
const A8S = builtInAgent('autonomous', { executablePath: '/Users/me/.local/bin/a8s' })
const ENV = { PATH: '/usr/bin:/bin', HOME: '/Users/me', DM_SESSION_TOKEN: 'dmg_main_had_one', ELECTRON_RUN_AS_NODE: '1' }

/** The fake host, with a hook run just after each spawn (node-pty's events never come during it): a test plays a CLI that exits at once with it. */
class HookedHost extends FakePtyHost {
  onSpawnHook: (pty: FakePty) => void = () => {}

  override spawn(spec: PtySpawnSpec): FakePty {
    const pty = super.spawn(spec)
    queueMicrotask(() => this.onSpawnHook(pty))
    return pty
  }
}

interface World {
  logins: LoginTerminals
  host: HookedHost
  hostFails: Error | null
  killed: PtyTree[]
  errors: unknown[]
}

let w: World

function world(): World {
  const state: World = { logins: undefined as never, host: new HookedHost(), hostFails: null, killed: [], errors: [] }
  state.logins = createLoginTerminals({
    host: async () => {
      if (state.hostFails !== null) {
        throw state.hostFails
      }
      return state.host
    },
    killTree: (tree) => {
      state.killed.push(tree)
      if (!tree.hasExited()) {
        tree.kill()
      }
      return tree.exited.then(() => true)
    },
    home: '/Users/me',
    platform: 'darwin',
    env: ENV,
    onError: (error) => {
      state.errors.push(error)
    }
  })
  return state
}

beforeEach(() => {
  w = world()
})

afterEach(async () => {
  for (const pty of w.host.spawns) {
    if (!pty.exited) pty.exit()
  }
  await settle()
})

/** Ends every PTY whose kill was asked for, as the OS would. */
function exitKilled(): void {
  for (const pty of w.host.spawns) {
    if (pty.kills > 0 && !pty.exited) pty.exit({ exitCode: 0, signal: 9 })
  }
}

describe('loginTerminals: what starts', () => {
  it('runs the registered executable with only its login command, in the home folder, with no grant and no Electron switch', async () => {
    const heard = recorder()

    expect(await w.logins.attach(CLAUDE, heard.listener)).toEqual({ state: 'running', snapshot: '' })

    const [pty] = w.host.spawns
    expect([pty?.spec.file, pty?.spec.args, pty?.spec.cwd]).toEqual(['/Users/me/.local/bin/claude', ['auth', 'login'], '/Users/me'])
    expect(pty?.spec.env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/Users/me', TERM: 'xterm-256color', COLORTERM: 'truecolor' })
  })

  it('runs `a8s init` for Autonomous, the model sign-in, never `a8s login`', async () => {
    await w.logins.attach(A8S, recorder().listener)

    expect(w.host.last().spec.args).toEqual(['init'])
  })

  it('starts nothing for a custom CLI', async () => {
    const custom: AgentView = builtInAgent('cursor', { id: 'cu_01m65kwqqeyajbj5bnq81gngrb', kind: 'custom', executablePath: '/opt/mine' })

    expect(await w.logins.attach(custom, recorder().listener)).toEqual({ state: 'refused', message: expect.stringMatching(/no sign-in command/) })
    expect(w.host.spawns).toEqual([])
  })

  it('says why when PTYs cannot run here or the program cannot be started', async () => {
    w.hostFails = new Error('The PTY helper cannot run.')
    expect(await w.logins.attach(CLAUDE, recorder().listener)).toEqual({ state: 'failed', message: 'The PTY helper cannot run.' })

    w.hostFails = null
    w.host.failNextSpawn(new Error('posix_spawnp failed.'))
    expect(await w.logins.attach(CLAUDE, recorder().listener)).toEqual({ state: 'failed', message: 'posix_spawnp failed.' })
    expect(w.logins.busy()).toBe(false)
  })
})

describe('loginTerminals: one per agent, shared', () => {
  it('gives a second view the same PTY, from its screen so far, and both hear what follows', async () => {
    const first = recorder()
    const second = recorder()
    await w.logins.attach(CLAUDE, first.listener)
    w.host.last().emitData('Opening your browser\r\n')
    await settle()

    const answer = await w.logins.attach(CLAUDE, second.listener)
    w.host.last().emitData('Paste code: ')
    await settle()

    expect(w.host.spawns).toHaveLength(1)
    expect(answer).toMatchObject({ state: 'running', snapshot: expect.stringContaining('Opening your browser') })
    expect(first.events).toEqual([
      { kind: 'output', data: 'Opening your browser\r\n' },
      { kind: 'output', data: 'Paste code: ' }
    ])
    expect(second.events).toEqual([{ kind: 'output', data: 'Paste code: ' }])
  })

  it('shares one start between attaches that arrive together', async () => {
    const answers = await Promise.all([w.logins.attach(CLAUDE, recorder().listener), w.logins.attach(CLAUDE, recorder().listener)])

    expect(answers.map((answer) => answer.state)).toEqual(['running', 'running'])
    expect(w.host.spawns).toHaveLength(1)
  })

  it('passes input and sizes to the PTY', async () => {
    await w.logins.attach(CLAUDE, recorder().listener)

    w.logins.write(CLAUDE.id, 'abc-123\r')
    w.logins.resize(CLAUDE.id, 100, 30)

    expect(w.host.last().written).toEqual(['abc-123\r'])
    expect(w.host.last().sizes).toEqual([[100, 30]])
  })
})

describe('loginTerminals: a login that exits', () => {
  it('tells the exit, then starts a fresh login on the next attach', async () => {
    const heard = recorder()
    await w.logins.attach(CLAUDE, heard.listener)

    w.host.last().exit({ exitCode: 0, signal: null })
    await settle()
    await w.logins.attach(CLAUDE, recorder().listener)

    expect(heard.events).toEqual([{ kind: 'exited', exitCode: 0, signal: null, message: null, resumed: false }])
    expect(w.host.spawns).toHaveLength(2)
    // What the CLI left running in its process group is ended too.
    expect(w.killed).toHaveLength(1)
  })

  it('answers a login that exited before its attach answered with its last screen, and tells that attach the exit', async () => {
    w.host.onSpawnHook = (pty) => {
      pty.emitData('error: no browser\r\n')
      pty.exit({ exitCode: 1, signal: null })
    }
    const heard = recorder()

    const answer = await w.logins.attach(CLAUDE, heard.listener)
    await settle()

    expect(answer).toMatchObject({ state: 'running', snapshot: expect.stringContaining('error: no browser') })
    expect(heard.events).toEqual([{ kind: 'exited', exitCode: 1, signal: null, message: null, resumed: false }])
    expect(w.host.spawns).toHaveLength(1)
  })
})

describe('loginTerminals: stopping', () => {
  it('stops the login when the last view leaves it (Back), and not before', async () => {
    const first = recorder()
    const second = recorder()
    await w.logins.attach(CLAUDE, first.listener)
    await w.logins.attach(CLAUDE, second.listener)

    w.logins.detach(CLAUDE.id, first.listener)
    expect(w.host.last().kills).toBe(0)

    w.logins.detach(CLAUDE.id, second.listener)
    expect(w.host.last().kills).toBe(1)
    expect(w.logins.busy()).toBe(true)
    exitKilled()
    await settle()
    expect(w.logins.busy()).toBe(false)
  })

  it('starts a fresh login when Sign in is pressed again right after Back, once the old one has gone', async () => {
    const first = recorder()
    await w.logins.attach(CLAUDE, first.listener)
    w.logins.detach(CLAUDE.id, first.listener)

    const again = w.logins.attach(CLAUDE, recorder().listener)
    exitKilled()

    expect(await again).toMatchObject({ state: 'running' })
    expect(w.host.spawns).toHaveLength(2)
    expect(w.host.spawns[1]?.kills).toBe(0)
  })

  it('stops the login of a removed agent, and only that one', async () => {
    const heard = recorder()
    await w.logins.attach(CLAUDE, heard.listener)
    await w.logins.attach(A8S, recorder().listener)

    const ended = w.logins.endAgent(CLAUDE.id)
    exitKilled()
    await ended
    await settle()

    expect(w.host.spawns.map((pty) => pty.kills)).toEqual([1, 0])
    expect(heard.events).toEqual([{ kind: 'exited', exitCode: 0, signal: 9, message: "The agent was removed, so its sign-in was stopped.", resumed: false }])
  })
})

describe('loginTerminals: at quit', () => {
  it('is disposed at quit: every login is killed, the quit waits for their exits, and nothing starts afterwards', async () => {
    await w.logins.attach(CLAUDE, recorder().listener)
    await w.logins.attach(A8S, recorder().listener)
    expect(w.logins.busy()).toBe(true)

    let disposed = false
    const disposing = w.logins.dispose().then(() => {
      disposed = true
    })
    await settle()
    expect([disposed, w.host.spawns.map((pty) => pty.kills)]).toEqual([false, [1, 1]])

    exitKilled()
    await disposing

    expect(w.logins.busy()).toBe(false)
    expect(await w.logins.attach(CLAUDE, recorder().listener)).toEqual({ state: 'failed', message: expect.stringMatching(/quitting/) })
    expect(w.host.spawns).toHaveLength(2)
  })

  it('kills a login whose start was under way when the quit came, before it can run', async () => {
    let openHost: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      openHost = resolve
    })
    const slow = createLoginTerminals({
      host: async () => {
        await held
        return w.host
      },
      killTree: (tree) => (tree.kill(), tree.exited.then(() => true)),
      home: '/Users/me',
      platform: 'darwin',
      env: ENV
    })
    const attaching = slow.attach(CLAUDE, recorder().listener)

    const disposing = slow.dispose()
    openHost()

    expect(await attaching).toEqual({ state: 'failed', message: expect.stringMatching(/quitting/) })
    await disposing
    expect(w.host.spawns).toEqual([])
  })
})
