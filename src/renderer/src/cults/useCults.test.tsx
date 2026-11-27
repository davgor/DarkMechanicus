// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deferred } from '../__mocks__/deferred'
import { FakeCults, cultView, memberDetail, runDetail } from '../__mocks__/fakeCults'
import { FakeDm } from '../__mocks__/fakeDm'
import { settle } from '../__mocks__/settle'
import { applyRunEvent, useCults, type CultsModel } from './useCults'

function Status(): JSX.Element {
  const { state } = useCults()
  return <p>{state.status === 'error' ? `error: ${state.message}` : state.status}</p>
}

let cults: FakeCults
let model: CultsModel

beforeEach(() => {
  const dm = new FakeDm()
  cults = new FakeCults()
  dm.cults = cults
  window.dm = dm
})

afterEach(cleanup)

function Probe(): JSX.Element {
  model = useCults()
  const { state } = model
  if (state.status !== 'ready') return <p>{state.status}</p>
  return (
    <ul>
      {state.cults.map(({ cult, runs }) => (
        <li key={cult.id}>{`${cult.name}: ${runs.map((run) => `${run.run.id}=${run.run.state}/${run.members.length}`).join(',')}`}</li>
      ))}
    </ul>
  )
}

describe('useCults', () => {
  it('lists the cults with their runs, then refreshes a run from a cults:event push', async () => {
    cults.cults = [cultView()]
    cults.runsByCult = { cult_1: [runDetail({ state: 'running' })] }
    render(<Probe />)
    await settle()
    expect(screen.getByText('Shrine Builders: run_1=running/0')).toBeTruthy()

    act(() => cults.push(runDetail({ state: 'paused' }, [memberDetail()])))
    expect(screen.getByText('Shrine Builders: run_1=paused/1')).toBeTruthy()

    act(() => cults.push(runDetail({ id: 'run_2', state: 'running' })))
    expect(screen.getByText('Shrine Builders: run_2=running/0,run_1=paused/1')).toBeTruthy()
  })

  it('ignores a push for a cult it does not know, and unsubscribes on unmount', async () => {
    cults.cults = [cultView()]
    const view = render(<Probe />)
    await settle()
    expect(cults.listenerCount).toBe(1)
    act(() => cults.push(runDetail({ cultId: 'cult_other' })))
    expect(screen.getByText('Shrine Builders:')).toBeTruthy()
    view.unmount()
    expect(cults.listenerCount).toBe(0)
  })

  it('reloads after a change and reports a refusal without reloading', async () => {
    render(<Probe />)
    await settle()
    let refused: string | null = 'unset'
    await act(async () => {
      refused = await model.create({ scope: 'sanctum', folderPath: null, name: 'New', charter: 'c', archetype: 'general', magosName: 'Magos Cawl', magosModelId: null, defaultTimeLimitMs: null })
    })
    await settle()
    expect(refused).toBeNull()
    expect(screen.getByText('New:')).toBeTruthy()

    cults.delete = () => Promise.resolve({ ok: false, error: { code: 'invalid_state', message: 'Still ending.' } })
    await act(async () => {
      refused = await model.remove('cult_1')
    })
    expect(refused).toBe('Still ending.')
  })

  it('applyRunEvent replaces only the matching run', () => {
    const entries = [{ cult: cultView(), runs: [runDetail({ id: 'run_1' }), runDetail({ id: 'run_0', state: 'ended' })] }]
    const next = applyRunEvent(entries, { type: 'run_changed', snapshot: runDetail({ id: 'run_1', state: 'shutting_down' }) })
    expect(next[0].runs.map((run) => `${run.run.id}:${run.run.state}`)).toEqual(['run_1:shutting_down', 'run_0:ended'])
  })
})

describe('useCults failures and ordering', () => {
  it('shows the list refusal', async () => {
    cults.list = () => Promise.resolve({ ok: false, error: { code: 'internal', message: 'Cult store unreadable.' } })
    render(<Status />)
    await settle()
    expect(screen.getByText('error: Cult store unreadable.')).toBeTruthy()
  })

  it('shows a rejection by its message, whether an Error or not', async () => {
    cults.list = () => Promise.reject(new Error('Bridge lost.'))
    const first = render(<Status />)
    await settle()
    expect(screen.getByText('error: Bridge lost.')).toBeTruthy()
    first.unmount()

    cults.list = () => Promise.reject('closed')
    render(<Status />)
    await settle()
    expect(screen.getByText('error: closed')).toBeTruthy()
  })

  it('ignores a push that arrives before the list loads', async () => {
    cults.cults = [cultView()]
    cults.runsByCult = { cult_1: [runDetail({ state: 'running' })] }
    const gate = deferred()
    const list = cults.list
    cults.list = async () => {
      await gate.promise
      return list()
    }
    render(<Probe />)
    await settle()
    expect(screen.getByText('loading')).toBeTruthy()
    act(() => cults.push(runDetail({ id: 'run_9', state: 'paused' })))
    gate.resolve()
    await settle()
    expect(screen.getByText('Shrine Builders: run_1=running/0')).toBeTruthy()
  })

  it('sends an update to main and resolves null once done', async () => {
    cults.cults = [cultView()]
    render(<Probe />)
    await settle()
    const input = { scope: 'sanctum' as const, folderPath: null, name: 'Renamed', charter: 'c', archetype: 'general' as const, magosName: 'Magos Cawl', magosModelId: null, defaultTimeLimitMs: null }
    let answer: string | null = 'unset'
    await act(async () => {
      answer = await model.update('cult_1', input)
    })
    await settle()
    expect(answer).toBeNull()
    expect(cults.updated).toEqual([['cult_1', input]])
    expect(screen.getByText('Renamed:')).toBeTruthy()
  })
})
