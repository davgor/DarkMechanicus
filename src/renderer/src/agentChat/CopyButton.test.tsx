// @vitest-environment jsdom
import { setImmediate } from 'node:timers/promises'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { COPIED_MS, CopyButton, CopyContext, type CopyTarget } from './CopyButton'

afterEach(cleanup)

interface Fake extends CopyTarget {
  scheduler: ManualScheduler
  written: string[]
}

/** A clipboard that records what it is given, or refuses it, timed by a manual scheduler. */
function fake(fail?: 'rejects' | 'throws'): Fake {
  const written: string[] = []
  const writeText = (text: string): Promise<void> => {
    if (fail === 'throws') throw new Error('no clipboard')
    if (fail === 'rejects') return Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError'))
    written.push(text)
    return Promise.resolve()
  }
  return { writeText, scheduler: new ManualScheduler(), written }
}

function show(target: Fake, text = 'npm test'): HTMLButtonElement {
  render(
    <CopyContext.Provider value={target}>
      <CopyButton text={text} title="Copy message" />
    </CopyContext.Provider>
  )
  return screen.getByRole('button') as HTMLButtonElement
}

/** Clicks, then lets the clipboard's promise settle. */
async function click(button: HTMLElement): Promise<void> {
  fireEvent.click(button)
  await act(async () => { await Promise.resolve() })
}

describe('CopyButton: copying', () => {
  it('writes exactly its text, Markdown and surrounding whitespace included', async () => {
    const target = fake()
    const button = show(target, '  **Done** — run `npm test`\n')

    await click(button)

    expect(target.written).toEqual(['  **Done** — run `npm test`\n'])
    expect(button.title).toBe('Copy message')
  })

  it('reads Copied once the clipboard has the text, and Copy again when its 1.5 s timer fires', async () => {
    const target = fake()
    const button = show(target)
    expect(button.textContent).toBe('Copy')

    await click(button)
    expect(button.textContent).toBe('Copied')
    expect(button.dataset.state).toBe('copied')
    expect(target.scheduler.timeouts()).toEqual([1_500])
    expect(COPIED_MS).toBe(1_500)

    act(() => target.scheduler.fireTimeouts(COPIED_MS))
    expect(button.textContent).toBe('Copy')
    expect(target.scheduler.timeouts()).toEqual([])
  })

  it('restarts the 1.5 s on a second click instead of keeping the first timer', async () => {
    const target = fake()
    const button = show(target)

    await click(button)
    await click(button)

    expect(target.scheduler.timeouts()).toEqual([1_500])
    expect(target.written).toEqual(['npm test', 'npm test'])
  })
})

describe('CopyButton: failures and unmounting', () => {
  it('says Copy failed in place when the clipboard refuses, and lets no error escape', async () => {
    const target = fake('rejects')
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const button = show(target)

    await click(button)
    await setImmediate()
    process.off('unhandledRejection', unhandled)

    expect(button.textContent).toBe('Copy failed')
    expect(button.dataset.state).toBe('failed')
    expect(target.scheduler.timeouts()).toEqual([])
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('treats a clipboard that throws before returning a promise as a failure too', async () => {
    const target = fake('throws')
    const button = show(target)

    await click(button)

    expect(button.textContent).toBe('Copy failed')
  })

  it('cancels its pending revert when it unmounts', async () => {
    const target = fake()
    const view = render(
      <CopyContext.Provider value={target}>
        <CopyButton text="x" title="Copy code" />
      </CopyContext.Provider>
    )
    await click(screen.getByRole('button'))
    expect(target.scheduler.timeouts()).toEqual([1_500])

    view.unmount()

    expect(target.scheduler.timeouts()).toEqual([])
  })
})
