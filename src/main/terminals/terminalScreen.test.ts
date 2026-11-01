/**
 * The headless screen under more output than it takes in: xterm refuses a write once 50 MB wait to be parsed,
 * and the screen must neither throw that into the PTY's data listener nor leave a snapshot waiting for ever.
 */
import { describe, expect, it } from 'vitest'
import { createTerminalScreen } from './terminalScreen'

describe('terminal screen', () => {
  it('drops output past what the screen takes in, and still answers a snapshot', async () => {
    const screen = createTerminalScreen(80, 24)
    const megabyte = 'x'.repeat(1024 * 1024)
    const onScreen: string[] = []

    for (let written = 0; written < 60; written += 1) {
      screen.write(megabyte, () => onScreen.push('x'))
    }
    const snapshot = await new Promise<string>((resolve) => {
      screen.snapshot(resolve)
    })
    screen.dispose()

    expect(typeof snapshot).toBe('string')
    expect(onScreen.length).toBeLessThan(60)
  })
})
