import type { ChatRole } from '../../../shared/agents/chat'

/** The two roles a person starts an agent chat as: the Magos runs the epic, the Lexmechanic plans it. */
export type AgentRole = Extract<ChatRole, 'orchestrator' | 'planner'>

export interface AgentRoleInfo {
  role: AgentRole
  /** The root callsign the agent tree shows for this role (`rootCallsignOf` in shared/agents/callsign.ts). */
  name: 'Magos' | 'Lexmechanic'
  roleLine: string
  facts: readonly string[]
}

/** The role → card table, in picker order. */
export const AGENT_ROLES: readonly AgentRoleInfo[] = [
  {
    role: 'orchestrator',
    name: 'Magos',
    roleLine: 'Orchestrator',
    facts: [
      'Runs the epic’s sprints and summons Acolytes and Inquisitors',
      'Delivers each sprint to main',
      'Asks you only at checkpoints and real decisions'
    ]
  },
  {
    role: 'planner',
    name: 'Lexmechanic',
    roleLine: 'Planner',
    facts: ['Plans with you: questions, tickets, sprints', 'Saves plans when allowed', 'Never runs work']
  }
]
