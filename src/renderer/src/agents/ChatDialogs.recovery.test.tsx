// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { chatRecord } from '../__mocks__/fixtures'
import { DeleteChatDialog, RenameChatDialog } from './ChatDialogs'

afterEach(() => cleanup())
const chat = chatRecord({ firstPrompt: '  Diagnose the failed refresh without losing this original request.  ', titleStatus: 'pending' })

it('does not duplicate a pending manual rename and preserves the edited title after a failed write for retry', async () => {
  let finish!: (renamed: boolean) => void
  const pending = new Promise<boolean>(resolve => { finish = resolve })
  const submit = vi.fn().mockImplementationOnce(() => pending).mockResolvedValue(true)
  const close = vi.fn()
  render(<RenameChatDialog chat={chat} onSubmit={submit} onClose={close} />)
  const field = screen.getByRole('textbox', { name: 'Title' })
  const title = 'Manual refresh investigation'
  fireEvent.change(field, { target: { value: title } })
  fireEvent.click(screen.getByRole('button', { name: 'Rename chat' }))
  fireEvent.submit(field.closest('form')!)
  expect(submit).toHaveBeenCalledExactlyOnceWith(title)
  await act(async () => { finish(false); await pending })
  expect(close).not.toHaveBeenCalled()
  expect((field as HTMLInputElement).value).toBe(title)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Rename chat' })) })
  expect(submit).toHaveBeenCalledTimes(2)
  expect(close).toHaveBeenCalledOnce()
})

it('keeps a failed deletion open for retry instead of dismissing the saved first-message chat', async () => {
  const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
  const close = vi.fn()
  render(<DeleteChatDialog chat={chat} onConfirm={confirm} onClose={close} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Delete/ })) })
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Delete/ })) })
  expect(confirm).toHaveBeenCalledTimes(2)
  expect(close).toHaveBeenCalledOnce()
})
