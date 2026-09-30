import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { capabilityProfile, LIMITS, profileName } from '../../core/schemas'
import type { CommandApi } from '../../shared/domain/api'
import { defineArglessTool, defineTool, registerTools } from './define'
import { expectedRevision, idempotencyKey } from './params'

const name = profileName.describe(
  'Profile name, also its file name: 1-64 lowercase letters, digits, or hyphens, such as ui-implementation.'
)

const PROFILE_TOOLS = [
  defineArglessTool({
    name: 'list_profiles',
    description:
      'Lists the named capability profiles of this repository, sorted by name: reusable, provider-neutral requirement presets such as ui-implementation or deep-review, each with its description, full capability, and revision. Check them before writing a ticket capability by hand.',
    kind: 'read',
    run: (api) => api.listProfiles()
  }),
  defineTool({
    name: 'get_profile',
    description:
      'Returns one named capability profile: description, full capability, and the revision that save_profile needs to replace it. To apply it, pass its capability as the ticket capability in create_ticket or update_ticket. Fails with `not_found` for an unknown name.',
    kind: 'read',
    input: { name },
    run: (api, input) => api.getProfile(input)
  }),
  defineTool({
    name: 'save_profile',
    description:
      'Creates or replaces a named capability profile, stored as .darkmechanicus/profiles/<name>.json. Omit expectedRevision to create; to replace, pass the revision you last read. A stale or missing expectedRevision fails with `conflict` and changes nothing. A save replaces the whole profile (an omitted description is saved empty). capability is a complete provider-neutral profile: never name vendors or models; an exact model belongs only in preferences.modelOverride. Tickets copy a profile, so later saves do not change existing tickets.',
    kind: 'write',
    input: {
      name,
      description: z.string().max(LIMITS.profileDescription).optional().describe('One line on when to use this profile.'),
      capability: capabilityProfile,
      expectedRevision: expectedRevision.optional(),
      idempotencyKey
    },
    run: (api, input) => api.saveProfile(input)
  })
]

export function registerProfileTools(server: McpServer, api: CommandApi): void {
  registerTools(server, api, PROFILE_TOOLS)
}
