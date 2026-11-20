import { z } from 'zod'
import { COMMAND_SCHEMAS } from '../../core/commandSchemas'
import { parseInput } from '../../core/schemas'
import type { YoloStatus } from '../../shared/desktop/api'
import type { ChatGrants } from '../agents/chatGrants'
import type { FolderRegistry } from './folderRegistry'
import { requireTracked } from './handlers'

export interface YoloHandlers {
  yolo(folder: unknown, grantId: unknown, action: unknown): Promise<YoloStatus>
}

interface YoloHandlerDeps {
  registry: Pick<FolderRegistry, 'resolve'>
  grants: Pick<ChatGrants, 'yolo'>
  confirm(detail: string): Promise<boolean>
}

/** Renderer supplies a selection, never a decision, identity, lifetime or scope. */
export function createYoloHandlers(deps: YoloHandlerDeps): YoloHandlers {
  return {
    yolo: async (folder, grantId, action) => {
      const path = requireTracked(deps.registry, folder)
      const grant = parseInput(COMMAND_SCHEMAS.revokeGrant, { grantId }, 'YOLO grant')
      const operation = parseInput(z.enum(['enable', 'revoke', 'inspect']), action, 'YOLO operation')
      return deps.grants.yolo(path, grant.grantId, operation, deps.confirm)
    }
  }
}
