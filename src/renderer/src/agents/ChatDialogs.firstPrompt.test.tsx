// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FirstPromptDialog } from './ChatDialogs'

afterEach(() => cleanup())

it('ignores Escape while creation is pending, then allows cancellation without losing a rejected prompt', async () => {
  let finish!: (accepted: boolean) => void
  const pending = new Promise<boolean>(resolve => { finish = resolve })
  const submit = vi.fn(() => pending)
  const close = vi.fn()
  render(<FirstPromptDialog onSubmit={submit} onClose={close} />)
  const field = screen.getByRole('textbox', { name: 'First prompt' })
  const prompt = '  Repair the interrupted refresh flow.  '
  fireEvent.change(field, { target: { value: prompt } })
  fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
  expect(submit).toHaveBeenCalledExactlyOnceWith(prompt)
  await act(async () => { finish(false); await pending })
  expect((field as HTMLTextAreaElement).value).toBe(prompt)
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
})

it('rejects an oversized form submission without truncating or sending the original prompt', () => {
  const submit = vi.fn(async () => true)
  render(<FirstPromptDialog onSubmit={submit} onClose={() => {}} />)
  const field = screen.getByRole('textbox', { name: 'First prompt' })
  const prompt = 'x'.repeat(32_001)
  fireEvent.change(field, { target: { value: prompt } })
  expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.submit(field.closest('form')!)
  expect(submit).not.toHaveBeenCalled()
  expect((field as HTMLTextAreaElement).value).toBe(prompt)
})
