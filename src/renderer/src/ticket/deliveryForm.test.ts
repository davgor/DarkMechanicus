import { describe, expect, it } from 'vitest'
import { deliveryForm, formToDelivery, withRelease } from './deliveryForm'

describe('DM-840 c2: sprint delivery form', () => {
  it('round-trips a declared delivery', () => {
    const delivery = { target: 'release/2', release: true, verifyInstalled: true }
    expect(deliveryForm({ delivery })).toEqual({ deliver: true, target: 'release/2', release: true, verifyInstalled: true })
    expect(formToDelivery(deliveryForm({ delivery }))).toEqual(delivery)
  })

  it('starts a sprint without a delivery unchecked on main, and an unchecked form clears it', () => {
    const form = deliveryForm({})
    expect(form).toEqual({ deliver: false, target: 'main', release: false, verifyInstalled: false })
    expect(formToDelivery(form)).toBe(null)
    expect(formToDelivery({ ...form, target: 'a..b' })).toBe(null)
  })

  it('turns verifying the installed app off with the release', () => {
    const form = { deliver: true, target: 'main', release: true, verifyInstalled: true }
    expect(withRelease(form, false)).toEqual({ ...form, release: false, verifyInstalled: false })
    expect(withRelease(withRelease(form, false), true).verifyInstalled).toBe(false)
    expect(formToDelivery({ ...form, release: false })).toEqual({ target: 'main', release: false, verifyInstalled: false })
    expect(deliveryForm({ delivery: { target: 'main', release: false, verifyInstalled: true } }).verifyInstalled).toBe(false)
  })

  it('refuses an invalid target branch', () => {
    const form = { deliver: true, target: 'a..b', release: false, verifyInstalled: false }
    expect(formToDelivery(form)).toEqual({ error: '“a..b” is not a valid branch name.' })
    expect(formToDelivery({ ...form, target: '  ' })).toEqual({ error: 'Enter a target branch.' })
    expect(formToDelivery({ ...form, target: ' main ' })).toEqual({ target: 'main', release: false, verifyInstalled: false })
  })
})
