// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeTerminalHandle } from '../__mocks__/fakeTerminals'
import { createLiveTerminals, LiveTerminalsContext, useLiveTerminal, type LiveTerminals } from './liveTerminals'

let live: LiveTerminals
let changes: number

beforeEach(() => {
  live = createLiveTerminals()
  changes = 0
  live.subscribe(() => (changes += 1))
})

afterEach(cleanup)

const EXIT = { exitCode: 0, signal: null, message: null, resumed: false }

describe('createLiveTerminals', () => {
  it('counts a chat as live from the terminal it holds until that terminal exits, and closes it then', () => {
    const terminal = new FakeTerminalHandle()
    live.hold('chat_a', terminal)
    expect(live.isLive('chat_a')).toBe(true)
    expect(live.isLive('chat_b')).toBe(false)
    expect(changes).toBe(1)

    terminal.emitExit(EXIT)
    expect(live.isLive('chat_a')).toBe(false)
    expect(terminal.closed).toBe(true)
    expect(changes).toBe(2)
  })

  it('keeps only the latest terminal of a chat open, and ignores the exit of one it let go', () => {
    const first = new FakeTerminalHandle()
    const second = new FakeTerminalHandle()
    live.hold('chat_a', first)
    live.hold('chat_a', second)
    expect(first.closed).toBe(true)
    expect(second.closed).toBe(false)
    expect(changes).toBe(1)

    first.emitExit(EXIT)
    expect(live.isLive('chat_a')).toBe(true)
    second.emitExit(EXIT)
    expect(live.isLive('chat_a')).toBe(false)
  })

  it('does nothing when the terminal it holds is handed to it again', () => {
    const terminal = new FakeTerminalHandle()
    live.hold('chat_a', terminal)
    live.hold('chat_a', terminal)
    expect(terminal.closed).toBe(false)
    expect(terminal.listenerCounts()).toEqual({ output: 0, exit: 1 })
    expect(changes).toBe(1)
  })

  it('stops telling a listener once it unsubscribed', () => {
    let heard = 0
    const stop = live.subscribe(() => (heard += 1))
    live.hold('chat_a', new FakeTerminalHandle())
    stop()
    live.hold('chat_b', new FakeTerminalHandle())
    expect(heard).toBe(1)
  })
})

describe('useLiveTerminal', () => {
  it('follows the chat’s terminal', () => {
    const wrapper = ({ children }: { children: ReactNode }): JSX.Element => <LiveTerminalsContext.Provider value={live}>{children}</LiveTerminalsContext.Provider>
    const { result } = renderHook(() => useLiveTerminal('chat_a'), { wrapper })
    expect(result.current).toBe(false)
    const terminal = new FakeTerminalHandle()
    act(() => live.hold('chat_a', terminal))
    expect(result.current).toBe(true)
    act(() => terminal.emitExit(EXIT))
    expect(result.current).toBe(false)
  })

  it('is false without a registry', () => {
    const { result } = renderHook(() => useLiveTerminal('chat_a'))
    expect(result.current).toBe(false)
  })
})
