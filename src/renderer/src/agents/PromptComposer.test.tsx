// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { deferred } from '../__mocks__/deferred'
import { PromptComposer } from './PromptComposer'

afterEach(cleanup)

describe('explicit app prompt composer', () => {
  it('submits whole multiline text once, blocks duplicate sends and clears only on success', async () => {
    const dm = new FakeDm()
    window.dm = dm
    const hold = deferred()
    const sent: unknown[] = []
    dm.chats.submitPrompt = async (request) => {
      sent.push(request)
      await hold.promise
      return { ok: true, data: { problem: null } }
    }
    render(<PromptComposer folder="/a" chatId="chat_a" disabled={false} />)
    const input = screen.getByRole('textbox', { name: 'Prompt' })
    expect((screen.getByRole('button', { name: 'Send prompt' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'Why is\nthe build red?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect(sent).toEqual([{ folder: '/a', chatId: 'chat_a', text: 'Why is\nthe build red?' }])
    await act(async () => hold.resolve())
    expect((input as HTMLTextAreaElement).value).toBe('')
  })

  it('keeps unsent text and reports terminal refusal, and cannot send while disabled', async () => {
    const dm = new FakeDm()
    window.dm = dm
    dm.chats.submitPrompt = async () => ({ ok: true, data: { problem: 'The CLI is signed out.' } })
    const view = render(<PromptComposer folder="/a" chatId="chat_a" disabled={false} />)
    const input = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.change(input, { target: { value: 'Investigate this failure' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send prompt' })))
    expect(screen.getByRole('alert').textContent).toBe('The CLI is signed out.')
    expect((input as HTMLTextAreaElement).value).toBe('Investigate this failure')
    view.rerender(<PromptComposer folder="/a" chatId="chat_a" disabled />)
    expect((screen.getByRole('button', { name: 'Send prompt' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
