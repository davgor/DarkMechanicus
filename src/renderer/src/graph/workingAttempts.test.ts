import { describe, expect, it } from 'vitest'
import { attempt, runView } from '../epic/__mocks__/fixtures'
import { workingAttempts } from './workingAttempts'

describe('workingAttempts', () => {
  it('names the open attempt of each ticket whose latest attempt is claimed or running', () => {
    const run = runView({
      attempts: [attempt('DM-201', 1, 'claimed'), attempt('DM-202', 1, 'failed'), attempt('DM-202', 2, 'running'), attempt('DM-204', 1, 'submitted')]
    })
    expect([...workingAttempts(run)]).toEqual([
      ['tk_201', 'at_201_1'],
      ['tk_202', 'at_202_2']
    ])
  })

  it('leaves out tickets whose latest attempt is closed, in review or superseded', () => {
    const run = runView({
      attempts: [
        attempt('DM-201', 1, 'running'),
        attempt('DM-201', 2, 'accepted'),
        attempt('DM-202', 1, 'lease_expired'),
        attempt('DM-203', 1, 'running', { superseded: true }),
        attempt('DM-204', 1, 'submitted')
      ]
    })
    expect(workingAttempts(run).size).toBe(0)
  })

  it('is empty without a run', () => {
    expect(workingAttempts(null).size).toBe(0)
  })
})
