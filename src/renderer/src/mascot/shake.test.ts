import { describe, expect, it } from 'vitest'
import { createShakeState, resetShake, stepShake } from './shake'

const view = (x: number, y = 0, zoom = 1) => ({ x, y, zoom })
const feed = (state: ReturnType<typeof createShakeState>, moves: readonly (readonly [number, number])[]) =>
  moves.reduce((current, [x, time]) => stepShake(current, view(x), time, true), state)
describe('graph shake detector', () => {
  it('detects equivalent dense and sparse horizontal trajectories', () => {
    const dense = [0, 8, 16, 24, 32, 40, 48, 40, 32, 24, 16, 8, 0, -8, -16, -24, -32, -40, -48, -40, -32, -24, -16, -8, 0, 8, 16, 24, 32, 40, 48]
    const denseStates = dense.map((x, index) => [x, index * 16] as const)
    let state = createShakeState()
    const pulses = denseStates.map(([x, time]) => {
      state = stepShake(state, view(x), time, true)
      return state.detected
    })
    expect(pulses.filter(Boolean)).toHaveLength(1)
    expect(feed(createShakeState(), [[0, 0], [48, 96], [-48, 288], [48, 480]]).detected).toBe(true)
  })

  it('tolerates turnaround jitter and retains reversals across continuing movement', () => {
    const positions = [0, 30, 48, 45, 47, 40, 20, 0, -24, -48, -44, -46, -20, 0, 24]
    let state = createShakeState()
    const pulses = positions.map((x, i) => {
      state = stepShake(state, view(x), i * 30, true)
      return state.detected
    })
    expect(pulses.filter(Boolean)).toHaveLength(1)
  })

  it('detects vertical shakes without treating orthogonal travel as a reversal', () => {
    let state = createShakeState()
    for (const [y, time] of [[0, 0], [32, 50], [-32, 100], [32, 150]]) state = stepShake(state, view(0, y), time, true)
    expect(state.detected).toBe(true)
    state = createShakeState()
    for (const [x, y, time] of [[0, 0, 0], [48, 0, 50], [48, 100, 100], [48, -100, 150], [70, 0, 200]]) {
      state = stepShake(state, view(x, y), time, true)
    }
    expect(state.detected).toBe(false)
  })
})

describe('graph shake validity and cooldown', () => {
  it('clears a pulse on invalid time without replaying it', () => {
    const pulse = feed(createShakeState(), [[0, 0], [30, 50], [-30, 100], [30, 150]])
    expect(pulse.detected).toBe(true)
    expect(stepShake(pulse, view(0), Number.NaN, true).detected).toBe(false)
    expect(stepShake(pulse, view(0), 100, true).detected).toBe(false)
  })

  it('allows another shake after cooldown and reset while discarding slow and fit moves', () => {
    const gesture = [[0, 0], [40, 50], [-40, 100], [40, 150]] as const
    let state = feed(createShakeState(), gesture)
    expect(state.detected).toBe(true)
    for (const [x, time] of [[-40, 200], [40, 300], [-40, 400]]) state = stepShake(state, view(x), time, true)
    expect(state.detected).toBe(false)
    state = feed(state, [[0, 1350], [40, 1400], [-40, 1450], [40, 1500]])
    expect(state.detected).toBe(true)
    state = resetShake(state)
    state = feed(state, [[0, 2000], [40, 2300], [-40, 2700], [40, 3100]])
    expect(state.detected).toBe(false)
    state = stepShake(state, null, 3200, true)
    state = feed(state, [[0, 3250], [40, 3300], [-40, 3350], [40, 3400]])
    expect(state.detected).toBe(true)
  })
})

describe('graph shake input filtering', () => {
  it('detects rapid meaningful translations once there are two reversals', () => {
    let state = createShakeState()
    state = feed(state, [[0, 0], [30, 80], [-30, 160], [30, 240]])
    expect(state.detected).toBe(true)
  })

  it('ignores low jitter, slow pan, and a single fast drag', () => {
    let state = createShakeState()
    state = feed(state, [[0, 0], [2, 40], [-2, 80], [2, 120], [50, 1200], [100, 2400]])
    expect(state.detected).toBe(false)
    state = createShakeState()
    state = stepShake(state, view(0), 0, true)
    state = stepShake(state, view(40), 70, true)
    expect(state.detected).toBe(false)
  })

  it('ignores programmatic, null-origin, and zooming moves', () => {
    let state = createShakeState()
    state = feed(state, [[0, 0], [40, 60], [-40, 120], [40, 180]])
    state = stepShake(state, view(-40), 240, false)
    expect(state.detected).toBe(false)
    state = stepShake(state, view(40), 300, true)
    state = stepShake(state, view(-40, 0, 1.2), 360, true)
    state = stepShake(state, view(40), 420, true)
    expect(state.detected).toBe(false)
  })

  it('handles cooldown, explicit reset, and invalid or out-of-order times', () => {
    let state = createShakeState()
    state = feed(state, [[0, 100], [40, 160], [-40, 220], [40, 280]])
    expect(stepShake(state, view(-40), 340, true).detected).toBe(false)
    state = resetShake(state)
    state = stepShake(state, view(0), 400, true)
    const beforeInvalid = state
    state = stepShake(state, view(40), Number.NaN, true)
    expect(state).toEqual({ ...beforeInvalid, detected: false })
    state = stepShake(state, view(40), 460, true)
    expect(stepShake(state, view(-40), 450, true)).toEqual(state)
    state = stepShake(state, view(-40), 520, true)
    state = stepShake(state, view(40), 580, true)
    expect(state.detected).toBe(true)
    expect(stepShake(state, view(0), 570, true)).toEqual({ ...state, detected: false })
  })
})
