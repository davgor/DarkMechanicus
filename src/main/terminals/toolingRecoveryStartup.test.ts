import { describe, expect, it } from 'vitest'
import { eventually, settle, terminalRig } from './__mocks__/terminalSessionsRig'

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
