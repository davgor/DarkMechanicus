/**
 * What Dark Mechanicus tells an agent it starts as a Kanban card's orchestrator when a person presses
 * Play: the title of its chat and the first message in it. Like `orchestratorKickoff`, the message is
 * plain text built from the card's id, key and title and the checked-out branch only, never from
 * anything that grants access: the claim token is issued when the orchestrator calls
 * `claim_kanban_card`, and it hands the token to its worker subagent. Every line goes through the claim
 * token mask in case a title or branch name carries one, and the orchestrator and worker guidance
 * follow in marked sections, since a chat has no way to open an MCP prompt.
 */
import { LIMITS } from '../../core/schemas'
import { skillBody } from '../../mcp/skills'
import { maskClaimTokens } from './claimTokenMask'

export interface KanbanKickoffInput {
  cardId: string
  /** The card's display key, such as `DM-42`. */
  key: string
  title: string
  /** The checkout's current branch, which a card works on directly; null when it cannot be read. */
  branch: string | null
}

const TITLE_PREFIX = 'Kanban · '

/** One line: titles come from people and agents, so they cannot start a paragraph (or a step) of their own. */
function oneLine(text: string): string {
  return maskClaimTokens(text.replace(/\s+/g, ' ').trim())
}

/** "Kanban · <KEY> <title>", cut to the title limit. */
export function kanbanTitle(key: string, title: string): string {
  return `${TITLE_PREFIX}${oneLine(key)} ${oneLine(title)}`.slice(0, LIMITS.title)
}

const GUIDES_NOTE =
  'The two guides below are the same text as the darkmechanicus-orchestrator and darkmechanicus-worker MCP prompts. ' +
  'They are written for epics and runs; for this card, use claim_kanban_card, heartbeat_kanban_card, submit_kanban_card and fail_kanban_card where they name the ticket tools, and where they differ from the steps above (who submits, which branch), follow the steps. ' +
  'This chat has no way to open MCP prompts or skills, so where the guidance names one, use the text below.'

/** One guide, set off by a marker line so the person can see where it starts. */
function guide(heading: string, name: string): string[] {
  return [`=== ${heading} ===`, '', skillBody(name).trimEnd(), '']
}

/** The first message of a Kanban card's orchestrator chat. */
export function kanbanKickoff(input: KanbanKickoffInput): string {
  const cardId = oneLine(input.cardId)
  const card = `${oneLine(input.key)} ${oneLine(input.title)}`
  const lines = [
    'Carry this Dark Mechanicus Kanban card to Ready for review as its orchestrator. A person pressed Play in the desktop app.',
    '',
    `Card: ${card} (${cardId})`,
    input.branch === null ? 'Branch: the checked-out branch could not be read; cards work on whatever branch is checked out' : `Branch: ${oneLine(input.branch)}`,
    '',
    '1. Call get_capabilities first and confirm your role is orchestrator.',
    `2. Call claim_kanban_card with cardId ${cardId}. It returns the card's packet: its content, the branch, every earlier kick-back comment and a claim token.`,
    '3. Start one worker subagent with three things written into the message you give it: the whole packet, the worker guidance below, and this rule: do not call submit_kanban_card or fail_kanban_card, report back to the orchestrator instead. ' +
      'The claim token is a secret: give it only to the worker, and never put it in a commit, comment, report or note.',
    `4. The worker works on the checked-out branch, commits there, calls heartbeat_kanban_card with a progress note every heartbeatIntervalSeconds, and reports back to you. It does not submit the card.`,
    '5. Review what the worker reports against the acceptance criteria of the card and the Definition of Done in the packet. Send it back to the worker until it meets them. ' +
      'Keep calling heartbeat_kanban_card yourself while you review, until you submit, so the claim does not expire.',
    '6. Call submit_kanban_card with the outputs (summary, commits, changed files, branch) and evidence for each acceptance criterion. If the card cannot be done, call fail_kanban_card with the reason instead.',
    '7. Stop. A person approves or kicks back the card in the desktop app.',
    `8. If a message later says ${oneLine(input.key)} was kicked back, call claim_kanban_card again and carry the card once more, addressing every comment.`,
    '',
    GUIDES_NOTE,
    '',
    ...guide('Orchestrator guidance (for you)', 'orchestrator'),
    ...guide('Worker guidance (give all of it to the worker subagent, with its packet)', 'worker'),
    '=== End of guidance ==='
  ]
  return maskClaimTokens(lines.join('\n'))
}
