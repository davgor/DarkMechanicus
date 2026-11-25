/** A card message carries the images it names, by reference, and lists them back; a plain message carries none. */
import { describe, expect, it } from 'vitest'
import { pngBytes } from '../../../test/images'
import { createTestCtx } from '../../../test/testContext'
import { createStagedAttachment } from '../attachments'
import { addKanbanMessage, createKanbanCard, listKanbanMessages } from './cards'

describe('addKanbanMessage with images', () => {
  it('claims the named images for the message and returns their references, and leaves a plain message without any', () => {
    const ctx = createTestCtx({ role: 'desktop' })
    const card = createKanbanCard(ctx, { title: 'Screenshot the failure' })
    const image = createStagedAttachment(ctx, { bytes: pngBytes(40, 30, 7), label: 'failure', purpose: 'reference' })
    const shown = addKanbanMessage(ctx, { cardId: card.id, body: 'Here it fails', attachments: [image.id] })
    expect(shown.attachments?.map((ref) => [ref.id, ref.mime, ref.width, ref.height, ref.label])).toEqual([[image.id, 'image/png', 40, 30, 'failure']])
    const plain = addKanbanMessage(ctx, { cardId: card.id, body: 'No image' })
    expect('attachments' in plain).toBe(false)
    expect(listKanbanMessages(ctx, { cardId: card.id }).map((message) => [message.body, message.attachments?.length ?? 0])).toEqual([
      ['Here it fails', 1],
      ['No image', 0]
    ])
    expect(ctx.db.get('SELECT owner_kind, owner_id FROM attachments WHERE id = ?', image.id)).toEqual({ owner_kind: 'kanban_message', owner_id: shown.id })
  })
})
