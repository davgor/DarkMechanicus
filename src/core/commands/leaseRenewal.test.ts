/**
 * DM-975: any successful call that carries a live claim's token renews its lease, and the default lease is an hour.
 * A holder kept alive only by comments and attachments never expires; a silent holder still does, and its ticket is
 * claimable again. Each role gets its own Workspace session over one database, on the harness's controlled clock.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_POLICIES } from '../../shared/domain/bundle'
import { pngBytes } from '../../test/images'
import { metricsWorld, type MetricsWorld } from '../../test/metricsWorld'
import { createHarness, TEST_STORAGE, type Harness } from '../../test/workspaceHarness'
import { openWorkspace } from '../workspace'

let harness: Harness
let w: MetricsWorld

beforeEach(async () => {
  harness = createHarness()
  w = await metricsWorld(harness, { busy: { title: 'Busy holder' }, silent: { title: 'Silent holder' } }, ['busy', 'silent'])
  writeFileSync(join(harness.root, 'shot.png'), pngBytes(64, 48))
})

afterEach(() => {
  harness.cleanup()
})

/** The attempt as the orchestrator sees it now: reading the run first expires overdue leases. */
async function attemptOf(id: string) {
  const run = await w.orchestrator.getRun({ runId: w.runId })
  const attempt = run?.attempts.find((item) => item.id === id)
  if (attempt === undefined) throw new Error(`Attempt ${id} is not in the run.`)
  return attempt
}

const held = (ref: string) => w.attempt[ref] ?? { id: '', token: '' }

describe('DM-975: lease length and renewal by any call', () => {
  it('grants an hour by default', async () => {
    expect(DEFAULT_POLICIES.leaseSeconds).toBeGreaterThanOrEqual(3600)
    const attempt = await attemptOf(held('silent').id)
    expect(Date.parse(attempt.leaseExpiresAt ?? '') - Date.parse(harness.clock.nowIso())).toBe(3600 * 1000)
  })

  it('keeps a claim alive through comments and attachments alone, far past the old and the new lease', async () => {
    const worker = harness.open('worker')
    const { id, token } = held('busy')
    // 12 calls 850 s apart: 10,200 s in all, past 900 s many times over and past 3,600 s more than twice.
    for (let call = 0; call < 12; call += 1) {
      harness.clock.advanceSeconds(850)
      if (call % 2 === 0) {
        await worker.addComment({ epicId: w.epicId, ticketId: w.ticket.busy, body: `Still working (${call})`, claimToken: token })
      } else {
        await worker.addAttachment({ path: join(harness.root, 'shot.png'), label: `Progress ${call}`, purpose: 'evidence', claimToken: token })
      }
      const attempt = await attemptOf(id)
      expect(attempt.state).toBe('claimed')
      expect(Date.parse(attempt.leaseExpiresAt ?? '') - Date.parse(harness.clock.nowIso())).toBe(3600 * 1000)
    }
  })

  it('expires a silent claim after the default lease and requeues its ticket once the orchestrator reconciles it', async () => {
    harness.clock.advanceSeconds(3599)
    expect((await attemptOf(held('silent').id)).state).toBe('claimed')
    harness.clock.advanceSeconds(2)
    expect((await attemptOf(held('silent').id)).state).toBe('lease_expired')
    await w.orchestrator.reconcileAttempt({ attemptId: held('silent').id, resolution: 'abandon' })
    const again = await w.orchestrator.claimTicket({ runId: w.runId, ticketId: w.ticket.silent ?? '', worker: { label: 'worker-again' } })
    expect(again.attempt).toMatchObject({ number: 2, state: 'claimed' })
  })

  it('renews nothing for a call without the token, or with another claim\'s, a forged or an ended one', async () => {
    const worker = harness.open('worker')
    const { id, token } = held('silent')
    const before = (await attemptOf(id)).leaseExpiresAt
    harness.clock.advanceSeconds(600)
    await worker.addComment({ epicId: w.epicId, ticketId: w.ticket.silent, body: 'No token' })
    await worker.addComment({ epicId: w.epicId, ticketId: w.ticket.silent, body: 'Forged', claimToken: `${id}.forgedSecretAAAAAAAA` })
    await worker.addComment({ epicId: w.epicId, ticketId: w.ticket.busy, body: 'Other claim', claimToken: held('busy').token })
    expect((await attemptOf(id)).leaseExpiresAt).toBe(before)
    await worker.failAttempt({ attemptId: id, claimToken: token, failure: { reason: 'Gave up' } })
    await worker.addComment({ epicId: w.epicId, ticketId: w.ticket.silent, body: 'After failing', claimToken: token })
    expect((await attemptOf(id)).leaseExpiresAt).toBeNull()
  })
})

describe('DM-975: card claims renew the same way', () => {
  it('keeps a card claim alive through its messages and lets a silent one expire', async () => {
    const desktop = harness.open('desktop')
    const card = await desktop.createKanbanCard({ title: 'Isolated fix', acceptanceCriteria: ['It is fixed'] })
    await desktop.playKanbanCard({ cardId: card.id })
    const packet = await w.orchestrator.claimKanbanCard({ cardId: card.id })
    const claimToken = packet.claimToken ?? ''
    const worker = harness.open('worker')
    const lease = async () => (await desktop.getKanbanCard({ cardId: card.id })).attempts.at(-1)
    for (let call = 0; call < 5; call += 1) {
      harness.clock.advanceSeconds(3000)
      await worker.addKanbanMessage({ cardId: card.id, body: `Still working (${call})`, claimToken })
      expect(await lease()).toMatchObject({ state: 'claimed' })
    }
    harness.clock.advanceSeconds(3601)
    expect(await lease()).toMatchObject({ state: 'lease_expired' })
  })
})

describe('DM-975: a lease session', () => {
  it('refuses every command but a heartbeat', async () => {
    const open = (leaseOnly: boolean) => openWorkspace({
      repoRoot: harness.root, role: 'reader', label: 'dm CLI', transport: 'cli', homeDir: harness.homeDir,
      clock: harness.clock, git: harness.git, ...TEST_STORAGE, ...(leaseOnly ? { leaseOnly } : {})
    })
    const lease = open(true)
    const ordinary = open(false)
    try {
      await expect(lease.listComments({ epicId: w.epicId })).rejects.toMatchObject({ code: 'unauthorized', details: { command: 'listComments' } })
      await expect(ordinary.listComments({ epicId: w.epicId })).resolves.toEqual([])
    } finally {
      lease.close()
      ordinary.close()
    }
  })
})
