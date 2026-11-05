/**
 * The computer kept awake while chat terminals run: one `prevent-app-suspension` block for every hold there is,
 * taken at the first hold and given back at the last release.
 */
import { describe, expect, it } from 'vitest'
import { createKeepAwake, type PowerBlocker } from './keepAwake'

/** Electron's `powerSaveBlocker`, writing down every start and stop. */
function recordingBlocker(): PowerBlocker & { calls: string[] } {
  let next = 0
  const calls: string[] = []
  return {
    calls,
    start: (type) => {
      next += 1
      calls.push(`start ${type} -> ${next}`)
      return next
    },
    stop: (id) => {
      calls.push(`stop ${id}`)
      return true
    }
  }
}

describe('keep awake', () => {
  it('starts one block for the first hold and none for the holds after it', () => {
    const blocker = recordingBlocker()
    const awake = createKeepAwake(blocker)

    awake.hold()
    awake.hold()

    expect(blocker.calls).toEqual(['start prevent-app-suspension -> 1'])
  })

  it('stops the block only once the last hold is released', () => {
    const blocker = recordingBlocker()
    const awake = createKeepAwake(blocker)
    const first = awake.hold()
    const second = awake.hold()

    first()
    expect(blocker.calls).toEqual(['start prevent-app-suspension -> 1'])
    second()

    expect(blocker.calls).toEqual(['start prevent-app-suspension -> 1', 'stop 1'])
  })

  it('counts a release made twice once, so another hold still keeps the computer awake', () => {
    const blocker = recordingBlocker()
    const awake = createKeepAwake(blocker)
    const first = awake.hold()
    awake.hold()

    first()
    first()

    expect(blocker.calls).toEqual(['start prevent-app-suspension -> 1'])
  })

  it('starts a new block for a hold after every hold was released', () => {
    const blocker = recordingBlocker()
    const awake = createKeepAwake(blocker)
    awake.hold()()

    awake.hold()

    expect(blocker.calls).toEqual(['start prevent-app-suspension -> 1', 'stop 1', 'start prevent-app-suspension -> 2'])
  })
})
