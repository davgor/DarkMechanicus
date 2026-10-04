/** Sprint retro fixtures for tests of reports and checkpoints. Not shipped. */
import type { SprintRetroInput } from '../shared/domain/retro'

/** The least a retro can say and still count as one: the gate asks for some entry, not for any particular one. */
export const SIMPLE_RETRO: SprintRetroInput = { wentWell: ['The sprint went to plan'] }
