import { COMMAND_SCHEMAS } from '../commandSchemas'
import { readBoard } from '../repo/boardFiles'
import { importBoard, previewBoardImport } from '../services/boardImport'
import type { CommandTable } from './types'

const boardCommands = {
  /** Before initialization nothing was imported yet, and every role may read. */
  previewBoardImport: {
    mutates: false,
    beforeInit: true,
    run: (core) => previewBoardImport(core.isInitialized() ? core.ctx() : null, readBoard(core.repoRoot, core.fs))
  },
  importBoard: {
    schema: COMMAND_SCHEMAS.importBoard,
    mutates: true,
    run: (core, input) => importBoard(core.ctx(), readBoard(core.repoRoot, core.fs), input)
  }
} satisfies Partial<CommandTable>

export { boardCommands }
