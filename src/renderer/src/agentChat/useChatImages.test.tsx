// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useContext } from 'react'
import { afterEach, expect, it } from 'vitest'
import { CHAT_IMAGE_MAX_BYTES } from '../../../shared/agents/agentChat'
import type { ChatImageRef } from '../../../shared/agents/chat'
import { chatImageUrl } from '../../../shared/agents/chatImageUrl'
import { FakeAgentChat } from '../__mocks__/fakeAgentChat'
import { settle } from '../__mocks__/settle'
import { ChatImageAttachButton, ChatImageChips } from './ChatImageChips'
import { ChatImagesContext, useChatImages } from './useChatImages'

const ref = { folder: 'C:/work/dark-mechanicus', chatId: 'fixture-chat' }
const FOLDER_KEY = '00000000000000000000000000000001'
/** A PNG signature and the plain base64 FileReader gives for it (no `data:` prefix). */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_BASE64 = 'iVBORw0KGgo='
const staged = (n: number): ChatImageRef => ({ id: `ci_0000000000000000000000000${n}`, mime: 'image/png', width: 10, height: 10, bytes: 68 })
const png = (name = 'shot.png'): File => new File([PNG_BYTES], name, { type: 'image/png' })

afterEach(cleanup)

/** A camera-like panel: it stages its own image and adds the ref through the context. */
function CameraButton({ image }: { image: ChatImageRef }): JSX.Element {
  const handle = useContext(ChatImagesContext)
  return <button type="button" onClick={() => handle?.addStaged(image)}>Capture</button>
}

/** The hook behind a paste/drop target, the picker button and the chips, as the composer wires them. */
function Harness({ api, camera = staged(9) }: { api: FakeAgentChat; camera?: ChatImageRef }): JSX.Element {
  const images = useChatImages((data) => api.stageImage({ ...ref, data }))
  return (
    <ChatImagesContext.Provider value={images}>
      <div aria-label="Composer" {...images.targetProps}>
        <ChatImageChips folderKey={FOLDER_KEY} chatId={ref.chatId} images={images.images} staging={images.staging} error={images.error}
          remove={images.remove} />
        <ChatImageAttachButton pickerProps={images.pickerProps} disabled={false} />
        <CameraButton image={camera} />
        <output aria-label="Staging">{String(images.staging)}</output>
        <button type="button" onClick={() => images.clear(images.images.slice(0, 1).map((image) => image.id))}>Sent first</button>
      </div>
    </ChatImagesContext.Provider>
  )
}

function mount() {
  const api = new FakeAgentChat()
  render(<Harness api={api} />)
  return { api, target: screen.getByLabelText('Composer'), picker: document.querySelector('input[type="file"]') as HTMLInputElement }
}

function paste(target: HTMLElement, files: File[]): void {
  fireEvent.paste(target, { clipboardData: { items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })) } })
}

/** Waits until no image is being read or staged (FileReader answers on a later task, not a microtask). */
async function idle(): Promise<void> {
  await waitFor(() => expect(screen.getByLabelText('Staging').textContent).toBe('false'))
}

const chips = (): string[] => screen.queryAllByRole('img').map((image) => image.getAttribute('src') ?? '')

it('stages a pasted PNG with plain base64 and shows its thumbnail', async () => {
  const { api, target } = mount()
  api.stagedImages = [staged(1)]
  paste(target, [png()])
  await idle()
  expect(api.callsOf('stageImage')).toEqual([[{ ...ref, data: PNG_BASE64 }]])
  expect(chips()).toEqual([chatImageUrl(FOLDER_KEY, ref.chatId, staged(1).id)])
  expect(screen.queryByRole('alert')).toBe(null)
})

it('stages a dropped image and one picked with the PNG/JPEG picker', async () => {
  const { api, target, picker } = mount()
  expect(picker.accept).toBe('image/png,image/jpeg')
  expect(picker.multiple).toBe(true)
  api.stagedImages = [staged(1), staged(2)]
  fireEvent.drop(target, { dataTransfer: { files: [png()], types: ['Files'] } })
  await idle()
  fireEvent.change(picker, { target: { files: [new File([PNG_BYTES], 'photo.jpg', { type: 'image/jpeg' })] } })
  await idle()
  expect(api.callsOf('stageImage')).toEqual([[{ ...ref, data: PNG_BASE64 }], [{ ...ref, data: PNG_BASE64 }]])
  expect(chips()).toEqual([1, 2].map((n) => chatImageUrl(FOLDER_KEY, ref.chatId, staged(n).id)))
})

