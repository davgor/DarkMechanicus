import { requireCapability } from '../authz'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import type { Ctx } from '../context'
import { filePaths, withKnowledgeContext } from '../knowledge/push'
import {
  approveKanbanCard,
  claimKanbanCard,
  expireKanbanLeasesOnRead,
  failKanbanCard,
  heartbeatKanbanCard,
  kickBackKanbanCard,
  launchKanbanCards,
  playKanbanCard,
  submitKanbanCard
} from '../services/kanban/attempts'
import {
  addKanbanMessage,
  createKanbanCard,
  getKanbanCard,
  getKanbanOpenCount,
  listKanbanCards,
  listKanbanMessages,
  updateKanbanCard
} from '../services/kanban/cards'
import { removeKanbanCardFiles } from '../repo/epicRemoval'
import { deleteKanbanCard } from '../services/kanban/deletion'
import type { CommandTable } from './types'

/** The board reads attempt states as stored, so overdue card leases are expired first, as run reads expire theirs. */
function swept(ctx: Ctx): Ctx {
  expireKanbanLeasesOnRead(ctx)
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
  getKanbanOpenCount: {
    mutates: false,
    run: (core) => getKanbanOpenCount(core.ctx())
  },
  getKanbanCard: {
    schema: COMMAND_SCHEMAS.getKanbanCard,
    mutates: false,
    run: (core, input) => getKanbanCard(swept(core.ctx()), input)
  },
  addKanbanMessage: {
    schema: COMMAND_SCHEMAS.addKanbanMessage,
    mutates: true,
    run: (core, input) => addKanbanMessage(core.ctx(), input)
  },
  listKanbanMessages: {
    schema: COMMAND_SCHEMAS.listKanbanMessages,
    mutates: false,
    run: (core, input) => listKanbanMessages(core.ctx(), input)
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
    run: (core, input) => {
      const packet = claimKanbanCard(core.ctx(), input)
      return withKnowledgeContext(core, packet, 'kanban.claimed', filePaths(packet.card.references))
    }
  },
  heartbeatKanbanCard: {
    schema: COMMAND_SCHEMAS.heartbeatKanbanCard,
    mutates: true,
    run: (core, input) => heartbeatKanbanCard(core.ctx(), input)
  },
  submitKanbanCard: {
    schema: COMMAND_SCHEMAS.submitKanbanCard,
    mutates: true,
    run: async (core, input) => {
      const ctx = core.ctx()
      requireCapability(ctx.session, 'kanban.report')
      const merge = input.evidence?.merge
      const git = merge?.branch === 'main' ? ctx.gitFor(null) : null
      const merged = git !== null && merge !== undefined && await git.isAncestor(merge.commit, 'refs/remotes/origin/main') === true
      return submitKanbanCard(ctx, input, merged, merged ? git.assertCurrent : undefined)
    }
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
