import { describe, expect, it } from 'vitest'
import { TIER_VERDICTS, type SprintRetro, type SprintRetroInput, type TierVerdict } from '../../shared/domain/retro'
import { makeBundle, tid } from '../../test/bundles'
import { errorOf } from '../../test/checkpointSeed'
import { normalizeRetro, retroIsEmpty, retroSearchParts } from './retro'

const BUNDLE = makeBundle([[1, 2, 3]])

const EMPTY: SprintRetro = { delivered: [], wentWell: [], wentPoorly: [], actions: [], discoveries: [], leftovers: [], tierFit: [] }

const FULL: SprintRetro = {
  delivered: [{ ticket: tid(1), demo: 'Open the board', evidence: 'shots/board.png' }],
  wentWell: ['Pairing on the schema'],
  wentPoorly: ['Flaky pipeline'],
  actions: ['Pin the runner image'],
  discoveries: [{ title: 'Cache the catalog', body: 'Every claim reloads it', ticket: tid(2) }],
  leftovers: [{ ticket: tid(3), reason: 'Blocked on a certificate' }],
  tierFit: [{ ticket: tid(1), verdict: 'oversized', note: 'A small model would have done' }]
}

describe('normalizeRetro', () => {
  it('fills every list of an empty retro with nothing', () => {
    expect(normalizeRetro({}, BUNDLE)).toEqual(EMPTY)
  })

  it('resolves a ticket given by key or by id to the stable id', () => {
    const input: SprintRetroInput = {
      delivered: [{ ticket: 'DM-1', demo: 'd', evidence: 'e' }],
      discoveries: [{ title: 't', body: 'b', ticket: tid(2) }, { title: 'u', body: 'c' }, { title: 'v', body: 'd', ticket: null }],
      leftovers: [{ ticket: 'DM-3', reason: 'r' }],
      tierFit: [{ ticket: tid(1), verdict: 'right_sized', note: 'n' }]
    }
    const retro = normalizeRetro(input, BUNDLE)
    expect(retro.delivered).toEqual([{ ticket: tid(1), demo: 'd', evidence: 'e' }])
    expect(retro.discoveries.map((item) => item.ticket)).toEqual([tid(2), null, null])
    expect(retro.leftovers).toEqual([{ ticket: tid(3), reason: 'r' }])
    expect(retro.tierFit).toEqual([{ ticket: tid(1), verdict: 'right_sized', note: 'n' }])
  })

  it.each(TIER_VERDICTS)('keeps the %s tier-fit verdict', (verdict: TierVerdict) => {
    expect(normalizeRetro({ tierFit: [{ ticket: 'DM-1', verdict }] }, BUNDLE).tierFit).toEqual([{ ticket: tid(1), verdict, note: '' }])
  })

  it('keeps the written lists as they are', () => {
    const retro = normalizeRetro(
      { wentWell: FULL.wentWell, wentPoorly: FULL.wentPoorly, actions: FULL.actions },
      BUNDLE
    )
    expect([retro.wentWell, retro.wentPoorly, retro.actions]).toEqual([FULL.wentWell, FULL.wentPoorly, FULL.actions])
  })

  it.each([
    ['delivered', { delivered: [{ ticket: 'DM-1', demo: '', evidence: '' }, { ticket: 'DM-99', demo: '', evidence: '' }] }, 'retro.delivered[1].ticket'],
    ['discoveries', { discoveries: [{ title: 't', body: '', ticket: 'DM-99' }] }, 'retro.discoveries[0].ticket'],
    ['leftovers', { leftovers: [{ ticket: tid(99), reason: '' }] }, 'retro.leftovers[0].ticket'],
    ['tierFit', { tierFit: [{ ticket: 'dm-1', verdict: 'oversized', note: '' }] }, 'retro.tierFit[0].ticket']
  ] as [string, SprintRetroInput, string][])('refuses an unknown ticket in %s and names where', (_field, input, path) => {
    const error = errorOf(() => normalizeRetro(input, BUNDLE))
    expect(error.code).toBe('invalid_input')
    expect(error.message).toContain(path)
    expect(error.details).toMatchObject({ path })
  })

  it('matches a ticket key exactly, so a different case is unknown', () => {
    expect(errorOf(() => normalizeRetro({ leftovers: [{ ticket: 'dm-1', reason: '' }] }, BUNDLE)).code).toBe('invalid_input')
  })
})

describe('retroIsEmpty', () => {
  it('is true for a retro with nothing in it', () => {
    expect(retroIsEmpty(EMPTY)).toBe(true)
  })

  it.each(Object.keys(FULL) as (keyof SprintRetro)[])('is false when only %s has an entry', (field) => {
    expect(retroIsEmpty({ ...EMPTY, [field]: FULL[field] })).toBe(false)
  })
})

describe('retroSearchParts', () => {
  const keyOf = (ticketId: string): string => `KEY-${ticketId.slice(-2)}`

  it('is nothing for an empty retro', () => {
    expect(retroSearchParts(EMPTY, keyOf)).toEqual([])
  })

  it('lists the text of every section in order, with ticket keys instead of ids', () => {
    expect(retroSearchParts(FULL, keyOf)).toEqual([
      `KEY-${tid(1).slice(-2)}`,
      'Open the board',
      'shots/board.png',
      'Pairing on the schema',
      'Flaky pipeline',
      'Pin the runner image',
      'Cache the catalog',
      'Every claim reloads it',
      `KEY-${tid(2).slice(-2)}`,
      `KEY-${tid(3).slice(-2)}`,
      'Blocked on a certificate',
      `KEY-${tid(1).slice(-2)}`,
      'oversized',
      'A small model would have done'
    ])
  })

  it('leaves out the empty parts', () => {
    const retro: SprintRetro = { ...EMPTY, discoveries: [{ title: 'Only a title', body: '', ticket: null }] }
    expect(retroSearchParts(retro, keyOf)).toEqual(['Only a title'])
  })
})