it('opens the picker from the attach button', () => {
  const { picker } = mount()
  let opened = 0
  picker.addEventListener('click', () => { opened += 1 })
  fireEvent.click(screen.getByRole('button', { name: 'Attach images' }))
  expect(opened).toBe(1)
})

it('refuses a GIF and a file of 10 MiB + 1 byte inline without staging them', async () => {
  const { api, target, picker } = mount()
  paste(target, [new File([PNG_BYTES], 'loop.gif', { type: 'image/gif' })])
  expect(screen.getByRole('alert').textContent).toBe('loop.gif is not a PNG or JPEG image.')
  fireEvent.change(picker, { target: { files: [new File([new Uint8Array(CHAT_IMAGE_MAX_BYTES + 1)], 'huge.png', { type: 'image/png' })] } })
  await idle()
  expect(screen.getByRole('alert').textContent).toBe('huge.png is larger than 10 MB.')
  expect(api.callsOf('stageImage')).toEqual([])
  expect(chips()).toEqual([])
})

it('refuses a fifth image, whether pasted later or in the same batch, without staging it', async () => {
  const { api, target } = mount()
  api.stagedImages = [1, 2, 3, 4].map(staged)
  paste(target, [png('1.png'), png('2.png'), png('3.png'), png('4.png'), png('5.png')])
  expect(screen.getByRole('alert').textContent).toBe('At most 4 images can go with one message.')
  await idle()
  expect(api.callsOf('stageImage')).toHaveLength(4)
  expect(chips()).toHaveLength(4)
  paste(target, [png('6.png')])
  await idle()
  expect(api.callsOf('stageImage')).toHaveLength(4)
  expect(screen.getByRole('alert').textContent).toBe('At most 4 images can go with one message.')
  fireEvent.click(screen.getByRole('button', { name: 'Capture' }))
  expect(chips()).toHaveLength(4)
})

it('counts images still staging against the limit', async () => {
  const { api, target } = mount()
  const hold = api.hold('stageImage')
  api.stagedImages = [1, 2, 3, 4].map(staged)
  paste(target, [png('1.png')])
  await settle()
  expect(screen.getByLabelText('Staging').textContent).toBe('true')
  expect(screen.getByRole('listitem', { name: 'Adding image' })).toBeTruthy()
  paste(target, [png('2.png'), png('3.png'), png('4.png'), png('5.png')])
  hold.resolve()
  await idle()
  expect(api.callsOf('stageImage')).toHaveLength(4)
  expect(chips()).toHaveLength(4)
  expect(screen.getByLabelText('Staging').textContent).toBe('false')
})

it('removes a chip, freeing its place, and keeps chips added after a message was taken', async () => {
  const { api, target } = mount()
  api.stagedImages = [1, 2, 3, 4, 5].map(staged)
  paste(target, [png('1.png'), png('2.png'), png('3.png'), png('4.png')])
  await idle()
  fireEvent.click(screen.getByRole('button', { name: 'Remove image 2' }))
  expect(chips()).toEqual([1, 3, 4].map((n) => chatImageUrl(FOLDER_KEY, ref.chatId, staged(n).id)))
  paste(target, [png('5.png')])
  await idle()
  expect(chips()).toHaveLength(4)
  fireEvent.click(screen.getByRole('button', { name: 'Sent first' }))
  expect(chips()).toEqual([3, 4, 5].map((n) => chatImageUrl(FOLDER_KEY, ref.chatId, staged(n).id)))
})

it('shows a failed stage inline and adds no chip', async () => {
  const { api, target } = mount()
  api.failures.stageImage = { code: 'invalid_request', message: 'The image is not a PNG or JPEG.' }
  paste(target, [png()])
  await idle()
  expect(screen.getByRole('alert').textContent).toBe('The image is not a PNG or JPEG.')
  expect(chips()).toEqual([])
  delete api.failures.stageImage
  api.stagedImages = [1, 2, 3, 4].map(staged)
  paste(target, [png('1.png'), png('2.png'), png('3.png'), png('4.png')])
  await idle()
  expect(chips()).toHaveLength(4)
})

it('exposes addStaged through ChatImagesContext, so another panel adds an image main already staged', () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Capture' }))
  expect(chips()).toEqual([chatImageUrl(FOLDER_KEY, ref.chatId, staged(9).id)])
  fireEvent.click(screen.getByRole('button', { name: 'Capture' }))
  expect(chips()).toHaveLength(1)
})

it('leaves a text paste to the field', () => {
  const { api, target } = mount()
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.assign(event, { clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] } })
  target.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
  expect(api.callsOf('stageImage')).toEqual([])
})
