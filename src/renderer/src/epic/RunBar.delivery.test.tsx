// @vitest-environment jsdom
/** The run bar's Sprint delivery line: an earlier sprint's held delivery, its named checks and the person's Waive…. */
import { cleanup, fireEvent, screen, waitFor, within, type BoundFunctions, type queries } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { SprintDelivery } from '../../../shared/domain/bundle'
import type { CheckResult, DeliveryCheckView } from '../../../shared/domain/views'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import { bundle, iso, runView, savedPlan, sprint } from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const MAIN: SprintDelivery = { target: 'main', release: true, verifyInstalled: true }
const STALE = 'Installed 1.1.0 is older than release 1.2.0 (readInstalledApp)'

function check(number: number, checks: CheckResult[]): DeliveryCheckView {
  return {
    id: `dc_${number}`,
    runId: 'rn_2',
    sprintId: 'sp_1',
    number,
    kind: 'check',
    commit: 'abc1234',
    releaseTag: 'v1.2.0',
    releaseVersion: '1.2.0',
    installedVersion: '1.1.0',
    checks,
    reasons: checks.filter((item) => item.status === 'failed').map((item) => item.detail),
    reason: null,
    passed: checks.length > 0 && checks.every((item) => item.status === 'passed'),
    recordedBy: 'ss_orch',
    createdAt: iso(-number * 60_000)
  }
}

/** Sprint 1 declares a delivery to main; the run is in Sprint 2 with these delivery records. */
function backendWith(deliveries: DeliveryCheckView[]): FakeBackend {
  const plan = bundle({
    sprints: [
      sprint(1, 'Storage foundation', ['tk_101', 'tk_102', 'tk_103'], { delivery: MAIN }),
      sprint(2, 'Authoring through MCP', ['tk_201', 'tk_202', 'tk_203', 'tk_204']),
      sprint(3, 'Desktop editing', ['tk_301', 'tk_302', 'tk_304'])
    ]
  })
  return new FakeBackend(scenario({ saved: savedPlan({ bundle: plan }), run: runView({ deliveries }) }))
}

async function deliveryLine(): Promise<BoundFunctions<typeof queries>> {
  const bar = within(await screen.findByLabelText('Run'))
  return within(await bar.findByRole('group', { name: 'Sprint delivery' }))
}

const FAILED = [
  check(1, [{ name: 'target', status: 'passed', detail: 'abc1234 is on main' }]),
  check(2, [
    { name: 'target', status: 'passed', detail: 'abc1234 is on main' },
    { name: 'release', status: 'passed', detail: 'v1.2.0 contains abc1234' },
    { name: 'installed', status: 'failed', detail: STALE }
  ])
]

describe('Run bar: Sprint delivery line', () => {
  it('says the Magos has not recorded the delivery yet', async () => {
    renderWorkspace(backendWith([]))
    const line = await deliveryLine()
    expect(line.getByText('Sprint 1 delivery to main: waiting for the Magos to record it')).toBeTruthy()
    expect(line.queryByRole('list', { name: 'Delivery checks' })).toBeNull()
  })

  it('shows each check of the latest failed check with its icon, even after an earlier pass', async () => {
    renderWorkspace(backendWith(FAILED))
    const line = await deliveryLine()
    expect(line.getByText('Sprint 1 delivery to main: the latest check failed')).toBeTruthy()
    const items = within(line.getByRole('list', { name: 'Delivery checks' })).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      '✓targetabc1234 is on main',
      '✓releasev1.2.0 contains abc1234',
      `✗installed${STALE}`
    ])
    expect(within(items[2] as HTMLElement).getByRole('img', { name: 'failed' }).textContent).toBe('✗')
    expect(within(items[0] as HTMLElement).getByRole('img', { name: 'passed' }).textContent).toBe('✓')
  })

  it('is hidden once the latest check passed, and without a declared delivery', async () => {
    renderWorkspace(backendWith([...FAILED, check(3, [{ name: 'target', status: 'passed', detail: 'ok' }])]))
    const bar = within(await screen.findByLabelText('Run'))
    expect(bar.queryByRole('group', { name: 'Sprint delivery' })).toBeNull()
    cleanup()
    renderWorkspace(new FakeBackend())
    expect(within(await screen.findByLabelText('Run')).queryByRole('group', { name: 'Sprint delivery' })).toBeNull()
  })
})

describe('Run bar: Waive… a sprint delivery', () => {
  it('Waive needs a reason, then records the waiver with it and the line goes away', async () => {
    const h = renderWorkspace(backendWith(FAILED))
    const line = await deliveryLine()
    fireEvent.click(line.getByRole('button', { name: 'Waive…' }))
    const submit = line.getByRole('button', { name: 'Waive delivery' }) as HTMLButtonElement
    const reason = line.getByRole('textbox', { name: 'Why waive the delivery check' })
    expect(submit.disabled).toBe(true)
    fireEvent.change(reason, { target: { value: '   ' } })
    expect(submit.disabled).toBe(true)
    fireEvent.submit(reason.closest('form') as HTMLFormElement)
    expect(h.backend.inputs('waiveDelivery')).toEqual([])

    fireEvent.change(reason, { target: { value: '  Installed by hand from the release page  ' } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)

    await waitFor(() => expect(screen.queryByRole('group', { name: 'Sprint delivery' })).toBeNull())
    expect(h.backend.inputs('waiveDelivery')).toEqual([{ runId: 'rn_2', sprintId: 'sp_1', reason: 'Installed by hand from the release page' }])
  })

  it('keeps the reason and shows the refusal when the waiver is refused', async () => {
    const h = renderWorkspace(backendWith([]))
    h.backend.fail('waiveDelivery', 'unauthorized', 'Only the person can waive a delivery check.')
    const line = await deliveryLine()
    fireEvent.click(line.getByRole('button', { name: 'Waive…' }))
    fireEvent.change(line.getByRole('textbox', { name: 'Why waive the delivery check' }), { target: { value: 'Shipped' } })
    fireEvent.click(line.getByRole('button', { name: 'Waive delivery' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Only the person can waive a delivery check.')
    const after = await deliveryLine()
    expect((after.getByRole('textbox', { name: 'Why waive the delivery check' }) as HTMLInputElement).value).toBe('Shipped')
    expect(h.backend.inputs('waiveDelivery')).toEqual([{ runId: 'rn_2', sprintId: 'sp_1', reason: 'Shipped' }])
  })

  it('Cancel closes the reason box without waiving', async () => {
    const h = renderWorkspace(backendWith([]))
    const line = await deliveryLine()
    fireEvent.click(line.getByRole('button', { name: 'Waive…' }))
    fireEvent.click(line.getByRole('button', { name: 'Cancel' }))
    expect(line.queryByRole('textbox')).toBeNull()
    expect(line.getByRole('button', { name: 'Waive…' })).toBeTruthy()
    expect(h.backend.inputs('waiveDelivery')).toEqual([])
  })
})
