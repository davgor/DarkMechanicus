/**
 * How a `dm` CLI session comes by a role. The point of the design: the role is never what the
 * process said about itself, it is what a person granted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../test/workspaceHarness'
import type { CommandName } from '../shared/domain/api'
import { COMMAND_CAPABILITIES } from './commands/capabilities'
import { COMMANDS } from './commands/index'
import type { Workspace } from './workspace'

const COMMAND_NAMES = Object.keys(COMMANDS) as CommandName[]

let harness: Harness

beforeEach(() => {
  harness = createHarness()
})

afterEach(() => {
  harness.cleanup()
})

/** A set-up repository plus a desktop session, which is the only thing that may issue a grant. */
async function withDesktop(): Promise<Workspace> {
  const desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'grant-repo' })
  return desktop
}

async function tokenFor(
  desktop: Workspace,
  role: 'planner' | 'orchestrator' | 'worker' | 'reviewer' | 'reader',
  extra: { allowSave?: boolean; minutes?: number } = {}
): Promise<string> {
  return (await desktop.issueGrant({ role, label: 'dm CLI', ...extra })).token
}

describe('a CLI session without a grant', () => {
  it('is a reader, and may read', async () => {
    await withDesktop()
    const cli = harness.open('reader', { transport: 'cli' })
    expect((await cli.getCapabilities()).role).toBe('reader')
    await expect(cli.listEpics()).resolves.toEqual([])
  })

  it('is refused anything that changes the project', async () => {
    await withDesktop()
    const cli = harness.open('reader', { transport: 'cli' })
    await expect(cli.createEpic({ title: 'No' })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('is a reader even when the process claims to be an orchestrator', async () => {
    await withDesktop()
    // The whole point: a local process chooses its own flags, so they confer nothing.
    const cli = harness.open('orchestrator', { transport: 'cli', allowSave: true })
    expect((await cli.getCapabilities()).role).toBe('reader')
    expect((await cli.getCapabilities()).capabilities).toEqual(['read'])
    await expect(cli.createEpic({ title: 'No' })).rejects.toMatchObject({ code: 'unauthorized' })
  })
})

describe('a CLI session with a grant', () => {
  it('runs as the granted role and may do its work', async () => {
    const desktop = await withDesktop()
    const cli = harness.open('reader', { transport: 'cli', grantToken: await tokenFor(desktop, 'orchestrator') })
    const capabilities = await cli.getCapabilities()
    expect(capabilities.role).toBe('orchestrator')
    expect(capabilities.capabilities).toContain('epic.create')
    await expect(cli.createEpic({ title: 'Granted work' })).resolves.toMatchObject({ title: 'Granted work' })
  })

  it('saves plans only when the grant says so', async () => {
    const desktop = await withDesktop()
    const plain = harness.open('reader', { transport: 'cli', grantToken: await tokenFor(desktop, 'orchestrator') })
    expect((await plain.getCapabilities()).capabilities).not.toContain('plan.save')
    const saving = harness.open('reader', {
      transport: 'cli',
      grantToken: await tokenFor(desktop, 'orchestrator', { allowSave: true })
    })
    expect((await saving.getCapabilities()).capabilities).toContain('plan.save')
  })

  it('never receives a capability reserved to the person', async () => {
    const desktop = await withDesktop()
    const cli = harness.open('reader', {
      transport: 'cli',
      grantToken: await tokenFor(desktop, 'orchestrator', { allowSave: true })
    })
    const { capabilities } = await cli.getCapabilities()
    for (const human of ['checkpoint.approve', 'epic.delete', 'run.queue', 'grant.issue', 'grant.revoke']) {
      expect(capabilities).not.toContain(human)
    }
  })

})

describe('a grant decides what a CLI session may do', () => {
  it('takes its capabilities from the grant even when the flags ask for more', async () => {
    const desktop = await withDesktop()
    // Opened claiming to be a saving orchestrator, holding only a worker grant.
    const cli = harness.open('orchestrator', {
      transport: 'cli',
      allowSave: true,
      grantToken: await tokenFor(desktop, 'worker')
    })
    const { role, capabilities } = await cli.getCapabilities()
    expect(role).toBe('worker')
    expect([...capabilities].sort()).toEqual(['attempt.fail', 'attempt.heartbeat', 'attempt.submit', 'comment.write', 'read'])
    await expect(cli.createEpic({ title: 'No' })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('cannot issue itself a further grant', async () => {
    const desktop = await withDesktop()
    const cli = harness.open('reader', { transport: 'cli', grantToken: await tokenFor(desktop, 'orchestrator') })
    await expect(cli.issueGrant({ role: 'orchestrator', label: 'self' })).rejects.toMatchObject({
      code: 'unauthorized'
    })
  })

  it('records the grant on the session, so a person can see what is running on it', async () => {
    const desktop = await withDesktop()
    const { grant, token } = await desktop.issueGrant({ role: 'worker', label: 'dm CLI' })
    harness.open('reader', { transport: 'cli', grantToken: token })
    const session = (await desktop.listSessions()).find((item) => item.transport === 'cli')
    expect(session).toMatchObject({ role: 'worker', grantId: grant.id })
  })

  it('leaves no grant on a session that presented none', async () => {
    await withDesktop()
    harness.open('reader', { transport: 'cli' })
    const session = (await harness.open('desktop').listSessions()).find((item) => item.transport === 'cli')
    expect(session?.grantId).toBeNull()
  })
})

describe('a grant that is no longer good', () => {
  it('refuses to open a session at all, rather than quietly becoming a reader', async () => {
    const desktop = await withDesktop()
    const token = await tokenFor(desktop, 'orchestrator', { minutes: 5 })
    harness.clock.advanceSeconds(6 * 60)
    expect(() => harness.open('reader', { transport: 'cli', grantToken: token })).toThrow(/not usable/i)
  })

  it('cannot be used to open a new session once it is revoked', async () => {
    const desktop = await withDesktop()
    const { grant, token } = await desktop.issueGrant({ role: 'orchestrator', label: 'dm CLI' })
    expect(() => harness.open('reader', { transport: 'cli', grantToken: token })).not.toThrow()
    await desktop.revokeGrant({ grantId: grant.id })
    expect(() => harness.open('reader', { transport: 'cli', grantToken: token })).toThrow(/not usable/i)
  })

  it('stops the session it is already running, not merely the next one to start', async () => {
    const desktop = await withDesktop()
    const { grant, token } = await desktop.issueGrant({ role: 'orchestrator', label: 'dm CLI' })
    const cli = harness.open('reader', { transport: 'cli', grantToken: token })
    await expect(cli.createEpic({ title: 'Before' })).resolves.toBeDefined()
    await desktop.revokeGrant({ grantId: grant.id })
    await expect(cli.createEpic({ title: 'After' })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('stops the session it is already running when it expires', async () => {
    const desktop = await withDesktop()
    const token = await tokenFor(desktop, 'orchestrator', { minutes: 5 })
    const cli = harness.open('reader', { transport: 'cli', grantToken: token })
    await expect(cli.createEpic({ title: 'Before' })).resolves.toBeDefined()
    harness.clock.advanceSeconds(6 * 60)
    await expect(cli.createEpic({ title: 'After' })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('leaves a session that presented no grant alone, since it has nothing to re-check', async () => {
    await withDesktop()
    const cli = harness.open('reader', { transport: 'cli' })
    await expect(cli.listEpics()).resolves.toBeDefined()
    await expect(cli.listEpics()).resolves.toBeDefined()
  })

  it('refuses a token that was never issued', async () => {
    await withDesktop()
    expect(() => harness.open('reader', { transport: 'cli', grantToken: 'dmg_made_up' })).toThrow(/not usable/i)
  })
})

describe('grants and the other transports', () => {
  it('leaves an MCP session role exactly as its launch flags set it', async () => {
    const desktop = await withDesktop()
    const token = await tokenFor(desktop, 'reader')
    // A grant is a CLI concern; a stdio session is configured by the person who wrote the host config.
    const mcp = harness.open('orchestrator', { transport: 'stdio', allowSave: true, grantToken: token })
    expect((await mcp.getCapabilities()).role).toBe('orchestrator')
  })

  it('does not even redeem the grant for another transport, so it is not spent or recorded', async () => {
    const desktop = await withDesktop()
    const { grant, token } = await desktop.issueGrant({ role: 'reader', label: 'dm CLI' })
    harness.open('orchestrator', { transport: 'stdio', allowSave: true, grantToken: token })
    const after = (await desktop.listGrants()).find((item) => item.id === grant.id)
    expect(after?.lastUsedAt).toBeNull()
  })
})

describe('every command a reader must not reach', () => {
  /**
   * Exhaustive rather than a sample: a command added later without a capability check would be
   * reachable by any process that can run `dm`, and this is what would notice.
   */
  const READ_ONLY: CommandName[] = COMMAND_NAMES.filter((name) => COMMAND_CAPABILITIES[name] === 'read')
  const PRIVILEGED: CommandName[] = COMMAND_NAMES.filter((name) => COMMAND_CAPABILITIES[name] !== 'read')

  it('covers the whole command table, so neither list can quietly empty', () => {
    expect(READ_ONLY.length).toBeGreaterThan(5)
    expect(PRIVILEGED.length).toBeGreaterThan(20)
    expect(READ_ONLY.length + PRIVILEGED.length).toBe(COMMAND_NAMES.length)
  })

  it.each(PRIVILEGED)('refuses %s to a session with no grant', async (name) => {
    await withDesktop()
    const cli = harness.open('orchestrator', { transport: 'cli', allowSave: true })
    // Input is deliberately empty: a refusal must come from the capability check, so it must not
    // matter whether the arguments would have been valid.
    const outcome = await cli.execute(name, {}).then(
      () => 'allowed',
      (error: unknown) => (error as { code?: string }).code ?? 'thrown'
    )
    expect(outcome).not.toBe('allowed')
    expect(['unauthorized', 'invalid_input']).toContain(outcome)
  })

  /**
   * Commands that take no arguments have nothing but the capability check standing in the way, so
   * for these the refusal proves the check itself rather than the schema getting there first.
   */
  const UNGUARDED_BY_SCHEMA = PRIVILEGED.filter((name) => COMMANDS[name].schema === undefined)

  it('has commands whose only gate is the capability check', () => {
    expect(UNGUARDED_BY_SCHEMA.length).toBeGreaterThan(0)
  })

  it.each(UNGUARDED_BY_SCHEMA)('refuses %s with unauthorized, not merely with bad arguments', async (name) => {
    await withDesktop()
    const cli = harness.open('orchestrator', { transport: 'cli', allowSave: true })
    await expect(cli.execute(name, {})).rejects.toMatchObject({ code: 'unauthorized' })
  })
})
