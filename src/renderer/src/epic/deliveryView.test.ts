import { describe, expect, it } from 'vitest'
import type { PlanBundle, SprintDelivery } from '../../../shared/domain/bundle'
import type { CheckResult, DeliveryCheckView } from '../../../shared/domain/views'
import { bundle, iso, runView, sprint } from './__mocks__/fixtures'
import { deliveryLine, deliverySummary } from './deliveryView'

const MAIN: SprintDelivery = { target: 'main', release: true, verifyInstalled: true }

function delivering(...declared: (SprintDelivery | undefined)[]): PlanBundle {
  return bundle({
    sprints: [
      sprint(1, 'Storage foundation', ['tk_101', 'tk_102', 'tk_103'], declared[0] === undefined ? {} : { delivery: declared[0] }),
      sprint(2, 'Authoring through MCP', ['tk_201', 'tk_202', 'tk_203', 'tk_204'], declared[1] === undefined ? {} : { delivery: declared[1] }),
      sprint(3, 'Desktop editing', ['tk_301', 'tk_302', 'tk_304'])
    ]
  })
}

const passed = (name: string): CheckResult => ({ name, status: 'passed', detail: `${name} ok` })
const failed = (name: string, detail: string): CheckResult => ({ name, status: 'failed', detail })

function check(sprintId: string, number: number, checks: CheckResult[]): DeliveryCheckView {
  return {
    id: `dc_${number}`,
    runId: 'rn_2',
    sprintId,
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

function waiver(sprintId: string, number: number): DeliveryCheckView {
  return { ...check(sprintId, number, []), kind: 'waiver', commit: null, reason: 'Shipped by hand', passed: true, recordedBy: null }
}

describe('deliveryLine', () => {
  it('is null when no earlier sprint declares a delivery, or without the pinned plan', () => {
    expect(deliveryLine(runView(), bundle())).toBeNull()
    expect(deliveryLine(runView(), null)).toBeNull()
  })

  it('is null for the active sprint’s own delivery: only earlier sprints hold claims', () => {
    expect(deliveryLine(runView({ activeSprintId: 'sp_1', activeSprintOrdinal: 1 }), delivering(MAIN))).toBeNull()
    expect(deliveryLine(runView({ activeSprintId: null, activeSprintOrdinal: null }), delivering(MAIN))).toBeNull()
  })

  it('is pending with no checks while the Magos has recorded none', () => {
    expect(deliveryLine(runView(), delivering(MAIN))).toEqual({ sprintId: 'sp_1', ordinal: 1, target: 'main', state: 'pending', checks: [] })
  })

  it('is failed with the latest check’s named results, a later failure overriding an earlier pass', () => {
    const run = runView({
      deliveries: [
        check('sp_1', 1, [passed('target'), passed('release')]),
        check('sp_1', 2, [passed('target'), failed('installed', 'Installed 1.1.0 is older than release 1.2.0 (readInstalledApp)')])
      ]
    })
    expect(deliveryLine(run, delivering(MAIN))).toEqual({
      sprintId: 'sp_1',
      ordinal: 1,
      target: 'main',
      state: 'failed',
      checks: [
        { name: 'target', status: 'passed', detail: 'target ok', icon: '✓' },
        { name: 'installed', status: 'failed', detail: 'Installed 1.1.0 is older than release 1.2.0 (readInstalledApp)', icon: '✗' }
      ]
    })
  })

  it('is cleared by a passing latest check', () => {
    const run = runView({ deliveries: [check('sp_1', 1, [failed('target', 'abc1234 is not on main')]), check('sp_1', 2, [passed('target')])] })
    expect(deliveryLine(run, delivering(MAIN))).toBeNull()
  })

  it('is cleared by a waiver, even before a later failed check', () => {
    const run = runView({ deliveries: [waiver('sp_1', 1), check('sp_1', 2, [failed('target', 'abc1234 is not on main')])] })
    expect(deliveryLine(run, delivering(MAIN))).toBeNull()
  })

  it('names the earliest unsatisfied earlier sprint, skipping satisfied ones and other sprints’ checks', () => {
    const second: SprintDelivery = { target: 'release/2', release: false, verifyInstalled: false }
    const run = runView({ activeSprintId: 'sp_3', activeSprintOrdinal: 3, deliveries: [waiver('sp_1', 1), check('sp_1', 2, [failed('target', 'not on main')])] })
    expect(deliveryLine(run, delivering(MAIN, second))).toEqual({ sprintId: 'sp_2', ordinal: 2, target: 'release/2', state: 'pending', checks: [] })
  })
})

describe('deliverySummary', () => {
  it('names the target and each requested verification', () => {
    expect(deliverySummary(MAIN)).toBe('main · release · verify installed')
    expect(deliverySummary({ target: 'main', release: true, verifyInstalled: false })).toBe('main · release')
    expect(deliverySummary({ target: 'main', release: false, verifyInstalled: false })).toBe('main')
  })
})
