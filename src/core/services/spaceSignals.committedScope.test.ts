/**
 * DM-174 c2: A's original-scope denominator is frozen by the first dispatch; splitting, renaming, rewording and deleting
 * work afterwards cannot manufacture progress, and newly authorized scope is listed separately.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { graded, type SignalsWorld, signalsWorld } from '../../test/spaceSignalsWorld'

const worlds: SignalsWorld[] = []

async function open(...args: Parameters<typeof signalsWorld>): Promise<SignalsWorld> {
  const w = await signalsWorld(...args)
  worlds.push(w)
  return w
}

afterEach(() => {
  for (const w of worlds.splice(0)) w.close()
})

async function deliver(w: SignalsWorld, refs: string[]): Promise<void> {
  for (const ref of refs) {
    const claimed = await w.claim(ref)
    await w.submit(ref, claimed)
    await w.accept(claimed)
  }
}

/** Alpha rejected once, then after the first dispatch: beta split in two, gamma renamed, delta deleted, alpha's c2 reworded and c3 added. */
async function mixedChanges(): Promise<{ w: SignalsWorld; beforeReplan: string }> {
  const w = await open({
    alpha: { title: 'Alpha', acceptanceCriteria: [{ id: 'c1', text: 'Parses input' }, { id: 'c2', text: 'Writes output' }] },
    beta: { title: 'Beta', acceptanceCriteria: ['Beta works'] },
    gamma: { title: 'Gamma', acceptanceCriteria: ['Gamma works'] },
    delta: { title: 'Delta', acceptanceCriteria: ['Delta works'] },
    extra: { title: 'Optional extra', acceptanceCriteria: ['Nice to have'], optional: true }
  })
  const first = await w.claim('alpha')
  await w.submit('alpha', first)
  await w.reject(first, 'rework the output')
  const beforeReplan = w.harness.clock.nowIso()
  await w.replan([
    {
      op: 'update_ticket',
      ticket: w.ticket.alpha ?? '',
      patch: { acceptanceCriteria: [{ id: 'c1', text: 'Parses input' }, { id: 'c2', text: 'Writes anything at all' }, { id: 'c3', text: 'Logs' }] }
    },
    { op: 'remove_ticket', ticket: w.ticket.beta ?? '' },
    { op: 'add_ticket', ref: 'beta1', sprint: w.sprintId, ticket: { title: 'Beta part 1', acceptanceCriteria: ['Half of beta'] } },
    { op: 'add_ticket', ref: 'beta2', sprint: w.sprintId, ticket: { title: 'Beta part 2', acceptanceCriteria: ['Other half'] } },
    { op: 'update_ticket', ticket: w.ticket.gamma ?? '', patch: { title: 'Gamma (renamed)' } },
    { op: 'remove_ticket', ticket: w.ticket.delta ?? '' }
  ])
  await deliver(w, ['alpha', 'beta1', 'beta2', 'gamma'])
  return { w, beforeReplan }
}

describe('committed scope after split, rename, rewording and deletion (DM-174 c2)', () => {
  it('keeps the sprint’s frozen four work tickets as the denominator; only the renamed gamma counts delivered', async () => {
    const { w } = await mixedChanges()
    const sprint = w.signals({ level: 'sprint', id: w.sprintId })
    expect(sprint.A.committed.map((item) => [item.id, item.delivered])).toEqual([
      [w.ticket.alpha, false],
      [w.ticket.beta, false],
      [w.ticket.gamma, true],
      [w.ticket.delta, false]
    ])
    expect(sprint.A.input).toMatchObject({ committed: 4, delivered: 1, removed: 2, added: 2 })
    expect(graded(sprint, 'A')).toMatchObject({ state: 'observed', score: 25 })
    expect(sprint.A.committed.find((item) => item.id === w.ticket.alpha)?.undelivered).toEqual({
      reason: 'criteria_unverified',
      criteria: [{ criterionId: 'c2', cause: 'changed' }]
    })
  })

  it('keeps the split-off and deleted tickets in the denominator as removed, and lists the split parts as added', async () => {
    const { w } = await mixedChanges()
    const sprint = w.signals({ level: 'sprint', id: w.sprintId })
    expect(sprint.A.removed.map((item) => item.id).sort()).toEqual([w.ticket.beta, w.ticket.delta].sort())
    expect(sprint.A.added.map((item) => [item.id, item.delivered])).toEqual([
      [w.ticket.beta1, true],
      [w.ticket.beta2, true]
    ])
    expect(sprint.A.frozenRevisionId).not.toBe(sprint.A.currentRevisionId)
    expect(sprint.A.frozenAt).toBe('2026-03-01T10:02:00.000Z')
  })

  it('reads the same frozen scope for the run', async () => {
    const { w } = await mixedChanges()
    expect(w.signals({ level: 'run', id: w.runId }).A.input).toMatchObject({ committed: 4, delivered: 1, removed: 2, added: 2 })
  })
})

