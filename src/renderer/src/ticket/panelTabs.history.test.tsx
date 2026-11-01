// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CommandInput } from '../../../shared/desktop/api'
import { FakeDm } from '../__mocks__/fakeDm'
import { eventView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { bindRunner } from '../epic/runner'
import { HistoryTab } from './panelTabs'

afterEach(cleanup)

const runner = bindRunner('/a')
const NOW = Date.parse('2026-03-01T12:00:00.000Z')

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  // Each epic's log holds one event of the ticket, named after the epic.
  dm.handlers.listEvents = (input) => {
    const epicId = (input as CommandInput<'listEvents'>).epicId ?? 'none'
    return { events: [eventView({ seq: 1, epicId, ticketId: 't1', kind: `${epicId}.moved`, at: '2026-03-01T11:00:00.000Z' })], cursor: 1 }
  }
})

const historyOf = (epicId: string): JSX.Element => <HistoryTab runner={runner} epicId={epicId} ticketId="t1" now={NOW} reloadKey={0} />
const titles = (): string[] => Array.from(document.querySelectorAll('.tp-history-title')).map((item) => item.textContent ?? '')

describe('HistoryTab stale reads', () => {
  it("drops the previous epic's late history", async () => {
    const hold = dm.holdNext('listEvents')
    const view = render(historyOf('first'))
    view.rerender(historyOf('second'))
    await settle()
    expect(titles()).toEqual(['Second moved'])
    hold.resolve()
    await settle()
    expect(titles()).toEqual(['Second moved'])
  })

  it("drops the previous epic's late failure", async () => {
    const hold = dm.holdNext('listEvents')
    const view = render(historyOf('first'))
    view.rerender(historyOf('second'))
    await settle()
    dm.failures.listEvents = { code: 'not_found', message: 'Epic is gone.' }
    hold.resolve()
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(titles()).toEqual(['Second moved'])
  })
})
