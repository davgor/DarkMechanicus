// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCults, cultView, memberDetail, runDetail } from '../__mocks__/fakeCults'
import { FakeDm } from '../__mocks__/fakeDm'
import { settle } from '../__mocks__/settle'
import { applyRunEvent, useCults, type CultsModel } from './useCults'

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
