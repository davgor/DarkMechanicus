import { describe, expect, it } from 'vitest'
import { domainErrorOf } from '../../test/repoFixtures'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { type Capability, capabilitiesForRole, HUMAN_ONLY_CAPABILITIES } from '../authz'
import {
  DEFAULT_GRANT_MINUTES,
  GRANTABLE_ROLES,
  grantedCapabilities,
  hashToken,
  issueGrant,
  listGrants,
  redeemGrant,
  revokeGrant,
  withoutHumanOnly
} from './grants'

function desktop(): TestCtx {
  return createTestCtx({ role: 'desktop' })
}

function agent(role: 'orchestrator' | 'worker' = 'orchestrator'): TestCtx {
  return createTestCtx({ role })
}

function redeemDeps(ctx: TestCtx, machineId = ctx.machineId): Parameters<typeof redeemGrant>[0] {
  return { db: ctx.db, clock: ctx.clock, machineId }
}

describe('issuing a grant', () => {
  it('returns a token once and stores only its hash', () => {
    const ctx = desktop()
    const { grant, token } = issueGrant(ctx, { role: 'orchestrator', label: 'CLI' })
    expect(token).toMatch(/^dmg_[0-9a-f]{64}$/)
    const stored = ctx.db.get<{ token_hash: string }>('SELECT token_hash FROM grants WHERE id = ?', grant.id)
    expect(stored?.token_hash).toBe(hashToken(token))
    // Nothing that could be replayed is kept.
    expect(stored?.token_hash).not.toContain(token)
    expect(ctx.db.get('SELECT * FROM grants WHERE token_hash = ?', token)).toBeUndefined()
  })

  it('describes the grant it made', () => {
    const ctx = desktop()
    const { grant } = issueGrant(ctx, { role: 'planner', label: 'Planning session', minutes: 30 })
    expect(grant).toMatchObject({ role: 'planner', label: 'Planning session', active: true, revokedAt: null })
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.createdAt)).toBe(30 * 60_000)
  })

  it('defaults the lifetime rather than lasting forever', () => {
    const { grant } = issueGrant(desktop(), { role: 'reader', label: 'Reader' })
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.createdAt)).toBe(DEFAULT_GRANT_MINUTES * 60_000)
  })

  it('gives every token a different secret', () => {
    const ctx = desktop()
    const first = issueGrant(ctx, { role: 'reader', label: 'a' }).token
    const second = issueGrant(ctx, { role: 'reader', label: 'b' }).token
    expect(first).not.toBe(second)
  })
})

describe('who may issue a grant', () => {
  it.each(['orchestrator', 'worker'] as const)('refuses a %s session', (role) => {
    const error = domainErrorOf(() => issueGrant(agent(role), { role: 'orchestrator', label: 'self' }))
    expect(error.code).toBe('unauthorized')
  })

  it('refuses to grant the desktop seat itself', () => {
    // The type forbids it; this covers a caller that reached the service without passing one,
    // for example a hand-written JSON payload that slipped past a schema.
    const asUnchecked = issueGrant as (ctx: TestCtx, input: { role: string; label: string }) => unknown
    const error = domainErrorOf(() => asUnchecked(desktop(), { role: 'desktop', label: 'nope' }))
    expect(error.code).toBe('invalid_input')
    expect(GRANTABLE_ROLES).not.toContain('desktop' as never)
  })

  it('refuses an agent session that tries to revoke', () => {
    const ctx = desktop()
    const { grant } = issueGrant(ctx, { role: 'reader', label: 'r' })
    expect(domainErrorOf(() => revokeGrant(agent(), grant.id)).code).toBe('unauthorized')
  })
})

describe('redeeming a grant', () => {
  it('gives the session the granted role and its capabilities', () => {
    const ctx = desktop()
    const { token } = issueGrant(ctx, { role: 'orchestrator', label: 'CLI' })
    const redeemed = redeemGrant(redeemDeps(ctx), token)
    expect(redeemed.role).toBe('orchestrator')
    expect(redeemed.capabilities).toEqual(grantedCapabilities('orchestrator', false))
  })

  it('records when it was last used, so a person can see it working', () => {
    const ctx = desktop()
    const { grant, token } = issueGrant(ctx, { role: 'reader', label: 'r' })
    expect(listGrants(ctx).find((item) => item.id === grant.id)?.lastUsedAt).toBeNull()
    redeemGrant(redeemDeps(ctx), token)
    expect(listGrants(ctx).find((item) => item.id === grant.id)?.lastUsedAt).not.toBeNull()
  })

  it.each([
    ['an unknown token', (ctx: TestCtx, _token: string) => redeemGrant(redeemDeps(ctx), 'dmg_deadbeef')],
    [
      'a revoked grant',
      (ctx: TestCtx, token: string) => {
        const id = listGrants(ctx)[0]?.id ?? ''
        revokeGrant(ctx, id)
        return redeemGrant(redeemDeps(ctx), token)
      }
    ],
    [
      'an expired grant',
      (ctx: TestCtx, token: string) => {
        ctx.clock.advanceSeconds((DEFAULT_GRANT_MINUTES + 1) * 60)
        return redeemGrant(redeemDeps(ctx), token)
      }
    ],
    ['a grant issued on another machine', (ctx: TestCtx, token: string) => redeemGrant(redeemDeps(ctx, 'mc_other'), token)]
  ])('refuses %s', (_label, redeem) => {
    const ctx = desktop()
    const { token } = issueGrant(ctx, { role: 'orchestrator', label: 'CLI' })
    expect(domainErrorOf(() => redeem(ctx, token)).code).toBe('unauthorized')
  })

  it('says the same thing however it failed, so probing learns nothing', () => {
    const ctx = desktop()
    const { token } = issueGrant(ctx, { role: 'orchestrator', label: 'CLI' })
    const unknown = domainErrorOf(() => redeemGrant(redeemDeps(ctx), 'dmg_nope')).message
    ctx.clock.advanceSeconds((DEFAULT_GRANT_MINUTES + 1) * 60)
    expect(domainErrorOf(() => redeemGrant(redeemDeps(ctx), token)).message).toBe(unknown)
  })
})

