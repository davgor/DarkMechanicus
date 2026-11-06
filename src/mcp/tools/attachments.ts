import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { attachmentPurpose, attachmentRef, LIMITS } from '../../core/schemas'
import type { CommandApi } from '../../shared/domain/api'
import { defineTool, registerTools } from './define'

const ATTACHMENT_TOOLS = [
  defineTool({
    name: 'add_attachment',
    description:
      'Stages a PNG or JPEG image from a file on this machine and returns its id, sha256, mime and dimensions. The type, size and dimensions are read from the file itself. Only files in the project root, its worktrees, the system temp folder or the OS screenshot folder are accepted; SVG and symbolic links are refused. Staged images are attached to a record (evidence or a reference) and pruned after seven days if nothing claims them.',
    kind: 'write',
    input: {
      path: z.string().min(1).max(4096).describe('Absolute path to the image file, or relative to the working folder.'),
      label: z.string().max(LIMITS.label).describe('A short label shown with the image.'),
      purpose: attachmentPurpose.describe('evidence (proof of a result) or reference (a mockup or design to match).')
    },
    run: (api, input) => api.addAttachment(input)
  }),
  defineTool({
    name: 'get_attachment',
    description:
      'Returns an attachment\'s metadata (as "metadata"), or also writes its bytes to a temporary file and returns that absolute path (as "file"), so a mockup can be opened to look at. The file is byte-identical to the original.',
    kind: 'read',
    input: {
      attachmentId: attachmentRef.shape.id.describe('Attachment id, such as im_… (from add_attachment).'),
      as: z.enum(['metadata', 'file']).describe('metadata: the view only. file: the view plus the path of a copy of the bytes.')
    },
    run: (api, input) => api.getAttachment(input)
  })
]

export function registerAttachmentTools(server: McpServer, api: CommandApi): void {
  registerTools(server, api, ATTACHMENT_TOOLS)
}
