import { resolveAllowedRootsForMachine } from '../attachments/intake'
import { writeAttachmentTempFile } from '../attachments/tempFile'
import { requireCapability } from '../authz'
import { fail } from '../errors'
import { LIMITS } from '../schemas'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import {
  getAttachment as getAttachmentView,
  readAttachmentBytes,
  createStagedAttachment,
  stageAttachmentFile
} from '../services/attachments'
import type { CommandTable } from './types'

const attachmentCommands = {
  addAttachment: {
    schema: COMMAND_SCHEMAS.addAttachment,
    mutates: true,
    run: async (core, input) => {
      // The desktop app is a person's window, not an agent with a machine of its own to read a path from.
      if (core.transport === 'desktop') {
        fail('unauthorized', 'The desktop app does not add attachments; an agent session adds them from a file on its own machine.', {
          transport: core.transport
        })
      }
      const ctx = core.ctx()
      requireCapability(ctx.session, 'attachment.write')
      const roots = resolveAllowedRootsForMachine(core.repoRoot, await core.git.listWorktrees())
      return stageAttachmentFile(ctx, { ...input, roots })
    }
  },
  uploadAttachment: {
    schema: COMMAND_SCHEMAS.uploadAttachment,
    mutates: true,
    run: (core, input) => {
      // The inverse of addAttachment: only the app uploads bytes; an agent names a file on its own machine.
      if (core.transport !== 'desktop') {
        fail('unauthorized', 'Only the desktop app uploads image bytes; an agent adds an image from a file with add_attachment.', {
          transport: core.transport
        })
      }
      const ctx = core.ctx()
      requireCapability(ctx.session, 'attachment.write')
      const label = input.label === undefined || input.label === '' ? 'Pasted image' : input.label.slice(0, LIMITS.label)
      return createStagedAttachment(ctx, {
        bytes: Buffer.from(input.data, 'base64'),
        label,
        purpose: input.purpose ?? 'reference'
      })
    }
  },
  getAttachment: {
    schema: COMMAND_SCHEMAS.getAttachment,
    mutates: false,
    run: (core, input) => {
      const ctx = core.ctx()
      requireCapability(ctx.session, 'read')
      const view = getAttachmentView(ctx, input.attachmentId)
      if (input.as === 'metadata') {
        return view
      }
      const path = writeAttachmentTempFile(view.sha256, view.mime, readAttachmentBytes(ctx, view.id))
      return { ...view, path }
    }
  }
} satisfies Partial<CommandTable>

export { attachmentCommands }
