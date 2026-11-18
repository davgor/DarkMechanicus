// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { settle } from '../__mocks__/settle'
import type { GradingPolicyView } from '../../../shared/domain/scoreReads'
import { GradingPolicyDetails } from './GradingPolicy'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

const POLICY = {
  policy: { policyId: 'balanced', version: 1, hash: 'sha256:abcdef0123456789' },
  components: [{ component: 'S', weight: 1, baseShare: 1 / 7, required: false, signal: 'human', rule: 'rating', formula: '(r - 1) / 4 × 100', whenMissing: 'Dropped from the composite.' }],
  composite: 'the weighted mean of the scored components',
  bands: [
    { letter: 'A', min: 90 },
    { letter: 'B', min: 75 },
    { letter: 'F', min: 0 }
  ],
  minScoredComponents: 3,
  mandatoryFailureCeiling: 59,
  precision: 'kept to one decimal'
} as unknown as GradingPolicyView

function open(container: HTMLElement): void {
  const details = container.querySelector('details') as HTMLDetailsElement
  details.open = true
  fireEvent(details, new Event('toggle'))
}

describe('DM-183 policy: the default balanced policy is shown read-only, read once opened', () => {
  it('reads nothing while folded, then shows the policy with its bands', async () => {
    dm.responses.getGradingPolicy = POLICY
    const view = render(<GradingPolicyDetails folderPath="/repo" />)
    await settle()
    expect(dm.callsOf('getGradingPolicy')).toHaveLength(0)
    open(view.container)
    await settle()
    const list = screen.getByRole('list', { name: 'How the grade is calculated' })
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Composite: the weighted mean of the scored components.',
      'Letters: A ≥ 90, B ≥ 75, F below 75.',
      'Fewer than 3 scored components: ungraded, never a letter.',
      'Scores are kept to one decimal.'
    ])
    expect(screen.getByRole('cell', { name: 'rating: (r - 1) / 4 × 100' })).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(dm.callsOf('getGradingPolicy')).toHaveLength(1)
  })

  it('a failed read is said and can be tried again', async () => {
    dm.failures.getGradingPolicy = { code: 'busy', message: 'Store busy.' }
    const view = render(<GradingPolicyDetails folderPath="/repo" />)
    open(view.container)
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('Could not read the policy: Store busy.')
    delete dm.failures.getGradingPolicy
    dm.responses.getGradingPolicy = POLICY
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(dm.callsOf('getGradingPolicy')).toHaveLength(2)
  })
})
