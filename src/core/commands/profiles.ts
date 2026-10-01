import { COMMAND_SCHEMAS } from '../commandSchemas'
import { getProfile, listProfiles, saveProfile } from '../services/profiles'
import type { CommandTable } from './types'

/** Named capability profiles: reusable presets that tickets copy their capability requirements from. */
const profileCommands = {
  listProfiles: { mutates: false, run: (core) => listProfiles(core.ctx()) },
  getProfile: { schema: COMMAND_SCHEMAS.getProfile, mutates: false, run: (core, input) => getProfile(core.ctx(), input) },
  saveProfile: { schema: COMMAND_SCHEMAS.saveProfile, mutates: true, run: (core, input) => saveProfile(core.ctx(), input) }
} satisfies Partial<CommandTable>

export { profileCommands }
