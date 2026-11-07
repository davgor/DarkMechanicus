import { COMMAND_SCHEMAS } from '../commandSchemas'
import type { Ctx } from '../context'
import {
  approveKanbanCard,
  claimKanbanCard,
  expireKanbanLeases,
  failKanbanCard,
  heartbeatKanbanCard,
  kickBackKanbanCard,
  launchKanbanCards,
  playKanbanCard,
  submitKanbanCard
} from '../services/kanban/attempts'
import { createKanbanCard, getKanbanCard, listKanbanCards, updateKanbanCard } from '../services/kanban/cards'
import { removeKanbanCardFiles } from '../repo/epicRemoval'
import { deleteKanbanCard } from '../services/kanban/deletion'
import type { CommandTable } from './types'

/** The board reads attempt states as stored, so overdue card leases are expired first, as run reads expire theirs. */
function swept(ctx: Ctx): Ctx {
  expireKanbanLeases(ctx)
  return ctx
}

const kanbanCommands = {
  createKanbanCard: {
    schema: COMMAND_SCHEMAS.createKanbanCard,
    mutates: true,
    run: (core, input) => createKanbanCard(core.ctx(), input)
  },
  updateKanbanCard: {
    schema: COMMAND_SCHEMAS.updateKanbanCard,
    mutates: true,
    run: (core, input) => updateKanbanCard(core.ctx(), input)
  },
  listKanbanCards: {
    schema: COMMAND_SCHEMAS.listKanbanCards,
    mutates: false,
    run: (core, input) => listKanbanCards(swept(core.ctx()), input)
  },
  getKanbanCard: {
    schema: COMMAND_SCHEMAS.getKanbanCard,
    mutates: false,
    run: (core, input) => getKanbanCard(swept(core.ctx()), input)
  },
  playKanbanCard: {
    schema: COMMAND_SCHEMAS.playKanbanCard,
    mutates: true,
    run: (core, input) => playKanbanCard(core.ctx(), input)
  },
  launchKanbanCards: {
    schema: COMMAND_SCHEMAS.launchKanbanCards,
    mutates: true,
    run: (core, input) => launchKanbanCards(core.ctx(), input)
  },
  claimKanbanCard: {
    schema: COMMAND_SCHEMAS.claimKanbanCard,
    mutates: true,
    run: (core, input) => claimKanbanCard(core.ctx(), input)
  },
  heartbeatKanbanCard: {
    schema: COMMAND_SCHEMAS.heartbeatKanbanCard,
    mutates: true,
    run: (core, input) => heartbeatKanbanCard(core.ctx(), input)
  },
  submitKanbanCard: {
    schema: COMMAND_SCHEMAS.submitKanbanCard,
    mutates: true,
    run: (core, input) => submitKanbanCard(core.ctx(), input)
  },
  failKanbanCard: {
    schema: COMMAND_SCHEMAS.failKanbanCard,
    mutates: true,
    run: (core, input) => failKanbanCard(core.ctx(), input)
  },
  approveKanbanCard: {
    schema: COMMAND_SCHEMAS.approveKanbanCard,
    mutates: true,
    run: (core, input) => approveKanbanCard(core.ctx(), input)
  },
  kickBackKanbanCard: {
    schema: COMMAND_SCHEMAS.kickBackKanbanCard,
    mutates: true,
    run: (core, input) => kickBackKanbanCard(core.ctx(), input)
  },
  deleteKanbanCard: {
    schema: COMMAND_SCHEMAS.deleteKanbanCard,
    mutates: true,
    run: (core, input) =>
      deleteKanbanCard(core.ctx(), input, (cardId) => removeKanbanCardFiles({ layout: core.layout, fs: core.fs }, cardId))
  }
} satisfies Partial<CommandTable>

export { kanbanCommands }
