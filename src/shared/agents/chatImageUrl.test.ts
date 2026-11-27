import { describe, expect, it } from 'vitest'
import { CHAT_IMAGE_SCHEME, chatImageUrl } from './chatImageUrl'

const IMAGE = 'ci_01m8ec59dbq52ydhsy6ry7knhv'

describe('chatImageUrl', () => {
  it('names the scheme every consumer serves and builds', () => {
    expect(CHAT_IMAGE_SCHEME).toBe('dm-chat-image')
  })

  it("addresses a folder chat's image by the folder key, the chat id and the image id", () => {
    expect(chatImageUrl('0123abcd', 'chat_1', IMAGE)).toBe(`dm-chat-image://0123abcd/chat_1/${IMAGE}`)
  })

  it('uses a projectless host for a chat of no folder', () => {
    expect(chatImageUrl(null, 'chat_1', IMAGE)).toBe(`dm-chat-image://projectless/chat_1/${IMAGE}`)
    expect(new URL(chatImageUrl(null, 'chat_1', IMAGE)).pathname).toBe(`/chat_1/${IMAGE}`)
  })
})
