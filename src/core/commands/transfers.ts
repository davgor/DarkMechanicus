import { COMMAND_SCHEMAS } from '../commandSchemas'
import {
  cancelTransfer,
  getTransfer,
  queueTransfer,
  recordTransferItem,
  startTransfer,
  submitTransferReadback
} from '../services/transfers'
import type { CommandTable } from './types'

const transferCommands = {
  queueTransfer: {
    schema: COMMAND_SCHEMAS.queueTransfer,
    mutates: true,
    run: (core, input) => queueTransfer(core.ctx(), input)
  },
  cancelTransfer: {
    schema: COMMAND_SCHEMAS.cancelTransfer,
    mutates: true,
    run: (core, input) => cancelTransfer(core.ctx(), input)
  },
  startTransfer: {
    schema: COMMAND_SCHEMAS.startTransfer,
    mutates: true,
    run: (core, input) => startTransfer(core.ctx(), input)
  },
  recordTransferItem: {
    schema: COMMAND_SCHEMAS.recordTransferItem,
    mutates: true,
    run: (core, input) => recordTransferItem(core.ctx(), input)
  },
  getTransfer: {
    schema: COMMAND_SCHEMAS.getTransfer,
    mutates: false,
    run: (core, input) => getTransfer(core.ctx(), input)
  },
  submitTransferReadback: {
    schema: COMMAND_SCHEMAS.submitTransferReadback,
    mutates: true,
    // Called bare, never in a transaction: a final part ends the accumulation in a transaction of its own.
    run: (core, input) => submitTransferReadback(core.ctx(), input)
  }
} satisfies Partial<CommandTable>

export { transferCommands }
