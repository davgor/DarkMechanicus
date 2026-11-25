/**
 * Start planner on an epic with no agents: a `planner` chat bound to the epic (`epicId`), with Allow save on, started
 * on its surface with a kickoff that names the epic and points at the planner guide. It mirrors `startTransferChat`:
 *
 *   - The epic cannot be read (an unknown epic): nothing was created, and the error is the answer.
 *   - No connected agent is signed in (`pickChatAgent` returns null): refused with `no_agent`, nothing created.
 *   - The chat cannot be created: no chat exists, and the answer says so.
 *   - The chat exists but its agent does not start: the chat is removed again and the answer says why; if it cannot
 *     be removed it is kept and returned, with the reason.
 */
import { DomainError } from '../../core/errors'
import { LIMITS } from '../../core/schemas'
import type { ChatRecord } from '../../shared/agents/chat'
import type { StartPlannerRequest, StartPlannerResult } from '../../shared/agents/chatApi'
import { pickChatAgent } from '../../shared/agents/pickChatAgent'
import type { AgentAuthStatus, AgentId, AgentView } from '../../shared/desktop/api'
import type { EpicDetailView } from '../../shared/domain/views'
import type { AgentChatSessions } from '../agentChat/agentChatSessions'
import type { TerminalSessions } from '../terminals/terminalSessions'
import { startChatOnSurface } from './chatSurfaceStart'
import type { ChatRecords } from './chatRecords'
import { maskClaimTokens } from './claimTokenMask'

/** The connected agents and their main-side sign-in state, which `pickChatAgent` chooses from. */
export interface PlannerAgents {
  list(): readonly AgentView[]
  checkAuth(agent: AgentView): Promise<AgentAuthStatus>
}

interface PlannerStartDeps {
  epics: { getEpic(folder: string, epicId: string): Promise<EpicDetailView> }
  agents: PlannerAgents
  chats: Pick<ChatRecords, 'createChat' | 'deleteChat' | 'agentName'>
  terminals: Pick<TerminalSessions, 'start'>
  agentChats: Pick<AgentChatSessions, 'start'>
  onError?: (error: unknown) => void
}

const START_AGAIN = 'Start the planner again.'

function oneLine(text: string): string {
  return maskClaimTokens(text.replace(/\s+/g, ' ').trim())
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, '')
}

/** The planner chat's first input: the epic, and where its guidance is. */
function plannerKickoff(epic: Pick<EpicDetailView, 'id' | 'title'>): string {
  return [
    'Plan this Dark Mechanicus epic with the person, following the planner guide: the darkmechanicus-planner MCP prompt (skills/planner.md in the Dark Mechanicus source).',
    '',
    `Epic: ${oneLine(epic.title)} (${epic.id})`,
    '',
    'First step: run get_capabilities with your dm command line, exactly as your instructions give it, and confirm your role is planner with Allow save on, then read this epic and ask the person about its goals before drafting tickets.'
  ].join('\n')
}

async function signedInAgent(agents: PlannerAgents): Promise<AgentId> {
  const connected = agents.list()
  const states = await Promise.all(connected.map(async (agent) => [agent.id, await agents.checkAuth(agent)] as const))
  const picked = pickChatAgent(connected, Object.fromEntries(states))
  if (picked === null) throw new DomainError('no_agent', 'No connected agent is signed in. Sign in to one in Agents, then start the planner again.')
  return picked.agentId
}

async function removeChat(deps: PlannerStartDeps, chat: ChatRecord): Promise<boolean> {
  try {
    await deps.chats.deleteChat(chat)
    return true
  } catch (error) {
    deps.onError?.(error)
    return false
  }
}

/** `request.folder` is the canonical path of a tracked folder. */
export async function startPlannerChat(deps: PlannerStartDeps, request: StartPlannerRequest): Promise<StartPlannerResult> {
  const { folder } = request
  const epic = await deps.epics.getEpic(folder, request.epicId)
  const agent = await signedInAgent(deps.agents)

  let chat: ChatRecord
  try {
    chat = await deps.chats.createChat({
      folder, agent, role: 'planner', model: null, allowSave: true, title: `Planner · ${oneLine(epic.title)}`.slice(0, LIMITS.title), epicId: epic.id
    })
  } catch (error) {
    if (!(error instanceof DomainError)) deps.onError?.(error)
    return { chat: null, problem: `The planner chat could not be created: ${reasonOf(error)}. ${START_AGAIN}` }
  }

  const failure = await startChatOnSurface(deps, chat, plannerKickoff(epic))
  if (failure !== null) {
    const removed = await removeChat(deps, chat)
    return { chat: removed ? null : chat, problem: `${deps.chats.agentName(agent)} could not be started: ${reasonOf(failure)}. ${START_AGAIN}` }
  }
  return { chat, problem: null }
}
