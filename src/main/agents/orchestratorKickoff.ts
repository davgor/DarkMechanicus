/**
 * What Dark Mechanicus tells an agent it starts as a run's orchestrator: the title of its chat and
 * the first message in it. The message is plain text the person can read in the transcript. It is
 * built from ids, the epic's title and its branch only, never from anything that grants access (a
 * claim token is issued to the orchestrator by the server when it claims a ticket), and it goes
 * through the claim token mask in case a title or branch name carries one.
 */
import { LIMITS } from '../../core/schemas'
import { maskClaimTokens } from './claimTokenMask'

/** The MCP prompt that carries the orchestrator skill. */
export const ORCHESTRATOR_PROMPT = 'darkmechanicus-orchestrator'

export interface KickoffInput {
  epicId: string
  epicTitle: string
  /** The epic's integration branch; null while none is recorded. */
  branch: string | null
  /** The run the desktop queued for this agent to pick up. */
  runId: string
}

const TITLE_PREFIX = 'Orchestrator · '

/** One line: titles come from people (and from other agents' plans), so they cannot start a paragraph of their own. */
function oneLine(text: string): string {
  return maskClaimTokens(text.replace(/\s+/g, ' ').trim())
}

/** "Orchestrator · <epic title>", cut to the title limit. */
export function orchestratorTitle(epicTitle: string): string {
  return `${TITLE_PREFIX}${oneLine(epicTitle)}`.slice(0, LIMITS.title)
}

function branchLine(branch: string | null): string {
  return branch === null ? 'Branch: no branch is recorded for this epic yet' : `Branch: ${oneLine(branch)}`
}

/** The first message of an orchestrator chat. */
export function orchestratorKickoff(input: KickoffInput): string {
  const lines = [
    'Run this Dark Mechanicus epic as its orchestrator.',
    '',
    `Epic: ${oneLine(input.epicTitle)} (${input.epicId})`,
    branchLine(input.branch),
    `Run: ${input.runId}, queued from the desktop app`,
    '',
    '1. Call get_capabilities first and confirm your role is orchestrator.',
    `2. Load the ${ORCHESTRATOR_PROMPT} prompt (the orchestrator skill) and follow it for everything that comes next.`,
    `3. Call start_run for this epic. It picks up the queued run ${input.runId}; if it says a run is already active, carry on with that run.`,
    '4. Run the epic yourself, in this chat. Never do a ticket yourself: start a subagent as the worker for each one.',
    '5. Keep going until the sprint checkpoint, where a person approves in the desktop app.'
  ]
  return lines.join('\n')
}