describe('committed criteria of a ticket after rewording and rename (DM-174 c2)', () => {
  it('counts a reworded criterion as removed plus added at ticket level, so only the unchanged c1 is delivered', async () => {
    const { w } = await mixedChanges()
    const alpha = w.signals({ level: 'ticket', id: w.ticket.alpha ?? '' })
    expect(alpha.A.committed.map((item) => [item.id, item.label, item.delivered])).toEqual([
      [`${w.ticket.alpha}#c1`, 'Parses input', true],
      [`${w.ticket.alpha}#c2`, 'Writes output', false]
    ])
    expect(alpha.A.added.map((item) => item.label)).toEqual(['Writes anything at all', 'Logs'])
    expect(alpha.A.removed.map((item) => item.label)).toEqual(['Writes output'])
    expect(graded(alpha, 'A')).toMatchObject({ state: 'observed', score: 50 })
  })

  it('treats a renamed ticket as the same ticket, frozen with its sprint', async () => {
    const { w } = await mixedChanges()
    const gamma = w.signals({ level: 'ticket', id: w.ticket.gamma ?? '' })
    const sprint = w.signals({ level: 'sprint', id: w.sprintId })
    expect(gamma.A.input).toMatchObject({ committed: 1, delivered: 1, removed: 0, added: 0 })
    expect(gamma.A.frozenRevisionId).toBe(sprint.A.frozenRevisionId)
  })

  it('reads the same frozen four at a cutoff before the replan, with nothing delivered, added or removed', async () => {
    const { w, beforeReplan } = await mixedChanges()
    const early = w.signals({ level: 'sprint', id: w.sprintId, cutoff: beforeReplan })
    expect(early.A.input).toMatchObject({ committed: 4, delivered: 0, added: 0, removed: 0 })
  })

  it('freezes nothing before the first dispatch: committed is null and A is missing', async () => {
    const w = await open({ one: { title: 'One', acceptanceCriteria: ['Works'] } })
    const sprint = w.signals({ level: 'sprint', id: w.sprintId })
    expect(sprint.A.input.committed).toBeNull()
    expect(sprint.A.frozenRevisionId).toBeNull()
    expect(graded(sprint, 'A')).toMatchObject({ state: 'missing', missingReason: 'scope_not_frozen' })
  })
})

