// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import type { ScoreIdentity, ScoreReadState } from './scoreReads'
import { SCORE_POLL_MS, useScoreRead } from './useScoreRead'

const FOLDER = 'C:/work/shop'

let dm: FakeDm
let scheduler: ManualScheduler

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  scheduler = new ManualScheduler()
  // Each read answers with the ticket it was for and how many grade reads the desktop has answered so far.
  dm.handlers.getTicketGrade = (input) => ({ ticketId: typeof input === 'object' && input !== null && 'ticketId' in input ? input.ticketId : null, read: dm.callsOf('getTicketGrade').length })
})

afterEach(() => {
  cleanup()
})

const ticket = (ticketId: string): ScoreIdentity => ({ kind: 'ticket', runId: 'rn_1', ticketId })

interface Props {
  identity: ScoreIdentity | null
  version: number
}

/** Renders the hook, recording what every render returned beside the identity it was rendered for. */
function mount(initial: Props) {
  const renders: { ticketId: string | null; state: ScoreReadState<unknown> }[] = []
  const hook = renderHook(
    (props: Props) => {
      const state = useScoreRead({ folder: FOLDER, identity: props.identity, version: props.version, scheduler })
      renders.push({ ticketId: props.identity?.kind === 'ticket' ? props.identity.ticketId : null, state })
      return state
    },
    { initialProps: initial }
  )
  return { hook, renders }
}

describe('useScoreRead over the desktop command channel (DM-179 c4)', () => {
  it('loads the scorecard once on mount, through the folder it shows', async () => {
    const { hook } = mount({ identity: ticket('tk_api'), version: 0 })
    await settle()
    expect(hook.result.current).toMatchObject({ status: 'ready', data: { ticketId: 'tk_api', read: 1 }, refreshError: null })
    expect(dm.callsOf('getTicketGrade')).toEqual([{ folder: FOLDER, name: 'getTicketGrade', input: { runId: 'rn_1', ticketId: 'tk_api' } }])
  })

  it('never returns the previous ticket’s grade after the identity changes, not even in the render that changes it', async () => {
    const { hook, renders } = mount({ identity: ticket('tk_api'), version: 0 })
    await settle()
    renders.length = 0
    hook.rerender({ identity: ticket('tk_guide'), version: 0 })
    await settle()
    expect(renders[0]?.state).toMatchObject({ status: 'loading' })
    expect(renders.filter((render) => render.ticketId === 'tk_guide' && JSON.stringify(render.state).includes('tk_api'))).toEqual([])
    expect(hook.result.current).toMatchObject({ status: 'ready', data: { ticketId: 'tk_guide' } })
  })

  it('reads again in place when the version changes, on the poll and on window focus, never showing loading', async () => {
    const { hook, renders } = mount({ identity: ticket('tk_api'), version: 0 })
    await settle()
    renders.length = 0
    hook.rerender({ identity: ticket('tk_api'), version: 1 })
    await settle()
    expect(hook.result.current).toMatchObject({ data: { read: 2 } })
    act(() => scheduler.fireIntervals(SCORE_POLL_MS))
    await settle()
    expect(hook.result.current).toMatchObject({ data: { read: 3 } })
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await settle()
    expect(hook.result.current).toMatchObject({ status: 'ready', data: { ticketId: 'tk_api', read: 4 } })
    expect(renders.filter((render) => render.state.status === 'loading')).toEqual([])
  })
})

describe('useScoreRead through failures and deselection (DM-179 c4)', () => {
  it('keeps the last good grade beside a retryable error when a refresh fails', async () => {
    const { hook } = mount({ identity: ticket('tk_api'), version: 0 })
    await settle()
    dm.failures.getTicketGrade = { code: 'busy', message: 'The desktop is busy.' }
    hook.rerender({ identity: ticket('tk_api'), version: 1 })
    await settle()
    expect(hook.result.current).toMatchObject({ status: 'ready', data: { read: 1 }, refreshError: { code: 'busy', action: 'retry' } })
  })

  it('stops reading once nothing is selected: idle, no poll left, a focus reads nothing', async () => {
    const { hook } = mount({ identity: ticket('tk_api'), version: 0 })
    await settle()
    hook.rerender({ identity: null, version: 0 })
    await settle()
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await settle()
    expect(hook.result.current).toEqual({ status: 'idle' })
    expect(scheduler.intervals()).toEqual([])
    expect(dm.callsOf('getTicketGrade')).toHaveLength(1)
  })
})
