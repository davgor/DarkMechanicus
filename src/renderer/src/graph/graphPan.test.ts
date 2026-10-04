import { describe, expect, it } from 'vitest'
import { isUserPanEvent } from './graphPan'

describe('React Flow move origin', () => {
  it('accepts mouse and touch drag moves only', () => {
    expect(isUserPanEvent({ type: 'mousemove' })).toBe(true)
    expect(isUserPanEvent({ type: 'pointermove' })).toBe(true)
    expect(isUserPanEvent({ type: 'touchmove' })).toBe(true)
    expect(isUserPanEvent({ type: 'wheel' })).toBe(false)
    expect(isUserPanEvent({ type: 'click' })).toBe(false)
    expect(isUserPanEvent(null)).toBe(false)
  })
})
