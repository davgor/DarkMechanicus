import { describe, expect, it } from 'vitest'
import { CLAIM_TOKEN_MASK } from '../core/claimTokenMask'
import { LIMITS } from '../core/schemas'
import { skillBody } from './skills'
import { transferKickoff, transferTitle } from './transferKickoff'

const EPIC_ID = 'ep_01m6772ffwkwr2a91fsqzfz1he'

/** A claim token as the server issues it: an attempt id and a 32-character secret. */
const CLAIM_TOKEN = 'at_01m44wa86sxhxz3xv76qnvza2e.gUJvQxJEDk0emfDt1HQ9H3tYGOmsf4IX'

describe('transferKickoff', () => {
  it('names the epic id and its title on one line', () => {
    const text = transferKickoff({ epicId: EPIC_ID, epicTitle: 'Linear\nhandoff' })
    expect(text).toContain(`Epic: Linear handoff (${EPIC_ID})`)
    expect(text).toContain(`Call start_transfer for epic ${EPIC_ID}`)
  })

  it('carries the whole guide the darkmechanicus-linear-transfer prompt serves', () => {
    const text = transferKickoff({ epicId: EPIC_ID, epicTitle: 'Linear handoff' })
    expect(text).toContain(skillBody('linear-transfer').trimEnd())
    expect(text.indexOf('Epic: ')).toBeLessThan(text.indexOf('# Linear transfer'))
    expect(text.endsWith('=== End of guidance ===')).toBe(true)
  })

  it('masks a claim token carried in the title', () => {
    const text = transferKickoff({ epicId: EPIC_ID, epicTitle: `Leak ${CLAIM_TOKEN}` })
    expect(text).not.toContain(CLAIM_TOKEN)
    expect(text).toContain(CLAIM_TOKEN_MASK)
  })
})

describe('transferTitle', () => {
  it('prefixes the epic title, masked', () => {
    expect(transferTitle('Linear handoff')).toBe('Linear transfer · Linear handoff')
    expect(transferTitle(`Leak ${CLAIM_TOKEN}`)).not.toContain(CLAIM_TOKEN)
  })

  it('is cut to the title limit', () => {
    const title = transferTitle('x'.repeat(LIMITS.title * 2))
    expect(title).toHaveLength(LIMITS.title)
    expect(title.startsWith('Linear transfer · ')).toBe(true)
  })
})
