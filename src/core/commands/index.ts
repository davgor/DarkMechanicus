import { authoringCommands } from './authoring'
import { boardCommands } from './board'
import { checkpointCommands } from './checkpoints'
import { commentCommands } from './comments'
import { executionCommands } from './execution'
import { profileCommands } from './profiles'
import { repositoryCommands } from './repository'
import type { CommandTable } from './types'

/** Every CommandApi method: input schema, mutation flag, and the service call it maps to. */
export const COMMANDS: CommandTable = {
  ...repositoryCommands,
  ...authoringCommands,
  ...boardCommands,
  ...profileCommands,
  ...executionCommands,
  ...checkpointCommands,
  ...commentCommands
}
