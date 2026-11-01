/**
 * The sign-in terminals at their edges: no error handler given, a tree kill that fails, and calls for an agent
 * whose login does not run.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import type { PtyTree } from '../agents/processTree'
import { FakePtyHost } from './__mocks__/fakePtyHost'
import { eventually, recorder, settle } from './__mocks__/terminalSessionsRig'
import { createLoginTerminals, type LoginTerminals } from './loginTerminals'

const CLAUDE = builtInAgent('claude', { executablePath: '/Users/me/.local/bin/claude' })

const host = new FakePtyHost()

afterEach(async () => {
  for (const pty of host.spawns) {
    if (!pty.exited) pty.exit()
  }
  await settle()
})

function logins(killTree: (tree: PtyTree) => Promise<boolean>, errors?: unknown[]): LoginTerminals {
  return createLoginTerminals({
    host: async () => host,
    killTree,
    home: '/Users/me',
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
    ...(errors === undefined ? {} : { onError: (error: unknown) => errors.push(error) })
  })
}

const killAndWait = (tree: PtyTree): Promise<boolean> => {
  tree.kill()
  return tree.exited.then(() => true)
}

describe('loginTerminals: at the edges', () => {
  it('keeps telling other views when one throws and no error handler is given', async () => {
    const terminals = logins(killAndWait)
    const heard = recorder()
    await terminals.attach(CLAUDE, () => {
      throw new Error('The view is gone.')
    })
    await terminals.attach(CLAUDE, heard.listener)
    await settle()

    host.last().emitData('Paste the code: ')
    await eventually(() => heard.events.length > 0, 'the output to be heard')

    expect(heard.events).toEqual([{ kind: 'output', data: 'Paste the code: ' }])
  })

  it('reports a tree kill that fails when the last view leaves, and signs in again once the login has exited', async () => {
    const errors: unknown[] = []
    const terminals = logins(async () => {
      throw new Error('ps is missing.')
    }, errors)
    const view = recorder()
    await terminals.attach(CLAUDE, view.listener)
    const first = host.last()

    terminals.detach(CLAUDE.id, view.listener)
    await eventually(() => errors.length > 0, 'the kill to fail')
    first.exit({ exitCode: 0, signal: null })
    await settle()
    await terminals.attach(CLAUDE, recorder().listener)

    // Once for the stop, and once for the exit, which ends what the login left in its process group.
    expect(errors.map((error) => (error instanceof Error ? error.message : String(error)))).toEqual(['ps is missing.', 'ps is missing.'])
    expect(host.last().pid).not.toBe(first.pid)
  })

  it('ignores input, sizes, leaving and removal for an agent whose login does not run, and starts nothing', async () => {
    const terminals = logins(killAndWait)
    const spawned = host.spawns.length

    terminals.write(CLAUDE.id, 'early')
    terminals.resize(CLAUDE.id, 120, 40)
    terminals.detach(CLAUDE.id, recorder().listener)
    await terminals.endAgent(CLAUDE.id)

    expect([host.spawns.length - spawned, terminals.busy()]).toEqual([0, false])
  })
})
