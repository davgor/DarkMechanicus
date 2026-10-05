/**
 * What Dark Mechanicus tells an agent it starts as a run's orchestrator: the title of its chat and
 * the first message in it. The message is plain text the person can read in the transcript. It is
 * built from ids, the epic's title and its branch only, never from anything that grants access (a
 * claim token is issued to the orchestrator by the server when it claims a ticket, and the
 * orchestrator hands it to the worker's subagent), and it goes through the claim token mask in case
 * a title or branch name carries one.
 *
 * A chat has no way to open an MCP prompt, so the message carries the orchestrator and worker
 * guidance itself, read from the same skill sources the MCP server serves as prompts. The run lines
 * and steps come first; the guidance follows in a marked section, so the transcript reads in order.
 */
import { LIMITS } from '../../core/schemas'
import { skillBody } from '../../mcp/skills'
import { maskClaimTokens } from './claimTokenMask'

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

/** Each worker's subagent runs in the orchestrator's own session, so it can report for itself. */
const HANDOFF =
  '4. Start each worker subagent with two things written into the message you give it: its whole execution packet (the attempt id and claim token that claim_ticket returned, with the ticket) and the worker guidance below. ' +
  'A worker subagent runs in your session and can call the same Dark Mechanicus tools you can, so it reports for itself: it heartbeats with a progress note every heartbeatIntervalSeconds and submits its own attempt (or fails it). ' +
  'Do not submit an attempt on its behalf; review what it submits and accept or reject it. ' +
  'The claim token is a secret: give it only to the worker doing that ticket, and never put it in a ticket, commit, comment, report or note. ' +
  'If a subagent ever cannot call them, give it the ticket content without the claim token and report for it, as the guidance says.'

const GUIDES_NOTE =
  'The two guides below are the same text as the darkmechanicus-orchestrator and darkmechanicus-worker MCP prompts. ' +
  'This chat has no way to open MCP prompts or skills, so where the guidance names one, use the text below. ' +
  'For the reviewer and the sprint reporter, work from the guidance and the tool descriptions.'

/** One guide, set off by a marker line so the person can see where it starts. */
function guide(heading: string, name: string): string[] {
  return [`=== ${heading} ===`, '', skillBody(name).trimEnd(), '']
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
    `2. Call start_run for this epic. It picks up the queued run ${input.runId}; if it says a run is already active, carry on with that run.`,
    '3. Run the epic yourself, in this chat, following the orchestrator guidance below. Never do a ticket yourself: start a subagent as the worker for each one.',
    HANDOFF,
    '5. Keep going until the sprint checkpoint, where a person approves in the desktop app.',
    '',
    GUIDES_NOTE,
    '',
    ...guide('Orchestrator guidance (for you)', 'orchestrator'),
    ...guide('Worker guidance (give all of it to each worker subagent, with its packet)', 'worker'),
    '=== End of guidance ==='
  ]
  return lines.join('\n')
}
