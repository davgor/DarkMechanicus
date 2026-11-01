/**
 * An epic workspace backend for Linear transfer tests: the sample epic with a saved plan and no run, a FakeChats
 * whose transfer reads the backend's transfer status (so a chat starts only once the transfer is queued, as in
 * main), and a signed-in Claude Code as the shell would pass it. Test support only.
 */
import type { TransferView } from '../../../../shared/domain/transfer'
import type { EpicDetailView } from '../../../../shared/domain/views'
import { FakeChats } from '../../__mocks__/fakeChats'
import { FakeBackend, scenario } from './fakeBackend'
import { fakeOrchestration, readyAgent, type FakeOrchestration } from './fakeOrchestration'
import { epicDetail, transferView } from './fixtures'

export const TRANSFER_PROMPT = 'Transfer the epic ep_1 to Linear. Start with start_transfer.'

export interface TransferSetup {
  backend: FakeBackend
  chats: FakeChats
  host: FakeOrchestration
}

export function transferSetup(patch: { epic?: EpicDetailView; transfer?: TransferView } = {}): TransferSetup {
  const epic = patch.epic ?? epicDetail()
  const backend = new FakeBackend(scenario({ epic, run: null, checkpoint: null, transfer: patch.transfer ?? transferView() }))
  const chats = new FakeChats()
  chats.transfer = {
    epicTitle: epic.title,
    get status() {
      return backend.state.transfer.status
    },
    prompt: TRANSFER_PROMPT
  }
  backend.chats = chats
  const { agent, status } = readyAgent('claude')
  return { backend, chats, host: fakeOrchestration({ agents: [agent], statuses: { claude: status } }) }
}
