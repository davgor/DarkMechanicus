import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DM_CLIENT_DESCRIPTOR_ENV, parseDmClientDescriptor } from '../../../resources/skitarii/extension/dmClient'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import { eventually, terminalRig } from './__mocks__/terminalSessionsRig'

function execution(rig: ReturnType<typeof terminalRig>) {
  return rig.store.createChat({
    folder: rig.repo, agent: 'omp', model: null, role: 'planner', allowSave: false,
    forgeSetup: { intentId: randomUUID(), mode: 'execution', stepId: randomUUID() },
    firstPrompt: 'Execute the reviewed setup workflow', firstPromptDelivery: 'pending'
  })
}

it('requires explicit launch authority even after a failed attempt and blocks ordinary terminal attachment', async () => {
  const token = Symbol('fixture launch')
  let current = true
  const rig = terminalRig({ agents: [builtInAgent('omp')], deps: () => ({
    assertForgeSetupLaunch: (_chat, authorization) => {
      if (authorization !== token || !current) throw new Error('The verified setup changed.')
      return rig.repo
    }
  }) })
  const chat = execution(rig)
  try {
    expect(await rig.sessions.attach(chat)).toMatchObject({ state: 'refused', message: expect.stringContaining('explicit setup') })
    expect(rig.grantsAsked).toBe(0)
    const grant = rig.holdGrant()
    const started = rig.sessions.start(chat, { kickoff: chat.firstPrompt!, forgeSetupAuthorization: token })
    await eventually(() => rig.grantsAsked === 1, 'the initial setup grant')
    current = false
    grant.open()
    expect(await started).toMatchObject({ state: 'refused', message: 'The verified setup changed.' })
    expect(await rig.sessions.attach(chat)).toMatchObject({ state: 'refused', message: expect.stringContaining('explicit setup') })
    expect(rig.host.spawns).toHaveLength(0)
    expect(rig.revoked).toHaveLength(1)
  } finally { await rig.sessions.dispose(); rig.cleanup() }
})

it('passes the guarded launch code directory to the PTY while CLI and grant stay with the ticket member', async () => {
  const token = Symbol('fixture launch')
  let checkout = ''
  const rig = terminalRig({ agents: [builtInAgent('omp')], deps: () => ({
    assertForgeSetupLaunch: (_chat, authorization) => {
      expect(authorization).toBe(token)
      return checkout
    }
  }) })
  try {
    checkout = join(rig.root, 'separate code working tree')
    mkdirSync(checkout)
    const chat = execution(rig)
    expect(await rig.sessions.start(chat, { kickoff: chat.firstPrompt!, forgeSetupAuthorization: token })).toMatchObject({ state: 'running' })
    const spec = rig.host.last().spec
    expect(spec.cwd).toBe(checkout)
    const descriptor = spec.env[DM_CLIENT_DESCRIPTOR_ENV]!
    expect(parseDmClientDescriptor(descriptor, readFileSync(descriptor, 'utf8'))).toMatchObject({ ok: true, value: { folder: rig.repo } })
    expect(rig.store.getChat(chat)).toMatchObject({ folder: rig.repo, role: 'planner', allowSave: false, grantIds: ['gr_1'] })
  } finally {
    for (const pty of rig.host.spawns) pty.exit()
    await rig.sessions.dispose()
    rig.cleanup()
  }
})