describe('stripping the capabilities reserved to a person', () => {
  /**
   * Exercised with a set that actually contains human-only capabilities. Asserting it only
   * through `grantedCapabilities` proves nothing: no grantable role's base set has one today, so
   * the filter would pass those tests even if it were deleted.
   */
  it.each(HUMAN_ONLY_CAPABILITIES)('removes %s', (capability) => {
    expect(withoutHumanOnly(['read', capability, 'comment.write'])).toEqual(['read', 'comment.write'])
  })

  it('removes every one of them at once and keeps the rest in order', () => {
    const mixed: Capability[] = ['read', ...HUMAN_ONLY_CAPABILITIES, 'comment.write', 'draft.edit']
    expect(withoutHumanOnly(mixed)).toEqual(['read', 'comment.write', 'draft.edit'])
  })

  it('leaves a set that holds none of them untouched', () => {
    const plain: Capability[] = ['read', 'attempt.submit', 'comment.write']
    expect(withoutHumanOnly(plain)).toEqual(plain)
  })

  it('is what a grant is built through, so a role that gained one would still not confer it', () => {
    // Stands in for a future edit to ROLE_CAPABILITIES that hands an agent role a human-only one.
    const widened: Capability[] = [...capabilitiesForRole('orchestrator'), 'checkpoint.approve']
    expect(withoutHumanOnly(widened)).not.toContain('checkpoint.approve')
  })
})

describe('what a grant can never confer', () => {
  it.each(GRANTABLE_ROLES)('gives a %s grant no human-only capability', (role) => {
    for (const allowSave of [false, true]) {
      const granted = grantedCapabilities(role, allowSave)
      expect(granted.filter((capability) => HUMAN_ONLY_CAPABILITIES.includes(capability))).toEqual([])
    }
  })

  it('never lets a grant issue or revoke another grant', () => {
    for (const role of GRANTABLE_ROLES) {
      const granted = grantedCapabilities(role, true)
      expect(granted).not.toContain('grant.issue')
      expect(granted).not.toContain('grant.revoke')
    }
  })

  it('withholds plan.save unless the grant says so, and only for roles that may author', () => {
    expect(grantedCapabilities('orchestrator', false)).not.toContain('plan.save')
    expect(grantedCapabilities('orchestrator', true)).toContain('plan.save')
    expect(grantedCapabilities('worker', true)).not.toContain('plan.save')
  })

  it('ignores allowSave on a grant for a role that cannot author', () => {
    const ctx = desktop()
    const { token } = issueGrant(ctx, { role: 'worker', label: 'w', allowSave: true })
    expect(redeemGrant(redeemDeps(ctx), token).capabilities).toEqual(capabilitiesForRole('worker'))
  })
})

describe('how long a grant may last', () => {
  it.each([0, -1, 1, 4, 10081, 1e12, Number.MAX_SAFE_INTEGER, Number.NaN, 1.5])(
    'refuses %p minutes rather than clamping it',
    (minutes) => {
      const error = domainErrorOf(() => issueGrant(desktop(), { role: 'reader', label: 'r', minutes }))
      expect(error.code).toBe('invalid_input')
    }
  )

  it.each([5, 60, 7 * 24 * 60])('accepts %p minutes', (minutes) => {
    expect(issueGrant(desktop(), { role: 'reader', label: 'r', minutes }).grant.expiresAt).toBeDefined()
  })
})

describe('listing grants', () => {
  it('shows active, revoked and expired ones for what they are', () => {
    const ctx = desktop()
    const live = issueGrant(ctx, { role: 'reader', label: 'live' }).grant
    const revoked = issueGrant(ctx, { role: 'reader', label: 'revoked' }).grant
    revokeGrant(ctx, revoked.id)
    const shortLived = issueGrant(ctx, { role: 'reader', label: 'expired', minutes: 5 }).grant
    ctx.clock.advanceSeconds(6 * 60)
    const byId = new Map(listGrants(ctx).map((grant) => [grant.id, grant]))
    expect(byId.get(live.id)?.active).toBe(true)
    expect(byId.get(revoked.id)?.active).toBe(false)
    expect(byId.get(shortLived.id)?.active).toBe(false)
  })

  it('revoking twice is not an error', () => {
    const ctx = desktop()
    const { grant } = issueGrant(ctx, { role: 'reader', label: 'r' })
    const first = revokeGrant(ctx, grant.id)
    expect(revokeGrant(ctx, grant.id).revokedAt).toBe(first.revokedAt)
  })

  it('reports an unknown grant as not found', () => {
    expect(domainErrorOf(() => revokeGrant(desktop(), 'gr_00000000000000000000000001')).code).toBe('not_found')
  })
})