describe('trimming a committed ticket (DM-174 c2)', () => {
  it('cannot raise A by moving criteria of a committed ticket to a new one', async () => {
    const w = await open({
      alpha: { title: 'Alpha', acceptanceCriteria: [{ id: 'c1', text: 'Parses' }, { id: 'c2', text: 'Writes' }, { id: 'c3', text: 'Logs' }] },
      beta: { title: 'Beta', acceptanceCriteria: ['Beta works'] }
    })
    await deliver(w, ['beta'])
    await w.replan([
      { op: 'update_ticket', ticket: w.ticket.alpha ?? '', patch: { acceptanceCriteria: [{ id: 'c1', text: 'Parses' }] } },
      { op: 'add_ticket', ref: 'alpha2', sprint: w.sprintId, ticket: { title: 'Alpha part 2', acceptanceCriteria: [{ id: 'c1', text: 'Writes' }, { id: 'c2', text: 'Logs' }] } }
    ])
    await deliver(w, ['alpha', 'alpha2'])

    const sprint = w.signals({ level: 'sprint', id: w.sprintId })
    expect(sprint.A.input).toMatchObject({ committed: 2, delivered: 1, added: 1, removed: 0 })
    expect(sprint.A.added.map((item) => item.id)).toEqual([w.ticket.alpha2])
    expect(graded(sprint, 'A')).toMatchObject({ score: 50 })

    const alpha = w.signals({ level: 'ticket', id: w.ticket.alpha ?? '' })
    expect(alpha.A.input).toMatchObject({ committed: 3, delivered: 1, removed: 2, added: 0 })
    expect(alpha.A.frozenRevisionId).toBe(sprint.A.frozenRevisionId)
  })
})

describe('scope across runs (DM-174 c2)', () => {
  it('keeps carried-forward work delivered by its earlier acceptance and never shrinks the epic denominator', async () => {
    const w = await open({ t1: { title: 'T1' }, t2: { title: 'T2' }, t3: { title: 'T3' }, t4: { title: 'T4' } })
    const { orchestrator, harness, epicId } = w
    const epicA = (): unknown => w.signals({ level: 'epic', id: epicId }).A.input
    await deliver(w, ['t1', 't2'])
    expect(epicA()).toMatchObject({ committed: 4, delivered: 2 })

    await orchestrator.cancelRun({ runId: w.runId, reason: 'restart' })
    harness.clock.advanceSeconds(60)
    const run2 = await orchestrator.startRun({ epicId })
    for (const ref of ['t1', 't2']) {
      harness.clock.advanceSeconds(60)
      await orchestrator.carryForwardTicket({ runId: run2.id, ticketId: w.ticket[ref] ?? '', note: 'accepted in run 1' })
    }
    expect(epicA()).toMatchObject({ committed: 4, delivered: 2 })

    harness.clock.advanceSeconds(60)
    const t3 = await orchestrator.claimTicket({ runId: run2.id, ticketId: w.ticket.t3 ?? '', worker: { label: 'worker-t3' } })
    const claimed = { id: t3.attempt.id, token: t3.packet.claimToken ?? '' }
    await w.submit('t3', claimed)
    await w.accept(claimed)
    expect(epicA()).toMatchObject({ committed: 4, delivered: 3 })

    // Carried forward before run 2's first claim: outside its scope.
    const run2View = w.signals({ level: 'run', id: run2.id })
    expect(run2View.A.input).toMatchObject({ committed: 2, delivered: 1 })
    expect([...run2View.A.carriedForward].sort()).toEqual([w.ticket.t1, w.ticket.t2].sort())

    await orchestrator.cancelRun({ runId: run2.id, reason: 'restart again' })
    harness.clock.advanceSeconds(60)
    const run3 = await orchestrator.startRun({ epicId })
    harness.clock.advanceSeconds(60)
    await orchestrator.claimTicket({ runId: run3.id, ticketId: w.ticket.t4 ?? '', worker: { label: 'worker-t4' } })
    for (const ref of ['t1', 't2', 't3']) {
      harness.clock.advanceSeconds(60)
      await orchestrator.carryForwardTicket({ runId: run3.id, ticketId: w.ticket[ref] ?? '', note: 'accepted earlier' })
    }
    // Carried forward after run 3's first claim: still committed, delivered by the earlier acceptances.
    const run3View = w.signals({ level: 'run', id: run3.id })
    expect(run3View.A.input).toMatchObject({ committed: 4, delivered: 3 })
    expect(run3View.A.carriedForward).toEqual([])
    expect(epicA()).toMatchObject({ committed: 4, delivered: 3 })
  })
})
