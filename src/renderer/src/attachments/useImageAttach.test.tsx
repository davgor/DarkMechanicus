// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Runner } from '../epic/runner'
import { useImageAttach } from './useImageAttach'

afterEach(() => {
  cleanup()
})

function Harness(props: { runner: Runner }): JSX.Element {
  const images = useImageAttach(props.runner)
  return (
    <div>
      <textarea aria-label="field" {...images.targetProps} />
      <input aria-label="picker" {...images.pickerProps} />
      {images.error === null ? null : <p role="alert">{images.error}</p>}
      <ul aria-label="pending">
        {images.pending.map((image) => (
          <li key={image.id}>
            {image.label}
            <button type="button" onClick={() => images.remove(image.id)}>
              remove {image.id}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function png(name = 'shot.png'): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })
}

function runnerReturning(ids: string[]): { runner: Runner; calls: unknown[] } {
  const calls: unknown[] = []
  const queue = [...ids]
  const runner = ((name: string, input: unknown) => {
    calls.push({ name, input })
    const id = queue.shift() ?? 'im_x'
    const label = (input as { label: string }).label
    return Promise.resolve({ id, label })
  }) as unknown as Runner
  return { runner, calls }
}

describe('useImageAttach', () => {
  it('uploads a pasted image as plain base64 and lists it', async () => {
    const { runner, calls } = runnerReturning(['im_1'])
    render(<Harness runner={runner} />)
    const file = png('')
    fireEvent.paste(screen.getByLabelText('field'), {
      clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] }
    })
    await waitFor(() => expect(screen.getByRole('list', { name: 'pending' }).textContent).toContain('Pasted image'))
    expect(calls).toEqual([{ name: 'uploadAttachment', input: { data: 'iVBORw==', label: 'Pasted image', purpose: 'reference' } }])
  })

  it('leaves a text paste alone', () => {
    const { runner, calls } = runnerReturning([])
    render(<Harness runner={runner} />)
    const notPrevented = fireEvent.paste(screen.getByLabelText('field'), {
      clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] }
    })
    expect(notPrevented).toBe(true)
    expect(calls).toEqual([])
  })

  it('uploads a dropped image, labelled with its file name', async () => {
    const { runner, calls } = runnerReturning(['im_2'])
    render(<Harness runner={runner} />)
    fireEvent.drop(screen.getByLabelText('field'), { dataTransfer: { files: [png('login.png')], types: ['Files'] } })
    await waitFor(() => expect(screen.getByRole('list', { name: 'pending' }).textContent).toContain('login.png'))
    expect(calls).toHaveLength(1)
  })

  it('uploads files chosen with the picker, which accepts only PNG and JPEG', async () => {
    const { runner } = runnerReturning(['im_3'])
    render(<Harness runner={runner} />)
    const picker = screen.getByLabelText('picker') as HTMLInputElement
    expect(picker.getAttribute('accept')).toBe('image/png,image/jpeg')
    fireEvent.change(picker, { target: { files: [png('picked.png')] } })
    await waitFor(() => expect(screen.getByRole('list', { name: 'pending' }).textContent).toContain('picked.png'))
  })

  it('shows an upload error inline and attaches nothing', async () => {
    const runner = (() => Promise.reject(new Error('That is not a PNG or JPEG image.'))) as unknown as Runner
    render(<Harness runner={runner} />)
    fireEvent.drop(screen.getByLabelText('field'), { dataTransfer: { files: [png()], types: ['Files'] } })
    expect((await screen.findByRole('alert')).textContent).toBe('That is not a PNG or JPEG image.')
    expect(screen.getByRole('list', { name: 'pending' }).children).toHaveLength(0)
  })

})

describe('useImageAttach refusals and removal', () => {
  it('refuses a dropped file that is not an image without uploading it', async () => {
    const runner = vi.fn() as unknown as Runner
    render(<Harness runner={runner} />)
    fireEvent.drop(screen.getByLabelText('field'), {
      dataTransfer: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })], types: ['Files'] }
    })
    expect((await screen.findByRole('alert')).textContent).toMatch(/notes\.txt is not a PNG or JPEG/)
    expect(runner).not.toHaveBeenCalled()
  })

  it('removes a pending image from the list', async () => {
    const { runner } = runnerReturning(['im_4'])
    render(<Harness runner={runner} />)
    fireEvent.drop(screen.getByLabelText('field'), { dataTransfer: { files: [png('gone.png')], types: ['Files'] } })
    const button = await screen.findByRole('button', { name: 'remove im_4' })
    act(() => {
      fireEvent.click(button)
    })
    expect(screen.getByRole('list', { name: 'pending' }).children).toHaveLength(0)
  })
})
