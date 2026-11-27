import { agentMailCommands } from './agentMail'
import { questionCommands } from './questions'
import { chatNamingCommands } from './chatNaming'
import { browserCommands } from './browser'
import { activityCommands } from './activity'
import { attachmentCommands } from './attachments'
import { authoringCommands } from './authoring'
import { boardCommands } from './board'
import { checkpointCommands } from './checkpoints'
import { commentCommands } from './comments'
import { deletionCommands } from './deletion'
import { executionCommands } from './execution'
import { kanbanCommands } from './kanban'
import { knowledgeCommands } from './knowledge'
import { learningCommands } from './learnings'
import { metricCommands } from './metrics'
import { profileCommands } from './profiles'
import { repositoryCommands } from './repository'
import { scoreCommands } from './scores'
import { transferCommands } from './transfers'
import type { CommandTable } from './types'

/** Every CommandApi method: input schema, mutation flag, and the service call it maps to. */
export const COMMANDS: CommandTable = {
  ...questionCommands,
  ...chatNamingCommands,
  ...browserCommands,
  ...repositoryCommands,
  ...authoringCommands,
  ...boardCommands,
  ...profileCommands,
  ...executionCommands,
  ...metricCommands,
  ...scoreCommands,
  ...checkpointCommands,
  ...commentCommands,
  ...attachmentCommands,
  ...kanbanCommands,
  ...activityCommands,
  ...knowledgeCommands,
  ...learningCommands,
  ...deletionCommands,
  ...transferCommands,
  ...agentMailCommands
}
