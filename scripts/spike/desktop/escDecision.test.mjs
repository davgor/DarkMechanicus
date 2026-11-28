import { describe, expect, it } from 'vitest'
import { VK_ESCAPE, shouldKill } from './escDecision.mjs'

describe('shouldKill', () => {
  it('kills on a physical Escape key-down', () => {
    expect(shouldKill({ key: 'Escape', injected: false })).toBe(true)
    expect(shouldKill({ vk: VK_ESCAPE, injected: false, down: true })).toBe(true)
  })

  it('lets an injected Escape through to the app', () => {
    expect(shouldKill({ key: 'Escape', injected: true })).toBe(false)
    expect(shouldKill({ vk: VK_ESCAPE, injected: true, down: true })).toBe(false)
  })

  it('never kills on an Escape key-up', () => {
    expect(shouldKill({ key: 'Escape', injected: false, down: false })).toBe(false)
  })

  it('never kills on another physical key', () => {
    expect(shouldKill({ key: 'Enter', injected: false })).toBe(false)
    expect(shouldKill({ vk: 0x41, injected: false })).toBe(false)
  })

  it('treats an event of unknown provenance as injected', () => {
    expect(shouldKill({ key: 'Escape' })).toBe(false)
    expect(shouldKill({ vk: VK_ESCAPE, injected: undefined })).toBe(false)
  })
})
