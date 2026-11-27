import { describe, expect, it } from 'vitest'
import { FakeAgentChat } from './fakeAgentChat'

const IMAGE = { id: 'ci_01m8ec59dbq52ydhsy6ry7knhv', mime: 'image/jpeg', width: 640, height: 480, bytes: 2048 } as const

describe('FakeAgentChat images', () => {
  it('records stageImage and attachEvidence and answers with the results a test sets', async () => {
    const fake = new FakeAgentChat()
    fake.stageImageResult = { ok: true, data: { image: IMAGE } }
    fake.attachEvidenceResult = { ok: true, data: { commentId: 'cm_9', attachmentId: 'im_9' } }
    const stage = { folder: '/repo', chatId: 'chat_1', data: 'iVBORw0KGgo=' }
    const evidence = { folder: '/repo', chatId: 'chat_1', imageId: IMAGE.id, epicId: 'ep_1' }

    expect(await fake.stageImage(stage)).toEqual({ ok: true, data: { image: IMAGE } })
    expect(await fake.attachEvidence(evidence)).toEqual({ ok: true, data: { commentId: 'cm_9', attachmentId: 'im_9' } })
    expect(fake.callsOf('stageImage')).toEqual([[stage]])
    expect(fake.callsOf('attachEvidence')).toEqual([[evidence]])
  })

  it('fails either call with the failure a test sets', async () => {
    const fake = new FakeAgentChat()
    const error = { code: 'invalid_input', message: 'Not an image' } as const
    fake.failures.stageImage = error
    fake.failures.attachEvidence = error
    expect(await fake.stageImage({ folder: null, chatId: 'chat_1', data: 'AAAA' })).toEqual({ ok: false, error })
    expect(await fake.attachEvidence({ folder: '/repo', chatId: 'chat_1', imageId: IMAGE.id, epicId: 'ep_1' })).toEqual({ ok: false, error })
  })
})
