// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm, MCP_JSON } from '../__mocks__/fakeDm'
import { settle } from '../__mocks__/settle'
import { useMcpConfig } from './useMcpConfig'

let dm: FakeDm
let errors: unknown[]

beforeEach(() => {
  errors = []
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

const mount = (path: string): ReturnType<typeof renderHook<ReturnType<typeof useMcpConfig>, { path: string }>> =>
  renderHook(({ path: folder }) => useMcpConfig(folder, (e) => errors.push(e)), { initialProps: { path } })

describe('useMcpConfig', () => {
  it('starts loading and then provides the config', async () => {
    const view = mount('/a')
    expect(view.result.current).toEqual({ status: 'loading' })
    await settle()
    expect(view.result.current.status === 'ready' && view.result.current.value.json).toBe(MCP_JSON)
    expect(dm.calls).toContain('getMcpConfig:/a')
  })

  it('reports a failure and exposes an error state', async () => {
    dm.rejects.getMcpConfig = 'bridge missing'
    const view = mount('/a')
    await settle()
    expect(view.result.current).toEqual({ status: 'error' })
    expect((errors[0] as Error).message).toBe('bridge missing')
  })

  it('reloads for another folder and never shows the previous one meanwhile', async () => {
    const view = mount('/a')
    await settle()
    dm.mcpConfig = { ...dm.mcpConfig, json: '{"b":true}' }
    view.rerender({ path: '/b' })
    expect(view.result.current).toEqual({ status: 'loading' })
    await settle()
    expect(view.result.current.status === 'ready' && view.result.current.value.json).toBe('{"b":true}')
  })
})
