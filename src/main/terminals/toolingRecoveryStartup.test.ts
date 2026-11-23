import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DM_CLIENT_DESCRIPTOR_ENV, parseDmClientDescriptor } from '../../../resources/skitarii/extension/dmClient'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import { describe, expect, it } from 'vitest'
import { eventually, gate, settle, terminalRig } from './__mocks__/terminalSessionsRig'

describe('repair startup live authority fences', () => {
  it('refuses source replacement during native authentication before any grant or PTY is created', async () => {
    let available = true
    const rig = terminalRig({ deps: () => ({ assertRecoveryLaunch: () => { if (!available) throw new Error('Exact source identity changed') } }) })
    try {
      const chat = rig.store.createChat({ folder: rig.repo, agent: 'claude', model: null, role: 'orchestrator', allowSave: false, repairIncidentId: 'fixture', firstPrompt: 'Non-sensitive diagnostic fixture' })
      const auth = rig.holdAuth()
      const pending = rig.sessions.start(chat, { kickoff: chat.firstPrompt! })
      await settle(); available = false; auth.open({ state: 'signed_in', reason: 'Fixture signed in' })
      expect(await pending).toMatchObject({ state: 'refused', message: 'Exact source identity changed' })
      expect(rig.grantsAsked).toBe(0)
      expect(rig.host.spawns).toHaveLength(0)
    } finally { await rig.sessions.dispose(); rig.cleanup() }
  })

  it('revokes a grant issued during caller revocation and never spawns a stale repair agent', async () => {
    let current = true
    const rig = terminalRig({ deps: () => ({ assertRecoveryLaunch: () => { if (!current) throw new Error('Caller authority revoked') } }) })
    try {
      const chat = rig.store.createChat({ folder: rig.repo, agent: 'claude', model: null, role: 'orchestrator', allowSave: false, repairIncidentId: 'fixture', firstPrompt: 'Non-sensitive diagnostic fixture' })
      const issued = rig.holdGrant()
      const pending = rig.sessions.start(chat, { kickoff: chat.firstPrompt! })
      await eventually(() => rig.grantsAsked > 0, 'the repair grant issuance'); current = false; issued.open()
      expect(await pending).toMatchObject({ state: 'refused', message: 'Caller authority revoked' })
      expect(rig.host.spawns).toHaveLength(0)
      expect(rig.revoked).toHaveLength(1)
    } finally { await rig.sessions.dispose(); rig.cleanup() }
  })
})

it('launches the repair in the verified worktree with the member CLI descriptor and durable chat identity', async () => {
  let checkout = ''
  const rig = terminalRig({
    agents: [builtInAgent('omp')],
    deps: () => ({ assertRecoveryLaunch: async () => checkout })
  })
  try {
    checkout = join(rig.root, 'Dark Mechanicus checkout')
    mkdirSync(checkout)
    const chat = rig.store.createChat({
      folder: rig.repo, agent: 'omp', model: null, role: 'orchestrator', allowSave: false,
      repairIncidentId: 'verified-incident', firstPrompt: 'Repair the verified source checkout'
    })
    const answer = await rig.sessions.start(chat, { kickoff: chat.firstPrompt! })
    expect(answer.state).toBe('running')
    const spec = rig.host.last().spec
    expect(spec.cwd).toBe(checkout)
    const args = spec.args as readonly string[]
    expect(args[args.indexOf('--cwd') + 1]).toBe(checkout)
    expect(rig.grantsAsked).toBe(1)
    expect(rig.store.getChat(chat)).toMatchObject({ folder: rig.repo, repairIncidentId: 'verified-incident', grantIds: ['gr_1'] })
    const path = spec.env[DM_CLIENT_DESCRIPTOR_ENV]!
    const descriptor = parseDmClientDescriptor(path, readFileSync(path, 'utf8'))
    expect(descriptor).toMatchObject({ ok: true, value: { folder: rig.repo } })
  } finally {
    for (const pty of rig.host.spawns) pty.exit()
    await rig.sessions.dispose()
    rig.cleanup()
  }
})

it('rechecks the local tracked member after the final async repair authorization', async () => {
  const finalGuard = gate<string>()
  let checks = 0
  const rig = terminalRig({ deps: () => ({
    assertRecoveryLaunch: () => ++checks === 3 ? finalGuard.promise : rig.repo
  }) })
  try {
    const chat = rig.store.createChat({ folder: rig.repo, agent: 'claude', model: null, role: 'orchestrator', allowSave: false,
      repairIncidentId: 'checking-incident', firstPrompt: 'Verify the dedicated checkout' })
    const pending = rig.sessions.start(chat, { kickoff: chat.firstPrompt! })
    await eventually(() => checks === 3, 'the final asynchronous source check')
    rig.tracked.delete(rig.repo)
    finalGuard.open(rig.repo)
    expect(await pending).toMatchObject({ state: 'refused' })
    expect(rig.host.spawns).toHaveLength(0)
    await eventually(() => rig.revoked.length === 1, 'the repair grant revoke')
  } finally {
    finalGuard.open(rig.repo)
    await rig.sessions.dispose()
    rig.cleanup()
  }
})
