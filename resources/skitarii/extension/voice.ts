/**
 * The Skitarii voice: the working messages OMP shows beside its loader while a turn runs (`ctx.ui.setWorkingMessage`).
 * A fixed list, in this one file. `THINKING_LINES` play while the model streams, `TOOL_LINES` while a tool runs.
 */

export const THINKING_LINES: readonly string[] = [
  'Communing with the machine spirit',
  'Reciting the litany of compilation',
  'Consulting the noosphere',
  'Petitioning the Omnissiah',
  'Parsing the sacred schematics',
  'Chanting the binaric hymn'
]

export const TOOL_LINES: readonly string[] = [
  'Applying the sacred unguents',
  'Anointing the cogitator',
  'Striking the rune of activation',
  'Burning the purity incense',
  'Tightening the holy bolts'
]

/** The line under SKITARII in the banner. */
export const BANNER_LINE = 'The Omnissiah guides this forge'
